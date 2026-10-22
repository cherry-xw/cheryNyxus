import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { migrateFileConfigOnDisk, migrateLegacyFileConfig } from '@/utils/fileConfigMigration.js'

describe('旧文件配置一次性迁移', () => {
  it.each([0, 1, 3, 5])('图片轮数 %i 一次迁移，其他文件与凭据不变', turns => {
    const raw = { files: { context: { recentUserTurns: turns } }, secret: '$KEEP', sense_groups: { files: ['file_asset_read:manual'] } }
    const result = migrateLegacyFileConfig(raw)
    expect(result.config.files).toMatchObject({ context: { recentUserTurns: turns }, imageContext: { mode: turns <= 1 ? 'current' : 'recent', recentUserTurns: Math.max(1, turns), missingDescription: 'existing' } })
    expect(result.config.sense_groups.files).toEqual(['file_asset_read:manual', 'file_images_find:manual', 'file_image_read:manual'])
    expect(result.config.secret).toBe('$KEEP')
    expect(migrateLegacyFileConfig(result.config).changed).toBe(false)
    expect(raw.files).not.toHaveProperty('imageContext')
  })

  it('缺省使用运行默认，已迁移的策略不被旧字段覆盖', () => {
    expect(migrateLegacyFileConfig({ files: { context: {} } }).config.files).not.toHaveProperty('imageContext')
    const raw = { files: { context: { recentUserTurns: 9 }, imageContext: { mode: 'current' }, imageGeneration: { defaultCount: 1 } } }
    expect(migrateLegacyFileConfig(raw).config.files.imageContext.mode).toBe('current')
    expect(migrateLegacyFileConfig(raw).changed).toBe(false)
  })
  it('删除 generate，不虚构 output 或文件服务，保留凭据与其他设置', () => {
    const raw = {
      llm: { brain: { a: { key: '$API_KEY', model: 'manual', capabilities: {
        input: { image: 'supported' }, output: { audio: 'unknown' }, generate: { image: true }, toolCall: true,
      } } } },
      server: { auth: { secret: 'keep-secret' } }, unrelated: { generate: true, preprocess: 'keep' },
    }
    const before = JSON.stringify(raw)
    const result = migrateLegacyFileConfig(raw)
    expect(JSON.stringify(raw)).toBe(before)
    expect(result.changed).toBe(true)
    expect(result.config.llm.brain.a.capabilities).toEqual({ input: { image: 'supported' }, output: { audio: 'unknown' }, toolCall: true })
    expect(result.config.llm.brain.a.key).toBe('$API_KEY')
    expect(result.config.server).toEqual(raw.server)
    expect(result.config.unrelated).toEqual(raw.unrelated)
    expect(result.config).not.toHaveProperty('file_services')
    expect(JSON.stringify(result.warnings)).not.toContain('keep-secret')
    expect(migrateLegacyFileConfig(result.config)).toMatchObject({ changed: false, warnings: [] })
  })

  it('移除旧自动处理声明，候选只供补配置，普通工具继续保留', () => {
    const result = migrateLegacyFileConfig({
      files: { imageGeneration: { defaultCount: 1 } },
      tools: { inspect: { enabled: true, endpoint: 'https://example.test', capabilities: {
        accepts: ['image'], produces: ['text'], preprocess: true, batchSize: 2,
      } } },
      mcp_servers: { remote: { command: 'server', env: { TOKEN: 'credential' }, accepts: ['pdf'], preprocess: true } },
      roles: { writer: { brain: 'a', senseGroup: 'tools' } },
    })
    expect(result.config.tools.inspect).toEqual({ enabled: true, endpoint: 'https://example.test', capabilities: {} })
    expect(result.config.mcp_servers.remote).toEqual({ command: 'server', env: { TOKEN: 'credential' } })
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings[0]!.candidate).toEqual({ accepts: ['image'], produces: ['text'], preprocess: true, batchSize: 2 })
    expect(result.config.roles.writer).toEqual({ brain: 'a', senseGroup: 'tools' })
  })

  it('没有旧字段时不修改磁盘；迁移前备份原文并限制权限', async () => {
    const root = await mkdtemp('/tmp/opencode/file-config-migration-')
    try {
      const file = join(root, 'config.yaml')
      const original = '# preserve original backup\nllm:\n  brain:\n    a:\n      key: $API_KEY\n      capabilities:\n        generate:\n          image: true\nserver:\n  token: secret\n'
      await writeFile(file, original)
      const result = await migrateFileConfigOnDisk(file)
      expect(result.changed).toBe(true)
      expect(await readFile('backupPath' in result ? result.backupPath! : '', 'utf8')).toBe(original)
      const directory = join(root, 'file-migration-backups')
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat('backupPath' in result ? result.backupPath! : '')).mode & 0o777).toBe(0o600)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect(yaml.load(await readFile(file, 'utf8'))).toMatchObject({ llm: { brain: { a: { key: '$API_KEY', capabilities: {} } } }, server: { token: 'secret' } })
      const migrated = await readFile(file, 'utf8')
      expect((await migrateFileConfigOnDisk(file)).changed).toBe(false)
      expect(await readFile(file, 'utf8')).toBe(migrated)
      expect(await readdir(directory)).toHaveLength(1)
      expect((await readdir(root)).some((name) => name.endsWith('.tmp'))).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
