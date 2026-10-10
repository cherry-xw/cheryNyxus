import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ConnectionCredentialState {
  token: string
  createdAt: string
  updatedAt: string
}

function valid(value: unknown): value is ConnectionCredentialState {
  return !!value && typeof value === 'object' &&
    typeof (value as ConnectionCredentialState).token === 'string' &&
    (value as ConnectionCredentialState).token.length >= 32 &&
    typeof (value as ConnectionCredentialState).createdAt === 'string' &&
    typeof (value as ConnectionCredentialState).updatedAt === 'string'
}

export function loadOrCreateConnectionCredential(file: string): ConnectionCredentialState {
  let state: unknown
  try {
    state = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return writeConnectionCredential(file)
    throw new Error('连接凭据文件不可读取')
  }
  if (!valid(state)) throw new Error('连接凭据文件无效；保留原件，请明确轮换')
  return state
}

export function rotateConnectionCredential(file: string): ConnectionCredentialState {
  return writeConnectionCredential(file)
}

function writeConnectionCredential(file: string): ConnectionCredentialState {
  const now = new Date().toISOString()
  const state = { token: randomBytes(32).toString('base64url'), createdAt: now, updatedAt: now }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(temporary, 0o600)
  renameSync(temporary, file)
  if (process.platform !== 'win32') chmodSync(file, 0o600)
  return state
}
