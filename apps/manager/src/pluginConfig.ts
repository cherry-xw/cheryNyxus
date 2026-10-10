import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import yaml from 'js-yaml'
export async function readConnectionCredentials(file: string): Promise<Record<string, string>> {
  let raw: unknown
  try { raw = yaml.load(await readFile(file, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  const value = (raw as { manager?: { connectionCredentials?: unknown } } | null)?.manager?.connectionCredentials
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manager.connectionCredentials 无效')
  const result: Record<string, string> = {}
  for (const [id, path] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || typeof path !== 'string' || !isAbsolute(path))
      throw new Error('manager.connectionCredentials 必须使用模块 ID 和绝对路径')
    result[id] = path
  }
  return result
}
export async function readManagerPlugins(file: string): Promise<{ packageSourceRoot?: string }> {
  let raw: unknown
  try {
    raw = yaml.load(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const root = object(object(object(raw).manager).plugins).packageSourceRoot
  if (root === undefined) return {}
  if (typeof root !== 'string' || !isAbsolute(root))
    throw new Error('manager.plugins.packageSourceRoot 必须为绝对路径')
  return { packageSourceRoot: root }
}
