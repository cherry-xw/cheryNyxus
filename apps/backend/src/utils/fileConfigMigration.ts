import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'
import fs from 'node:fs'

export interface FileConfigMigrationWarning {
  path: string
  code: 'legacy_generate_removed' | 'legacy_file_declaration_removed' | 'image_context_separated' | 'image_tools_added'
  message: string
  /** 只供人工补配置，不参与运行；不包含连接或凭据。 */
  candidate?: Record<string, unknown>
}

/** 不改变输入，不把旧工具能力误认为模型原生输出，也不创建可执行服务。 */
export function migrateLegacyFileConfig<T>(raw: T): {
  config: T; changed: boolean; warnings: FileConfigMigrationWarning[]
} {
  const warnings: FileConfigMigrationWarning[] = []
  function visit(value: unknown, path: string[]): unknown {
    if (Array.isArray(value)) {
      const result = value.map((item, index) => visit(item, [...path, String(index)]))
      if (path.length === 2 && path[0] === 'sense_groups' && value.some(item => typeof item === 'string' && item.trim().split(':')[0]?.trim() === 'file_asset_read')) {
        const read = value.find(item => typeof item === 'string' && item.trim().split(':')[0]?.trim() === 'file_asset_read') as string
        const supervision = read.includes(':') ? `:${read.split(':').slice(1).join(':').trim()}` : ''
        for (const name of ['file_images_find', 'file_image_read']) if (!value.some(item => typeof item === 'string' && item.trim().split(':')[0]?.trim() === name)) {
          result.push(`${name}${supervision}`)
          warnings.push({ path: path.join('.'), code: 'image_tools_added', message: `文件工具组已加入 ${name}；沿用角色权限和工具审批，不读取图片。` })
        }
      }
      return result
    }
    if (!value || typeof value !== 'object') return value
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return value
    const source = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    if (path.length === 1 && path[0] === 'files' && !Object.hasOwn(source, 'imageContext')) {
      const turns = (source.context as { recentUserTurns?: unknown } | undefined)?.recentUserTurns
      if (typeof turns === 'number' && Number.isSafeInteger(turns) && turns >= 0) {
        result.imageContext = { mode: turns <= 1 ? 'current' : 'recent', recentUserTurns: Math.max(1, turns), replacement: 'description', missingDescription: 'existing' }
        warnings.push({ path: 'files.imageContext', code: 'image_context_separated', message: '图片携带策略已独立；其他文件沿用原轮数，图片只使用 imageContext。' })
      }
    }
    const capabilities = path.at(-1) === 'capabilities'
    const declaration = capabilities ||
      (path.length === 2 && ['senses', 'tools', 'mcp_servers'].includes(path[0]!))
    const candidate: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(source)) {
      if (capabilities && key === 'generate') {
        warnings.push({ path: [...path, key].join('.'), code: 'legacy_generate_removed',
          message: '已移除旧生成开关；它不能证明模型原生输出能力，请明确配置文件服务或原生输出。' })
      } else if (declaration && ['accepts', 'produces', 'preprocess', 'batchSize'].includes(key)) {
        candidate[key] = Array.isArray(item) ? item.filter((entry) => typeof entry === 'string')
          : typeof item === 'boolean' || typeof item === 'number' ? item : '(旧声明格式无法可靠转换)'
      } else Object.defineProperty(result, key, { value: visit(item, [...path, key]), enumerable: true, writable: true, configurable: true })
    }
    if (Object.keys(candidate).length) warnings.push({
      path: path.join('.'), code: 'legacy_file_declaration_removed', candidate,
      message: '已移除旧自动文件处理声明；候选类型不能直接执行，需补齐操作、输入映射和结果映射。普通工具配置与凭据保留。',
    })
    return result
  }
  const config = visit(raw, []) as T
  return { config, changed: warnings.length > 0, warnings }
}

/** 必须在加载配置、替换环境变量和采用新 schema 之前调用。失败由启动入口向上传递。 */
export async function migrateFileConfigOnDisk(configPath: string) {
  const original = await readFile(configPath, 'utf8')
  const result = migrateLegacyFileConfig(yaml.load(original))
  if (!result.changed) return result
  const backupDir = join(dirname(configPath), 'file-migration-backups')
  await mkdir(backupDir, { recursive: true, mode: 0o700 })
  await chmod(backupDir, 0o700)
  const backupPath = join(backupDir, `config-${randomUUID()}.yaml`)
  const backup = await open(backupPath, 'wx', 0o600)
  try { await backup.writeFile(original); await backup.sync() } finally { await backup.close() }
  const temporary = join(dirname(configPath), `.file-config-${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(yaml.dump(result.config, { lineWidth: -1, noRefs: true }))
      await file.sync()
    } finally { await file.close() }
    if (await readFile(configPath, 'utf8') !== original) throw new Error('配置在迁移期间发生变化，请重试')
    await rename(temporary, configPath)
    const directory = await open(dirname(configPath), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await unlink(temporary).catch(() => undefined) }
  return { ...result, backupPath }
}

/** 同步配置加载入口在环境替换前使用；有锁时停止，不与另一个写入者竞争。 */
export function migrateFileConfigOnDiskSync(configPath: string): void {
  const original = fs.readFileSync(configPath, 'utf8')
  const result = migrateLegacyFileConfig(yaml.load(original))
  if (!result.changed) return
  const lock = `${configPath}.file-migration.lock`
  const descriptor = fs.openSync(lock, 'wx', 0o600)
  const temporary = join(dirname(configPath), `.file-config-${randomUUID()}.tmp`)
  try {
    const directory = join(dirname(configPath), 'file-migration-backups')
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.chmodSync(directory, 0o700)
    fs.writeFileSync(join(directory, `config-${randomUUID()}.yaml`), original, { flag: 'wx', mode: 0o600 })
    fs.writeFileSync(join(directory, `report-${randomUUID()}.json`), JSON.stringify(result.warnings, null, 2), { flag: 'wx', mode: 0o600 })
    fs.writeFileSync(temporary, yaml.dump(result.config, { lineWidth: -1, noRefs: true }), { flag: 'wx', mode: 0o600 })
    if (fs.readFileSync(configPath, 'utf8') !== original) throw new Error('配置在迁移期间发生变化，请重试')
    fs.renameSync(temporary, configPath)
  } finally {
    fs.closeSync(descriptor)
    fs.unlinkSync(lock)
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}
