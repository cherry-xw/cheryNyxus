import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { writeYaml } from './credentials.js'

const FIELDS = ['issuer', 'authorizationUrl', 'tokenUrl', 'userInfoUrl', 'clientId', 'redirectUri', 'adminClaim'] as const
type Field = typeof FIELDS[number]
export type OidcConfigInput = Partial<Record<Field, string>> & {
  clientSecret?: string
  clearClientSecret?: boolean
  adminUsers?: string[]
  adminValues?: string[]
}

export class OidcConfigStore {
  constructor(private readonly configFile: string) {}

  async view() {
    const config = await this.readConfig()
    const server = asRecord(config.server)
    const auth = asRecord(server.auth)
    return {
      ...Object.fromEntries(FIELDS.map((field) => [field, typeof auth[field] === 'string' ? auth[field] : ''])),
      adminUsers: Array.isArray(auth.adminUsers) ? auth.adminUsers.filter((v): v is string => typeof v === 'string') : [],
      adminValues: Array.isArray(auth.adminValues) ? auth.adminValues.filter((v): v is string => typeof v === 'string') : [],
      hasClientSecret: Boolean(auth.clientSecret),
      passwordLoginActive: Boolean(auth.username),
    }
  }

  async save(input: Record<string, unknown>) {
    const next: OidcConfigInput = {}
    for (const field of FIELDS) {
      if (typeof input[field] !== 'string' || (input[field] as string).length > 2048)
        throw new Error(`${field} must be a string of at most 2048 characters`)
      next[field] = (input[field] as string).trim()
    }
    for (const field of ['adminUsers', 'adminValues'] as const) {
      const value = input[field]
      if (!Array.isArray(value) || value.length > 100 || !value.every((v) => typeof v === 'string' && v.trim() && v.length <= 256))
        throw new Error(`${field} must be a list of nonempty strings`)
      next[field] = value.map((v: string) => v.trim())
    }
    if (input.clientSecret !== undefined && (typeof input.clientSecret !== 'string' || input.clientSecret.length > 4096))
      throw new Error('clientSecret must be a string of at most 4096 characters')
    if (input.clearClientSecret !== undefined && typeof input.clearClientSecret !== 'boolean')
      throw new Error('clearClientSecret must be a boolean')
    if (input.clientSecret && input.clearClientSecret) throw new Error('Cannot set and clear clientSecret together')

    const config = await this.readConfig()
    const server = asRecord(config.server)
    const auth = asRecord(server.auth)
    const secret = input.clearClientSecret ? '' : (input.clientSecret as string | undefined)?.trim() || auth.clientSecret
    if (next.authorizationUrl || next.tokenUrl || next.userInfoUrl || next.clientId || next.redirectUri) {
      for (const field of ['authorizationUrl', 'tokenUrl', 'userInfoUrl', 'clientId', 'redirectUri'] as const) {
        if (!next[field]) throw new Error(`${field} is required for OIDC configuration`)
      }
      if (!next.adminUsers?.length && !next.adminClaim) throw new Error('Configure adminUsers or adminClaim')
      if (next.adminClaim && !next.adminValues?.length && !next.adminUsers?.length)
        throw new Error('adminValues is required when using adminClaim without adminUsers')
      for (const field of ['issuer', 'authorizationUrl', 'tokenUrl', 'userInfoUrl', 'redirectUri'] as const) {
        if (!next[field]) continue
        try {
          const url = new URL(next[field]!)
          if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('invalid protocol')
        } catch { throw new Error(`${field} must be an absolute HTTP(S) URL`) }
      }
    }
    for (const field of FIELDS) {
      if (next[field]) auth[field] = next[field]
      else delete auth[field]
    }
    auth.adminUsers = next.adminUsers
    auth.adminValues = next.adminValues
    if (secret) auth.clientSecret = secret
    else delete auth.clientSecret
    server.auth = auth
    config.server = server
    await writeYaml(this.configFile, config)
    return this.view()
  }

  private async readConfig(): Promise<Record<string, unknown>> {
    try {
      const parsed = yaml.load(await readFile(this.configFile, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid config.yaml')
      return parsed as Record<string, unknown>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
