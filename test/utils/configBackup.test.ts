/**
 * config 自动备份 / 回滚 单测：backupConfig / listConfigBackups / rollbackConfig / saveRawConfig 写盘备份。
 *
 * 用临时 CHERY_DIR 隔离，避免污染真实 .chery/。备份目录 .chery/backups/ 随临时目录自动清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  backupConfig,
  listConfigBackups,
  rollbackConfig,
  saveRawConfig,
} from '@/utils/config.js'

let tempCheryDir: string

/** 写入 .chery/config.yaml（最小合法配置：llm.brain 一颗 + 合法 supervision）。 */
function setupConfigYaml(content: string): string {
  const cheryDir = join(tempCheryDir, '.chery')
  mkdirSync(cheryDir, { recursive: true })
  const configPath = join(cheryDir, 'config.yaml')
  writeFileSync(configPath, content)
  return configPath
}

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

function validConfigRaw(): Record<string, unknown> {
  return {
    global: { supervision: 'smart' },
    llm: { brain: { 'brain-a': { provider: 'mock', model: 'mock_test' } } },
  }
}

describe('config 自动备份回滚', () => {
  beforeEach(() => {
    tempCheryDir = mkdtempSync(join(tmpdir(), 'cheryNyxus-config-backup-test-'))
    process.env.CHERY_DIR = tempCheryDir
  })

  afterEach(() => {
    rmSync(tempCheryDir, { recursive: true, force: true })
    delete process.env.CHERY_DIR
  })

  it('backupConfig 生成 config-<时间戳>.yaml 备份，且不改动原文件', () => {
    const configPath = setupConfigYaml(minimalConfigYaml())
    const dest = backupConfig(configPath)
    expect(existsSync(dest)).toBe(true)
    expect(/config-\d{8}-\d{6}\.yaml$/.test(dest)).toBe(true)
    expect(dest).toContain(join('.chery', 'backups'))
    expect(readFileSync(dest, 'utf8')).toBe(minimalConfigYaml())
  })

  it('backupConfig 只保留最近 BACKUP_KEEP(10) 份，超出删最旧', () => {
    const configPath = setupConfigYaml(minimalConfigYaml())
    const backupsDir = join(tempCheryDir, '.chery', 'backups')
    mkdirSync(backupsDir, { recursive: true })
    // 预置 11 份定宽命名备份（字典序 = 时间序），模拟历史备份
    for (let i = 0; i < 11; i++) {
      const stamp = `20260820-${String(i).padStart(6, '0')}`
      writeFileSync(join(backupsDir, `config-${stamp}.yaml`), `# backup ${i}`)
    }
    backupConfig(configPath)
    const remaining = listConfigBackups()
    expect(remaining).toHaveLength(10)
    expect(remaining).not.toContain('config-20260820-000000.yaml') // 最旧被清理
  })

  it('listConfigBackups 按时间倒序（最近在前）', () => {
    const backupsDir = join(tempCheryDir, '.chery', 'backups')
    mkdirSync(backupsDir, { recursive: true })
    writeFileSync(join(backupsDir, 'config-20260820-010000.yaml'), '# a')
    writeFileSync(join(backupsDir, 'config-20260820-020000.yaml'), '# b')
    const list = listConfigBackups()
    expect(list).toEqual(['config-20260820-020000.yaml', 'config-20260820-010000.yaml'])
  })

  it('listConfigBackups 备份目录不存在返回空数组（graceful）', () => {
    expect(listConfigBackups()).toEqual([])
  })

  it('rollbackConfig 缺省恢复最近一份备份', () => {
    setupConfigYaml(minimalConfigYaml())
    const backupsDir = join(tempCheryDir, '.chery', 'backups')
    mkdirSync(backupsDir, { recursive: true })
    writeFileSync(join(backupsDir, 'config-20260820-010000.yaml'), '# older')
    writeFileSync(join(backupsDir, 'config-20260820-020000.yaml'), '# newer')
    const { backup } = rollbackConfig()
    expect(backup).toBe('config-20260820-020000.yaml')
    expect(readFileSync(join(tempCheryDir, '.chery', 'config.yaml'), 'utf8')).toBe('# newer')
  })

  it('rollbackConfig 指定 backup 文件名恢复', () => {
    setupConfigYaml(minimalConfigYaml())
    const backupsDir = join(tempCheryDir, '.chery', 'backups')
    mkdirSync(backupsDir, { recursive: true })
    writeFileSync(join(backupsDir, 'config-20260820-010000.yaml'), '# older')
    writeFileSync(join(backupsDir, 'config-20260820-020000.yaml'), '# newer')
    const { backup } = rollbackConfig('config-20260820-010000.yaml')
    expect(backup).toBe('config-20260820-010000.yaml')
    expect(readFileSync(join(tempCheryDir, '.chery', 'config.yaml'), 'utf8')).toBe('# older')
  })

  it('rollbackConfig 遇到格式错误的密钥占位符 → 拒绝恢复且保留当前配置', () => {
    const configPath = setupConfigYaml(minimalConfigYaml())
    const original = readFileSync(configPath, 'utf8')
    const backupsDir = join(tempCheryDir, '.chery', 'backups')
    mkdirSync(backupsDir, { recursive: true })
    writeFileSync(
      join(backupsDir, 'config-20260820-020000.yaml'),
      'global:\n  supervision: smart\nllm:\n  brain:\n    brain-a:\n      provider: mock\n      model: mock_test\n      key: $APq_KEY\n',
    )

    expect(() => rollbackConfig()).toThrow(/环境变量占位符格式错误/)
    expect(readFileSync(configPath, 'utf8')).toBe(original)
  })

  it('rollbackConfig 备份目录不存在时自愈创建并报"尚无可用备份"（不再报误导性的目录不存在）', () => {
    setupConfigYaml(minimalConfigYaml())
    expect(() => rollbackConfig()).toThrow(/备份目录为空|尚无可用备份/)
    // 自愈：目录被创建（幂等，不抛"目录不存在"）
    expect(existsSync(join(tempCheryDir, '.chery', 'backups'))).toBe(true)
    expect(listConfigBackups()).toEqual([])
  })

  it('saveRawConfig 成功写盘前自动备份旧配置', () => {
    const configPath = setupConfigYaml(minimalConfigYaml())
    const result = saveRawConfig(validConfigRaw())
    expect(result).toEqual({ ok: true })
    // 备份目录产生一份旧配置快照
    expect(listConfigBackups()).toHaveLength(1)
    expect(readFileSync(configPath, 'utf8')).toContain('brain-a')
  })

  it('saveRawConfig 校验失败时不落盘、不产生备份', () => {
    setupConfigYaml(minimalConfigYaml())
    const bad = {
      global: { supervision: 'bad-level' }, // 非法 supervision
      llm: { brain: { 'brain-a': { provider: 'mock', model: 'mock_test' } } },
    }
    const result = saveRawConfig(bad)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('supervision')
    }
    expect(listConfigBackups()).toEqual([]) // 未写盘，无备份
    expect(readFileSync(join(tempCheryDir, '.chery', 'config.yaml'), 'utf8')).toBe(
      minimalConfigYaml(),
    )
  })
})
