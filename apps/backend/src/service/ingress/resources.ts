import type { IngressRegistration, IngressRequestIdentity } from './api.js'
import { dirname, join } from 'node:path'

export interface PluginSkillSource {
  ownerId: string
  version: string
  resourceId: string
  filePath: string
  channel?: string
}
const sources = new Map<string, PluginSkillSource>()

/** Called only after the host publishes an active business transaction. */
export function registerPluginResources(
  registration: IngressRegistration,
  packageDir: string,
): () => void {
  const added: string[] = []
  const skills = (registration.resources ?? []).filter(resource => resource.kind === 'skill')
  const keys = skills.map(resource => `${registration.id}:${resource.id}`)
  if (new Set(keys).size !== keys.length || keys.some(key => sources.has(key)))
    throw new Error('REGISTRATION_CONFLICT')
  for (const resource of skills) {
    const key = `${registration.id}:${resource.id}`
    sources.set(key, Object.freeze({
      ownerId: registration.id,
      version: registration.version,
      resourceId: resource.id,
      filePath: join(packageDir, resource.path),
      ...(resource.channel ? { channel: resource.channel } : {}),
    }))
    added.push(key)
  }
  return () => { for (const key of added) sources.delete(key) }
}

/** A catalog request cannot grant a request access to business resources. */
export function pluginSkillSources(identity?: IngressRequestIdentity): PluginSkillSource[] {
  if (!identity) return []
  return [...sources.values()].filter(source => source.channel
    ? identity.source === 'plugin' && identity.channel === source.channel && !!identity.subject
    : identity.source === 'plugin' && identity.ownerId === source.ownerId)
}
export function pluginSkillLocations(identity?: IngressRequestIdentity) {
  return pluginSkillSources(identity).map(source => ({
    skillDir: dirname(source.filePath),
    defaultName: source.resourceId,
    plugin: source.ownerId,
    source,
  }))
}
