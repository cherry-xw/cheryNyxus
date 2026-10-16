import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

/** Backend and Manager keep their own entry points but share one runtime root. */
export function backendComponentRoot(moduleUrl) {
  let directory = path.dirname(fileURLToPath(moduleUrl))
  for (;;) {
    if (path.basename(directory) === 'backend') return directory
    if (path.basename(directory) === 'manager') return path.resolve(directory, '../backend')
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error('无法从入口定位 Backend 目录')
    directory = parent
  }
}

/** Load the selected environment before guardian/Manager read configuration. */
export function initializeBackendEnvironment(moduleUrl, env = process.env) {
  const componentRoot = backendComponentRoot(moduleUrl)
  if (env.CHERY_ENV_FILE !== undefined && !env.CHERY_ENV_FILE.trim()) throw new Error('CHERY_ENV_FILE must not be empty')
  const envFile = env.CHERY_ENV_FILE ? path.resolve(env.CHERY_ENV_FILE) : path.join(componentRoot, '.env')
  if (fs.existsSync(envFile)) {
    for (const [key, value] of Object.entries(dotenv.parse(fs.readFileSync(envFile, 'utf8')))) {
      if (/(?:PLATFORM_TOKEN|CONFIG_READY_REVISION|CONFIG_REVISION)$/.test(key)) continue
      if (env[key] === undefined) env[key] = value
    }
  }
  if (env.CHERY_DIR !== undefined && !env.CHERY_DIR.trim()) throw new Error('CHERY_DIR must not be empty')
  const runtimeRoot = env.CHERY_DIR ? path.resolve(path.dirname(envFile), env.CHERY_DIR) : componentRoot
  env.CHERY_DIR = runtimeRoot
  env.CHERY_ENV_FILE = envFile
  env.CHERY_TEMPLATE_DIR = env.CHERY_TEMPLATE_DIR ? path.resolve(env.CHERY_TEMPLATE_DIR) : path.join(componentRoot, '.chery.template')
  return { componentRoot, runtimeRoot, envFile, templateDir: env.CHERY_TEMPLATE_DIR }
}
