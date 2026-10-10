import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import type { AuthOptions } from './auth.js'
import { oidcConfigured, safeEndpoint, type OidcOptions } from './oidc.js'
import { writeYaml } from './credentials.js'

export interface OidcConfigView {
  issuer: string
  clientId: string
  redirectUri: string
  adminSubjects: string[]
  clientSecretConfigured: boolean
  configured: boolean
}

export interface InitialSetupView {
  allowInitialSetup: boolean
}

export async function readAuthOptions(configFile: string): Promise<AuthOptions> {
  let text: string
  try { text = await readFile(configFile, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('Manager 配置不可读取')
  }
  const parsed = yaml.load(text) as { manager?: { auth?: unknown } } | undefined
  const auth = parsed?.manager?.auth
  if (auth === undefined) return {}
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('manager.auth 必须是对象')
  const value = auth as Record<string, unknown>
  for (const name of ['trustedOrigins', 'trustedProxies']) {
    if (value[name] !== undefined && (!Array.isArray(value[name]) || (value[name] as unknown[]).some((item) => typeof item !== 'string'))) {
      throw new Error(`manager.auth.${name} 必须是字符串数组`)
    }
  }
  if (value.sessionTtlMs !== undefined && typeof value.sessionTtlMs !== 'number') throw new Error('manager.auth.sessionTtlMs 必须是数值')
  if (value.oidc !== undefined && (!value.oidc || typeof value.oidc !== 'object' || Array.isArray(value.oidc))) throw new Error('manager.auth.oidc 必须是对象')
  return value as AuthOptions
}

export async function readInitialSetup(configFile: string): Promise<InitialSetupView> {
  const root = await readConfig(configFile)
  const manager = asRecord(root.manager)
  const auth = asRecord(manager.auth)
  return { allowInitialSetup: auth.allowInitialSetup !== false }
}

export async function disableInitialSetup(configFile: string): Promise<void> {
  const root = await readConfig(configFile)
  const manager = asRecord(root.manager)
  const auth = asRecord(manager.auth)
  auth.allowInitialSetup = false
  manager.auth = auth
  root.manager = manager
  await writeYaml(configFile, root)
}

export async function readOidcConfig(configFile: string): Promise<OidcConfigView> {
  const auth = await readAuthOptions(configFile)
  const oidc = auth.oidc
  return {
    issuer: typeof oidc?.issuer === 'string' ? oidc.issuer : '',
    clientId: typeof oidc?.clientId === 'string' ? oidc.clientId : '',
    redirectUri: typeof oidc?.redirectUri === 'string' ? oidc.redirectUri : '',
    adminSubjects: Array.isArray(oidc?.adminSubjects) ? oidc.adminSubjects.filter((item): item is string => typeof item === 'string') : [],
    clientSecretConfigured: typeof oidc?.clientSecret === 'string' && oidc.clientSecret.length > 0,
    configured: oidcConfigured(oidc, auth.trustedOrigins ?? []),
  }
}

export function validateOidcInput(input: Record<string, unknown>, trustedOrigins: string[]): { options?: OidcOptions; errors: string[] } {
  const errors: string[] = []
  const issuer = input.issuer
  const clientId = input.clientId
  const clientSecret = input.clientSecret
  const redirectUri = input.redirectUri
  const adminSubjects = input.adminSubjects
  if (typeof issuer !== 'string' || !issuer) errors.push('issuer_required')
  if (typeof clientId !== 'string' || !clientId) errors.push('clientId_required')
  if (typeof clientSecret !== 'string' || !clientSecret) errors.push('clientSecret_required')
  if (typeof redirectUri !== 'string' || !redirectUri) errors.push('redirectUri_required')
  if (!Array.isArray(adminSubjects) || !adminSubjects.length || adminSubjects.some((item) => typeof item !== 'string' || !item.trim())) errors.push('adminSubjects_required')
  if (errors.length) return { errors }
  try {
    const issuerUrl = safeEndpoint(issuer as string)
    const redirectUrl = safeEndpoint(redirectUri as string)
    if (issuerUrl.search || issuerUrl.hash) errors.push('issuer_query_invalid')
    if (redirectUrl.pathname !== '/api/auth/oidc/callback' || redirectUrl.search || redirectUrl.hash) errors.push('redirectUri_invalid_path')
    if (!trustedOrigins.includes(redirectUrl.origin)) errors.push('redirectUri_origin_untrusted')
    const options: OidcOptions = { issuer: issuer as string, clientId: clientId as string, clientSecret: clientSecret as string, redirectUri: redirectUri as string, adminSubjects: adminSubjects as string[] }
    if (!oidcConfigured(options, trustedOrigins)) errors.push('oidc_configuration_invalid')
    return errors.length ? { errors } : { options, errors: [] }
  } catch { return { errors: ['oidc_url_invalid'] } }
}

export async function saveOidcConfig(configFile: string, input: Record<string, unknown>): Promise<OidcConfigView> {
  const current = await readAuthOptions(configFile)
  const existing = current.oidc
  const merged: Record<string, unknown> = {
    issuer: input.issuer ?? existing?.issuer ?? '', clientId: input.clientId ?? existing?.clientId ?? '',
    clientSecret: input.clientSecret ?? existing?.clientSecret ?? '', redirectUri: input.redirectUri ?? existing?.redirectUri ?? '',
    adminSubjects: input.adminSubjects ?? existing?.adminSubjects ?? [],
  }
  const empty = Object.values(merged).every((value) => value === '' || (Array.isArray(value) && value.length === 0))
  if (!empty) {
    const result = validateOidcInput(merged, current.trustedOrigins ?? [])
    if (result.errors.length) throw new Error(result.errors.join(','))
  }
  const root = await readConfig(configFile)
  const manager = asRecord(root.manager)
  const auth = asRecord(manager.auth)
  manager.auth = auth; root.manager = manager
  if (empty) delete auth.oidc
  else auth.oidc = merged
  await writeYaml(configFile, root)
  return readOidcConfig(configFile)
}

async function readConfig(file: string): Promise<Record<string, unknown>> {
  try { return asRecord(yaml.load(await readFile(file, 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('Manager 配置不可读取') }
}
function asRecord(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {} }
