import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureEnvSeed, syncCheryTemplate } from './lib/chery-template-sync.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..')

/**
 * `pnpm install` 后初始化或升级开发 workspace：
 * - `.env` 只在缺失时由 `.env.example` 创建，已有值永不覆盖。
 * - `.chery.template` 通过受管哈希同步到 `.chery`；只升级仍为官方原版的文件，
 *   用户修改和主动删除都会保留，结构化配置仅迁移缺失的内置资源。
 */
try {
  const env = ensureEnvSeed({ envExamplePath: resolve(root, '.env.example'), runtimeRoot: root })
  if (env.warning) console.warn(`[setup] ${env.warning}`)
  else console.log(`[setup] .env ${env.created ? 'created' : 'already exists, preserved'}`)

  const report = syncCheryTemplate({
    templateDir: resolve(root, '.chery.template'),
    runtimeRoot: root,
  })
  for (const warning of report.warnings) console.warn(`[setup] ${warning}`)
  console.log(
    `[setup] .chery sync: created=${report.created} copied=${report.copied.length} updated=${report.updated.length} preserved=${report.preserved.length} configMigrated=${report.configMigrated}`,
  )
} catch (error) {
  console.error(`[setup] workspace initialization failed: ${error?.message ?? error}`)
  process.exitCode = 1
}
