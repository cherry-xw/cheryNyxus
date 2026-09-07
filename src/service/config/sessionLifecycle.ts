import { getSoulDb } from '@/db/index.js'
import { getChat, getChatMetadata, updateChatMetadata } from '@/db/chat.js'
import {
  activateConfigRevision,
  ensureActiveChatEpoch,
  freezeChatEpochSnapshot,
  getActiveChatEpoch,
  markChatEpochSnapshotLifecycle,
} from '@/db/epoch.js'
import {
  captureRuntimeConfig,
  getAppliedRawConfig,
  prepareRuntimeConfig,
  publishRuntimeConfig,
  type ConfigRaw,
} from '@/utils/config.js'
import {
  clearChatRuntime,
  prepareTreeRuntimeRefresh,
  reconcileSessionBrains,
  renameSessionRoles,
} from '@/service/chat/runtime.js'
import type { ConfigTreeAdapter } from './applyCoordinator.js'
import {
  createConfigRevision,
  ensureCurrentConfigRevision,
  publishProcessRevision,
} from './revision.js'
import { destructiveTargets, resources, imageRevision } from './impact.js'
import { prepareMcpChanges } from '@/core/mcp/loader.js'
import { activeRootIds, treeBoundaryReason, treeChatIds, treeUsesImpacts } from './treeBoundary.js'
import { detectRoleRenames } from './roleRename.js'
import { prepareSenseSourceReload } from '@/agent/sense/index.js'
import { resetModelCatalogCache } from '@/utils/modelCatalog.js'
import { resetSkillCatalogCache } from '@/agent/prompt/loadSkill.js'

export function setConfigResource(raw: ConfigRaw, path: string[], value: unknown): void {
  let target = raw as unknown as Record<string, unknown>
  for (const segment of path.slice(0, -1)) {
    const child = target[segment]
    if (!child || typeof child !== 'object' || Array.isArray(child)) target[segment] = {}
    target = target[segment] as Record<string, unknown>
  }
  const leaf = path.at(-1)!
  if (value === undefined) delete target[leaf]
  else {
    const local =
      path[0] === 'llm' && path.length === 3
        ? 'hooks'
        : path[0] === 'presets' && path.length === 2
          ? 'schedule'
          : undefined
    const current = target[leaf] as Record<string, unknown> | undefined
    target[leaf] =
      local && current && local in current
        ? { ...structuredClone(value as Record<string, unknown>), [local]: current[local] }
        : structuredClone(value)
  }
}

function syncTreeMetadata(rootId: string, raw: ConfigRaw): string[] {
  const rootMeta = getChatMetadata(rootId)
  const presetEntry = Object.entries(raw.presets ?? {}).find(([name, preset]) =>
    rootMeta.presetId ? preset.id === rootMeta.presetId : name === rootMeta.preset,
  )
  const removedPreset = (rootMeta.presetId || rootMeta.preset) && !presetEntry
  const retired: string[] = []
  for (const id of treeChatIds(rootId)) {
    if (getChat(id)?.lifecycle !== 'active') continue
    const meta = getChatMetadata(id)
    const parentRetired =
      getChat(id)?.parent_chat_id && retired.includes(getChat(id)!.parent_chat_id!)
    const roleEntry =
      id === rootId && presetEntry
        ? Object.entries(raw.roles ?? {}).find(([name]) => name === presetEntry[1].leader)
        : Object.entries(raw.roles ?? {}).find(([name, role]) =>
            meta.roleId ? role.id === meta.roleId : name === meta.type,
          )
    if (removedPreset || parentRetired || ((meta.roleId || meta.type) && !roleEntry)) {
      const lifecycle = removedPreset ? 'archived' : 'retired'
      markChatEpochSnapshotLifecycle(id, lifecycle, '配置删除在节点树安全边界生效')
      updateChatMetadata(id, { [lifecycle]: true, retirementReason: '关联配置已删除' })
      retired.push(id)
      continue
    }
    const role = roleEntry?.[1]
    updateChatMetadata(id, {
      ...(roleEntry
        ? {
            roleId: role?.id,
            type: roleEntry[0],
            systemPromptFile: role?.systemPrompt,
            skillFilter: { skills: role?.skills, plugins: role?.plugins },
          }
        : {}),
      ...(presetEntry
        ? {
            workspace: presetEntry[1].workspace,
            rule: presetEntry[1].rule,
            ...(id === rootId
              ? {
                  preset: presetEntry[0],
                  presetId: presetEntry[1].id,
                  spawnTypes: presetEntry[1].roles,
                }
              : {}),
          }
        : {}),
    })
  }
  return retired
}

