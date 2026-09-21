import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PRESETS_TAB = resolve(
  import.meta.dirname,
  '../../src/features/agent/settings/tabs/agent/PresetsTab.vue',
)
const ROLES_TAB = resolve(
  import.meta.dirname,
  '../../src/features/agent/settings/tabs/agent/RolesTab.vue',
)
const ROLES_CONTROLLER = resolve(
  import.meta.dirname,
  '../../src/features/agent/settings/tabs/agent/useRolesTabController.ts',
)
const API = resolve(import.meta.dirname, '../../src/services/agentApi.ts')

describe('preset-scoped role workbench', () => {
  it('mounts the role workbench inside the presets tab and passes the active preset', async () => {
    const presets = await readFile(PRESETS_TAB, 'utf8')

    expect(presets).toContain("const view = ref<'list' | 'workbench' | 'public'>('list')")
    expect(presets).toContain(':preset="activePreset"')
    expect(presets).toContain('openWorkbench')
    expect(presets).toContain('closeWorkbench')
    expect(presets).toContain('编辑角色')
  })

  it('scopes ordinary roles to the current preset members', async () => {
    const controller = await readFile(ROLES_CONTROLLER, 'utf8')

    expect(controller).toContain('function isInRoleScope')
    expect(controller).toContain("props.draft.presets?.[props.preset]?.roles?.includes(name)")
  })

  it('adds new ordinary roles as members of the current preset and supports copy-in', async () => {
    const controller = await readFile(ROLES_CONTROLLER, 'utf8')

    expect(controller).toContain('preset.roles = [...(preset.roles ?? []), type]')
    expect(controller).toContain('copySources')
    expect(controller).toContain('!cfg.lock')
    expect(controller).toContain('onSourceRolePick')
  })

  it('deletes a role globally and clears every preset reference', async () => {
    const controller = await readFile(ROLES_CONTROLLER, 'utf8')

    expect(controller).toContain('delete props.draft.roles[type]')
    expect(controller).toContain('preset.roles = preset.roles?.filter((name) => name !== type)')
    expect(controller).toContain("preset.leader = ''")
    expect(controller).toContain('preset.shadows.conversationRouting = undefined')
  })

  it('keeps leader and explain-role duties on the workbench detail card', async () => {
    const [controller, tab] = await Promise.all([
      readFile(ROLES_CONTROLLER, 'utf8'),
      readFile(ROLES_TAB, 'utf8'),
    ])

    expect(controller).toContain('function toggleLeader')
    expect(controller).toContain('function toggleDetailRole')
    expect(tab).toContain('role-duty-line')
    expect(tab).toContain('toggleLeader')
  })

  it('restores the member duty picker on the preset card surface', async () => {
    const presets = await readFile(PRESETS_TAB, 'utf8')

    expect(presets).toContain('为成员指定职责')
    expect(presets).toContain('设置组长')
    expect(presets).toContain('设置解释')
    expect(presets).toContain('selectRoleDuty')
    expect(presets).toContain('role-picker-section')
    expect(presets).toContain('p.leader = role')
  })

  it('forbids setting a public role as leader on the card duty picker', async () => {
    const presets = await readFile(PRESETS_TAB, 'utf8')

    expect(presets).toContain("isPublicRole(props.draft.roles, props.draft.presets, role)")
    expect(presets).toContain('公共角色不能设为组长')
    expect(presets).toContain("isPublicRole(draft.roles, draft.presets, rname as string)")
  })
})

describe('public role dual-track', () => {
  it('introduces the scope field in the config dto type', async () => {
    const api = await readFile(API, 'utf8')

    expect(api).toContain("scope?: 'public' | 'private'")
  })

  it('exposes public role detection, reference pool and read-only flag in the controller', async () => {
    const controller = await readFile(ROLES_CONTROLLER, 'utf8')

    expect(controller).toContain('function isPublicRole')
    expect(controller).toContain('const publicPool')
    expect(controller).toContain('const referencePool')
    expect(controller).toContain('function referencePublicRole')
    expect(controller).toContain('const readOnly')
    expect(controller).toContain("props.mode === 'public'")
  })

  it('adds a public-role entry and management view in the presets tab', async () => {
    const presets = await readFile(PRESETS_TAB, 'utf8')

    expect(presets).toContain('公共角色')
    expect(presets).toContain('openPublicRoles')
    expect(presets).toContain('closePublicRoles')
    expect(presets).toContain('mode="public"')
  })

  it('marks public roles read-only with a guide and a public tag in the workbench', async () => {
    const tab = await readFile(ROLES_TAB, 'utf8')

    expect(tab).toContain('role-public-tag')
    expect(tab).toContain('role-readonly-banner')
    expect(tab).toContain('公共角色为全局共享')
  })

  it('keeps the public role shared source and preset-side unref in the controller', async () => {
    const controller = await readFile(ROLES_CONTROLLER, 'utf8')

    expect(controller).toContain("scope: 'public' as const")
    expect(controller).toContain('该公共角色将移出本预设')
  })
})
