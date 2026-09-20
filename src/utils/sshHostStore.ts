import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

type StoredHostKeys = Record<string, string>

function getFile(): string {
  return join(process.env.CHERY_DIR || process.cwd(), '.chery', '.secrets', 'ssh-host-keys.json')
}

function load(): StoredHostKeys {
  try {
    const file = getFile()
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([host, fingerprint]) => typeof host === 'string' && typeof fingerprint === 'string',
      ),
    )
  } catch {
    return {}
  }
}

function save(hostKeys: StoredHostKeys): void {
  const file = getFile()
  mkdirSync(dirname(file), { recursive: true })
  const temporary = file + '.tmp'
  writeFileSync(temporary, JSON.stringify(hostKeys, null, 2), { mode: 0o600 })
  renameSync(temporary, file)
  chmodSync(file, 0o600)
}

export function getTrustedSshHostKey(host: string, port: number): string | undefined {
  return load()[`${host}:${port}`]
}

export function trustSshHostKey(host: string, port: number, fingerprint: string): void {
  const hostKeys = load()
  hostKeys[`${host}:${port}`] = fingerprint
  save(hostKeys)
}
