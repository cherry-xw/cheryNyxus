import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { writeYaml } from './credentials.js'

export interface RelayManagerConfig {
  url: string
  backendId: string
  publicDiscovery: boolean
  remotePasswordEnabled: boolean
}

const DEFAULTS: RelayManagerConfig = {
  url: '',
  backendId: '',
  publicDiscovery: false,
  remotePasswordEnabled: true,
}

export class RelayConfigStore {
  constructor(private readonly configFile: string) {}

  async view(): Promise<RelayManagerConfig> {
    const config = await this.readConfig()
    const relay = asRecord(config.relay)
    return {
      url: typeof relay.url === 'string' ? relay.url : DEFAULTS.url,
      backendId: typeof relay.backendId === 'string' ? relay.backendId : DEFAULTS.backendId,
      publicDiscovery: typeof relay.publicDiscovery === 'boolean' ? relay.publicDiscovery : DEFAULTS.publicDiscovery,
      remotePasswordEnabled:
        typeof relay.remotePasswordEnabled === 'boolean'
          ? relay.remotePasswordEnabled
          : DEFAULTS.remotePasswordEnabled,
    }
  }

  async save(input: Record<string, unknown>): Promise<RelayManagerConfig> {
    const current = await this.view()
    const next: RelayManagerConfig = {
      url: readString(input.url, current.url, 2048),
      backendId: readString(input.backendId, current.backendId, 128),
      publicDiscovery: readBoolean(input.publicDiscovery, current.publicDiscovery),
      remotePasswordEnabled: readBoolean(input.remotePasswordEnabled, current.remotePasswordEnabled),
    }
    if (next.url) {
      let parsed: URL
      try {
        parsed = new URL(next.url)
      } catch {
        throw new Error('url must be an absolute HTTP(S) URL')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('url must be an absolute HTTP(S) URL')
      }
    }
    if (next.backendId && !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(next.backendId)) {
      throw new Error('backendId must contain 3-63 lowercase letters, numbers or hyphens')
    }
    const config = await this.readConfig()
    config.relay = next
    await writeYaml(this.configFile, config)
    return next
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

function readString(value: unknown, fallback: string, maxLength: number): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(`value must be a string of at most ${maxLength} characters`)
  return value.trim()
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error('value must be a boolean')
  return value
}
