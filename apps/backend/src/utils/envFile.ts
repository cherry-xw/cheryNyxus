import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

export function resolveEnvFile(
  moduleUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  if (env.CHERY_ENV_FILE !== undefined) {
    if (!env.CHERY_ENV_FILE.trim()) throw new Error('CHERY_ENV_FILE must not be empty')
    return path.resolve(cwd, env.CHERY_ENV_FILE)
  }
  const directory = path.dirname(fileURLToPath(moduleUrl))
  return path.resolve(
    directory,
    path.basename(path.dirname(directory)) === 'src' ? '../..' : '..',
    '.env',
  )
}

export function loadEnvFile(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { excludedKeys?: ReadonlySet<string> } = {},
): void {
  if (!fs.existsSync(file)) return
  const values = dotenv.parse(fs.readFileSync(file, 'utf8'))
  for (const [key, value] of Object.entries(values)) {
    if (options.excludedKeys?.has(key)) continue
    if (env[key] === undefined) env[key] = value
  }
}

export function ensureSessionSecret(file: string, env: NodeJS.ProcessEnv = process.env): void {
  const key = 'CHERY_AUTH_SESSION_SECRET'
  if (env[key]) return
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const existing = dotenv.parse(content)[key]
  if (existing) {
    env[key] = existing
    return
  }
  const secret = randomBytes(32).toString('hex')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.appendFileSync(file, `\n${key}=${secret}\n`, { mode: 0o600 })
  env[key] = secret
}
