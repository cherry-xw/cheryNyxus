import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { writeYaml } from './credentials.js'
import { withConfigTransaction } from '../../backend/src/utils/configTransaction.js'
import type { OidcOptions } from './oidc.js'

export interface OidcConfigView {
  issuer: string
  clientId: string
  redirectUri: string
  adminSubjects: string[]
  clientSecretConfigured: boolean
  configured: boolean
}

const EMPTY: OidcConfigView = {
  issuer: '',
  clientId: '',
  redirectUri: '',
  adminSubjects: [],
  clientSecretConfigured: false,
  configured: false,
}

export class OidcConfigStore {
  constructor(private readonly configFile: string) {}

  async view(origin?: string): Promise<OidcConfigView> {
    const config = await this.readConfig()
    return viewOf(readOidc(config), origin)
  }

  async save(input: Record<string, unknown>, origin: string): Promise<OidcConfigView> {
    return withConfigTransaction(this.configFile, () => this.saveLocked(input, origin))
  }

  private async saveLocked(input: Record<string, unknown>, origin: string): Promise<OidcConfigView> {
    const config = await this.readConfig()
    const manager = record(config.manager)
    const auth = record(manager.auth)
    const previous = record(auth.oidc)
    const issuer = requiredString(input.issuer, 'issuer', 2048)
    const clientId = requiredString(input.clientId, 'clientId', 512)
    const redirectUri = requiredString(input.redirectUri, 'redirectUri', 2048)
    const clientSecretInput = input.clientSecret
    const clientSecret = clientSecretInput === undefined || clientSecretInput === ''
      ? stringValue(previous.clientSecret)
      : requiredString(clientSecretInput, 'clientSecret', 4096)
    const adminSubjects = readSubjects(input.adminSubjects)
    if (!clientSecret) throw new Error('clientSecret 必填；已有配置可留空保持不变')
    validateIssuer(issuer)
    validateRedirect(redirectUri, origin)
    if (!adminSubjects.length) throw new Error('adminSubjects 至少需要一个管理员 subject')

    const next = structuredClone(config)
    const nextManager = record(next.manager)
    const nextAuth = record(nextManager.auth)
    nextManager.auth = nextAuth
    nextAuth.oidc = { issuer, clientId, clientSecret, redirectUri, adminSubjects }
    next.manager = nextManager
    await writeYaml(this.configFile, next)
    return this.view(origin)
  }

  private async readConfig(): Promise<Record<string, unknown>> {
    try {
      const parsed = yaml.load(await readFile(this.configFile, 'utf8'))
      if (parsed !== undefined && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('Configuration root must be a mapping')
      return record(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error('Manager 配置不可读取')
    }
  }
}

function readOidc(config: Record<string, unknown>): OidcOptions | undefined {
  const manager = record(config.manager)
  const auth = record(manager.auth)
  const value = record(auth.oidc)
  if (!Object.keys(value).length) return undefined
  return {
    issuer: stringValue(value.issuer),
    clientId: stringValue(value.clientId),
    clientSecret: stringValue(value.clientSecret),
    redirectUri: stringValue(value.redirectUri),
    adminSubjects: Array.isArray(value.adminSubjects) ? value.adminSubjects.filter((item): item is string => typeof item === 'string') : [],
  }
}

function viewOf(options: OidcOptions | undefined, origin?: string): OidcConfigView {
  if (!options) return { ...EMPTY, adminSubjects: [] }
  const issuer = options.issuer
  const clientId = options.clientId
  const redirectUri = options.redirectUri
  const adminSubjects = [...options.adminSubjects]
  let configured = Boolean(issuer && clientId && options.clientSecret && redirectUri && adminSubjects.length)
  try {
    const issuerUrl = new URL(issuer)
    const redirect = new URL(redirectUri)
    configured = configured && !issuerUrl.search && redirect.pathname === '/api/auth/oidc/callback' && !redirect.search && (!origin || redirect.origin === origin)
  } catch { configured = false }
  return { issuer, clientId, redirectUri, adminSubjects, clientSecretConfigured: Boolean(options.clientSecret), configured }
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function stringValue(value: unknown): string { return typeof value === 'string' ? value : '' }
function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} 必须是非空字符串（最多 ${max} 个字符）`)
  return value.trim()
}
function validateIssuer(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) || url.username || url.password || url.hash || url.search) throw new Error('issuer 必须是安全的完整地址')
}
function validateRedirect(value: string, origin: string): void {
  const url = new URL(value)
  if (url.origin !== origin || url.pathname !== '/api/auth/oidc/callback' || url.search || url.hash || url.username || url.password) throw new Error('redirectUri 必须是当前可信地址的 /api/auth/oidc/callback')
}
function readSubjects(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('adminSubjects 必须是字符串数组')
  const subjects = value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)
  if (subjects.length !== value.length || subjects.some((item) => item.length > 512)) throw new Error('adminSubjects 包含无效值')
  return [...new Set(subjects)]
}
