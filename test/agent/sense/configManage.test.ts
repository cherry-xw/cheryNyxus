/**
 * config_manage sense 执行器单测。
 *
 * 回归点（历史任务 5e92d5a8 复现）：
 *  - 缺 action 的调用绝不静默兜底为 rollback（原 bug：args={} → doRollback → 误报"备份目录不存在"）
 *  - 缺 action 返回可行动的用法引导
 *  - get 正常读盘（不依赖备份目录）
 *  - save 写盘前自动备份
 *  - rollback 无备份时返回可行动报错（不抛异常、不报"目录不存在"）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import configManageSense from '@/agent/sense/configManage.js'
import { backupConfig, listConfigBackups, readRawConfig } from '@/utils/config.js'
import { getConfigBaseRevision } from '@/service/config/operations.js'

const exec = configManageSense.executor.execute.bind(configManageSense.executor)
const sharedData = new Map<string, Map<string, unknown>>()

let tempCheryDir: string

function minimalConfigYaml(): string {
  return `global:
  supervision: smart
llm:
  brain:
    brain-a:
      provider: mock
      model: mock_test
`
}

function setupConfigYaml(): void {
  const cheryDir = join(tempCheryDir, '.chery')
  mkdirSync(cheryDir, { recursive: true })
  writeFileSync(join(cheryDir, 'config.yaml'), minimalConfigYaml())
}

describe('config_manage sense 定义', () => {
  it('name = config_manage，supervision = smart', () => {
    expect(configManageSense.definition.function.name).toBe('config_manage')
    expect(configManageSense.supervisionLevel).toBeDefined()
  })

  it('tool JSON Schema 保留顶层 action 必填与嵌套资源真实类型', () => {
    const parameters = configManageSense.definition.function.parameters
    expect(parameters.required).toContain('action')
    const operations = JSON.stringify(parameters.properties.operations)
    expect(operations).toContain('"putBrain"')
    expect(operations).toContain('"rpm":{"type":"number"')
    expect(operations).toContain('"fullUrl":{"type":"boolean"')
    expect(operations).toContain('"senses":{"type":"array"')
  })
})

describe('config_manage 执行（缺 action 回归 / get / save / rollback）', () => {
  beforeEach(() => {
    tempCheryDir = mkdtempSync(join(tmpdir(), 'cheryNyxus-configmanage-test-'))
    process.env.CHERY_DIR = tempCheryDir
    setupConfigYaml()
    sharedData.clear()
  })

  afterEach(() => {
    rmSync(tempCheryDir, { recursive: true, force: true })
    delete process.env.CHERY_DIR
  })

  it('缺 action（args={}）→ 返回用法引导，绝不触发 rollback（回归历史 bug）', async () => {
    const r = await exec({} as never, sharedData)
    expect(r.content).toContain('action')
    expect(r.content).toContain('get')
    expect(r.content).toContain('patch')
    expect(r.content).toContain('rollback')
    // 不得出现 rollback 误触发的"备份"错误，也不得误生成备份目录
    expect(r.content).not.toContain('回滚失败')
    expect(r.content).not.toContain('备份目录')
    expect(existsSync(join(tempCheryDir, '.chery', 'backups'))).toBe(false)
  })

  it('action="get" 正常读盘，返回完整配置与回滚点（不依赖备份目录）', async () => {
    const r = await exec({ action: 'get' } as never, sharedData)
    expect(r.content).toContain('global')
    expect(r.content).toContain('brain-a')
    expect(r.content).toContain('回滚点')
    expect(r.content).toContain('baseRevision')
    expect(r.content).toContain('（无）')
  })

  it('旧 action="save" 被拒绝，并给出 patch 迁移指引', async () => {
    const r = await exec(
      {
        action: 'save',
        config: {
          global: { supervision: 'smart' },
          llm: { brain: { 'brain-a': { provider: 'mock', model: 'mock_test' } } },
          roles: {
            extra: { brain: 'brain-a', senseGroup: 'leader' },
          },
        },
      } as never,
      sharedData,
    )
    expect(r.content).toContain('已停用')
    expect(r.content).toContain('baseRevision')
    expect(r.content).toContain('patch')
    expect(listConfigBackups()).toHaveLength(0)
  })

  it('action="patch" 通过 revision 应用增量候选，写盘前自动备份', async () => {
    const baseRevision = getConfigBaseRevision(readRawConfig())
    const r = await exec(
      {
        action: 'patch',
        baseRevision,
        operations: [
          { op: 'putSenseGroup', name: 'leader', senses: ['read_file'] },
          {
            op: 'putBrain',
            name: 'brain-a',
            brain: { provider: 'mock', model: 'mock_test', fullUrl: true },
          },
        ],
      } as never,
      sharedData,
    )
    expect(r.content).toContain('候选已通过完整校验')
    expect(r.content).toContain('重启')
    expect(readRawConfig().sense_groups?.leader).toEqual(['read_file'])
    expect(listConfigBackups()).toHaveLength(1)
    const returnedRevision = r.content.match(/新 baseRevision (config-[a-f0-9]+)/)?.[1]
    expect(returnedRevision).toBe(getConfigBaseRevision(readRawConfig()))
  })

  it('过期 baseRevision 被拒绝且不落盘', async () => {
    const stale = getConfigBaseRevision(readRawConfig())
    writeFileSync(
      join(tempCheryDir, '.chery', 'config.yaml'),
      `${minimalConfigYaml()}sense_groups:\n  changed:\n    - read_file\n`,
    )
    const r = await exec(
      {
        action: 'patch',
        baseRevision: stale,
        operations: [{ op: 'putSenseGroup', name: 'leader', senses: ['write_file'] }],
      } as never,
      sharedData,
    )
    expect(r.content).toContain('已过期')
    expect(r.content).toContain('重新调用 action="get"')
    expect(readRawConfig().sense_groups?.leader).toBeUndefined()
    expect(listConfigBackups()).toHaveLength(0)
  })

  it('增量操作产生不可加载候选时在写盘前拒绝', async () => {
    const baseRevision = getConfigBaseRevision(readRawConfig())
    const r = await exec(
      {
        action: 'patch',
        baseRevision,
        operations: [{ op: 'removeBrain', name: 'brain-a' }],
      } as never,
      sharedData,
    )
    expect(r.content).toContain('候选被拒绝，未落盘')
    expect(r.content).toContain('llm.brain 不能为空')
    expect(readRawConfig().llm.brain['brain-a']).toBeDefined()
    expect(listConfigBackups()).toHaveLength(0)
  })

  it('action="rollback" 无备份时返回可行动报错（自愈创建目录，不抛异常）', async () => {
    const r = await exec({ action: 'rollback' } as never, sharedData)
    expect(r.content).toContain('回滚失败')
    expect(r.content).toContain('尚无可用备份')
    expect(r.content).toContain('action="patch"')
    expect(existsSync(join(tempCheryDir, '.chery', 'backups'))).toBe(true)
  })

  it('action="rollback" 有备份时恢复最近一份', async () => {
    const configPath = join(tempCheryDir, '.chery', 'config.yaml')
    backupConfig(configPath)
    writeFileSync(configPath, `${minimalConfigYaml()}sense_groups:\n  changed: []\n`)
    const r = await exec({ action: 'rollback' } as never, sharedData)
    expect(r.content).toContain('已从 .chery/backups/')
    expect(r.content).toContain('恢复')
  })

  it('asset_save 原子创建提示词，asset_archive 可恢复归档零引用资产', async () => {
    const saved = await exec(
      {
        action: 'asset_save',
        assetPath: 'prompt/new-role/system.md',
        content: '# New role\nbackground',
      } as never,
      sharedData,
    )
    const target = join(tempCheryDir, '.chery', 'prompt', 'new-role', 'system.md')
    expect(saved.content).toContain('已原子保存')
    expect(readFileSync(target, 'utf8')).toContain('New role')

    const archived = await exec(
      { action: 'asset_archive', assetPath: 'prompt/new-role/system.md' } as never,
      sharedData,
    )
    expect(archived.content).toContain('活动目录移出')
    expect(existsSync(target)).toBe(false)
    expect(existsSync(join(tempCheryDir, '.chery', 'backups', 'assets'))).toBe(true)
  })

  it('asset_save can replace an existing asset and preserves the old version', async () => {
    const target = join(tempCheryDir, '.chery', 'prompt', 'editable.md')
    mkdirSync(join(tempCheryDir, '.chery', 'prompt'), { recursive: true })
    writeFileSync(target, 'old content')

    const result = await exec(
      {
        action: 'asset_save',
        assetPath: 'prompt/editable.md',
        content: 'new content',
      } as never,
      sharedData,
    )

    expect(result.content).toContain('已原子保存')
    expect(readFileSync(target, 'utf8')).toBe('new content')
    const backupsRoot = join(tempCheryDir, '.chery', 'backups', 'assets')
    expect(existsSync(backupsRoot)).toBe(true)
  })

  it('asset_archive 严格拒绝仍被角色引用的提示词', async () => {
    const prompt = join(tempCheryDir, '.chery', 'prompt', 'used.md')
    mkdirSync(join(tempCheryDir, '.chery', 'prompt'), { recursive: true })
    writeFileSync(prompt, 'used')
    writeFileSync(
      join(tempCheryDir, '.chery', 'config.yaml'),
      `${minimalConfigYaml()}roles:\n  used-role:\n    brain: brain-a\n    senseGroup: leader\n    systemPrompt: prompt/used.md\n`,
    )

    const result = await exec(
      { action: 'asset_archive', assetPath: 'prompt/used.md' } as never,
      sharedData,
    )
    expect(result.content).toContain('仍被引用')
    expect(existsSync(prompt)).toBe(true)
  })
})