/** All semantic owners in one submission move together. Shared config is never
 * partially published between a role rename, its preset and its brain. */
export const prepareSessionLifecycle: ConfigTreeAdapter = async ({ impacts, target }) => {
  const before = getAppliedRawConfig()
  const appliedRevision = ensureCurrentConfigRevision()
  const targetResources = resources(target)
  const next = structuredClone(before)
  for (const impact of impacts) {
    const path = JSON.parse(impact.resource) as string[]
    if (path[0] !== 'assets')
      setConfigResource(next, path, targetResources.get(impact.resource)?.value)
  }
  const deleting = destructiveTargets(before, next).length > 0
  const affected = () =>
    activeRootIds().filter(
      (id) => treeUsesImpacts(id, before, impacts) || treeUsesImpacts(id, next, impacts),
    )
  const unsafe = () =>
    affected()
      .map((id) => treeBoundaryReason(id, deleting))
      .find(Boolean)
  // Validation is side-effect free, even when the tree still has work to drain.
  const candidate = prepareRuntimeConfig(next)
  const assets = impacts.flatMap((impact) => {
    const [root, name] = JSON.parse(impact.resource) as string[]
    return root === 'assets' && name ? [name] : []
  })
  // Compile only once the current work has drained. Recheck after asynchronous preparation.
  const blockedReason = unsafe()
  if (blockedReason)
    return { unsafe: () => blockedReason, affectedRootChatIds: affected, apply() {}, dispose() {} }
  const senses = assets.some((name) => name.startsWith('senses/'))
    ? await prepareSenseSourceReload()
    : undefined
  const mcpNames = [
    ...new Set(
      impacts.flatMap((impact) => {
        const [root, name] = JSON.parse(impact.resource) as string[]
        return root === 'mcp_servers' && name ? [name] : []
      }),
    ),
  ]
  let mcp: Awaited<ReturnType<typeof prepareMcpChanges>> | undefined
  try {
    if (mcpNames.length) mcp = await prepareMcpChanges(candidate.config.mcp_servers ?? {}, mcpNames)
  } catch (error) {
    senses?.dispose()
    throw error
  }
  return {
    unsafe: () => unsafe() ?? mcp?.unsafe(),
    affectedRootChatIds: affected,
    apply() {
      const reason = unsafe()
      if (reason) throw new Error(reason)
      const previous = { raw: getAppliedRawConfig(), config: captureRuntimeConfig() }
      const roots = affected()
      const renames = detectRoleRenames(before.roles, next.roles)
      const refreshed: Array<{
        prepared: ReturnType<typeof prepareTreeRuntimeRefresh>
        epochId: string
      }> = []
      const retired: string[] = []
      const preparedRuntimes: Array<ReturnType<typeof prepareTreeRuntimeRefresh>> = []
      const restoreSessionBrains = reconcileSessionBrains(roots, before, next)
      const restoreSessionNames = renameSessionRoles(renames)
      let active: ReturnType<typeof activateConfigRevision> | undefined
      try {
        getSoulDb().transaction(() => {
          // This synchronous scope cannot interleave with generators. Any failure
          // rolls back DB writes and restores the exact previous config object.
          publishRuntimeConfig(candidate)
          senses?.apply()
          mcp?.apply()
          if (assets.includes('model-catalog.yaml')) resetModelCatalogCache()
          if (assets.some((name) => /^(skills|plugins)\//.test(name))) resetSkillCatalogCache()
          const manifest = structuredClone(appliedRevision.resources)
          const entries = new Map(
            ((manifest.entries as Array<{ path: string; sha256: string }>) ?? []).map((entry) => [
              entry.path,
              entry,
            ]),
          )
          for (const name of assets) {
            const hash = target.assets?.[name]
            if (hash) entries.set(name, { path: name, sha256: hash })
            else entries.delete(name)
          }
          for (const [name, contract] of Object.entries(mcp?.contracts() ?? {})) {
            const path = `mcp/${name}`
            if (contract) entries.set(path, { path, sha256: imageRevision(contract) })
            else entries.delete(path)
          }
          manifest.entries = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))
          const revision = createConfigRevision({
            raw: next,
            source: 'structured',
            resourceManifest: manifest,
          })
          const renameMap = new Map(renames.map(({ from, to }) => [from, to]))
          if (renameMap.size) {
            for (const row of getSoulDb().prepare('SELECT id FROM chats').all() as {
              id: string
            }[]) {
              const metadata = getChatMetadata(row.id)
              const type =
                typeof metadata.type === 'string' ? renameMap.get(metadata.type) : undefined
              const spawnTypes = Array.isArray(metadata.spawnTypes)
                ? metadata.spawnTypes.map((name) => renameMap.get(name) ?? name)
                : undefined
              if (type || spawnTypes)
                updateChatMetadata(row.id, {
                  ...(type ? { type } : {}),
                  ...(spawnTypes ? { spawnTypes } : {}),
                })
            }
          }
          for (const rootId of roots) {
            retired.push(...syncTreeMetadata(rootId, next))
            if (getChat(rootId)?.lifecycle !== 'active') {
              getSoulDb()
                .prepare(
                  "UPDATE chat_epochs SET status = 'archived', closed_at = COALESCE(closed_at, ?) WHERE root_chat_id = ? AND status = 'active'",
                )
                .run(Date.now(), rootId)
              continue
            }
            const oldEpoch = getActiveChatEpoch(rootId)
            // An unopened historical tree is initialized by ensureChat, which
            // owns its cross-database legacy message migration.
            if (!oldEpoch) continue
            const prepared = prepareTreeRuntimeRefresh(rootId)
            preparedRuntimes.push(prepared)
            const epoch = ensureActiveChatEpoch({
              chatId: rootId,
              revisionId: revision.revisionId,
              transitionReason: 'configuration-changed',
              handoffSummary: '配置已在节点树安全边界更新，历史对话和已接收输入完整保留。',
            }).epoch
            for (const snapshot of prepared.snapshots) {
              const meta = getChatMetadata(snapshot.chatId)
              freezeChatEpochSnapshot({
                ...snapshot,
                epochId: epoch.epochId,
                roleId: typeof meta.roleId === 'string' ? meta.roleId : undefined,
                roleName: typeof meta.type === 'string' ? meta.type : undefined,
                runtime: snapshot.selection as unknown as Record<string, unknown>,
                resources: revision.resources,
              })
            }
            if (oldEpoch) {
              for (const id of treeChatIds(rootId))
                getSoulDb()
                  .prepare(
                    "UPDATE pending_inputs SET epoch_id = ? WHERE chat_id = ? AND epoch_id = ? AND state IN ('accepted', 'queued')",
                  )
                  .run(epoch.epochId, id, oldEpoch.epochId)
            }
            refreshed.push({ prepared, epochId: epoch.epochId })
          }
          const tasks = getSoulDb().prepare('SELECT task_id, type FROM spawn_tasks').all() as {
            task_id: string
            type: string
          }[]
          for (const task of tasks) {
            const to = renameMap.get(task.type)
            if (to)
              getSoulDb()
                .prepare('UPDATE spawn_tasks SET type = ? WHERE task_id = ?')
                .run(to, task.task_id)
          }
          active = activateConfigRevision(revision.revisionId)
        })()
      } catch (error) {
        publishRuntimeConfig(previous)
        restoreSessionNames()
        restoreSessionBrains()
        mcp?.rollback()
        senses?.rollback()
        for (const prepared of preparedRuntimes) prepared.dispose()
        throw error
      }
      publishProcessRevision(active!)
      for (const { prepared, epochId } of refreshed) prepared.publish(epochId)
      for (const id of retired) clearChatRuntime(id)
      mcp?.commit()
    },
    async dispose() {
      try {
        senses?.dispose()
      } finally {
        await mcp?.dispose()
      }
    },
  }
}
