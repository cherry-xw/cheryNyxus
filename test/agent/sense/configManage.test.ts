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
import { listConfigBackups } from '@/utils/config.js'

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
    expect(r.content).toContain('save')
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
    expect(r.content).toContain('（无）')
  })

  it('action="save" 写盘前自动备份旧配置', async () => {
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
    expect(r.content).toContain('已保存')
    expect(listConfigBackups()).toHaveLength(1)
  })

  it('action="rollback" 无备份时返回可行动报错（自愈创建目录，不抛异常）', async () => {
    const r = await exec({ action: 'rollback' } as never, sharedData)
    expect(r.content).toContain('回滚失败')
    expect(r.content).toContain('尚无可用备份')
    expect(r.content).toContain('action="save"')
    expect(existsSync(join(tempCheryDir, '.chery', 'backups'))).toBe(true)
  })

  it('action="rollback" 有备份时恢复最近一份', async () => {
    // 先 save 产生备份，再改动配置，最后 rollback 恢复
    await exec(
      {
        action: 'save',
        config: {
          global: { supervision: 'smart' },
          llm: { brain: { 'brain-a': { provider: 'mock', model: 'mock_test' } } },
        },
      } as never,
      sharedData,
    )
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
