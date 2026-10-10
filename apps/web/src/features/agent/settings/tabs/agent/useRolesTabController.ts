import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, toRaw, watch } from 'vue'
import { CopyDocument, Delete, Lock, Plus } from '@element-plus/icons-vue'
import type { ConfigDto } from '@/application/backend/public'
import {
  isPublicRole as sharedIsPublicRole,
  isSeedPublicRole,
  listPublicRoles,
} from './publicRole'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import EditableTitle from '@/features/agent/settings/controls/EditableTitle.vue'
import ResourceWorkbench, { type ResourceRailItem } from './ResourceWorkbench.vue'
import AvatarPicker from './AvatarPicker.vue'
import EquipmentPicker from '../../controls/EquipmentPicker.vue'
import EquipmentEditor from '../../controls/EquipmentEditor.vue'
import { resolveRoleAvatar } from '../../config/roleAvatar'
import { computeSelectionTokens } from '../../config/shared'
import {
  EFFECT_LABELS,
  READ_LABELS,
  SANDBOX_LABELS,
  TEMPLATE_CARDS,
  WRITE_LABELS,
  resolveEffectivePolicy,
} from '../../config/rolePermissions'
import LabelTip from '../config/LabelTip.vue'
import { buildPromptTree } from '../promptTree'

type SkillCatalog = {
  skills: string[]
  plugins: string[]
  skillTokens: Record<string, number>
  pluginTokens: Record<string, number>
}
type RoleMode = 'role' | 'shadow'

export type RolesTabControllerProps = {
  draft: ConfigDto
  prompts: string[]
  skillCatalog: SkillCatalog
  /** 预设范围：提供时角色工作台限定到该预设引用的成员。 */
  preset?: string
  /** 工作台形态：'preset' 预设工作台（缺省）；'public' 公共角色管理视图（全局维护层，无 preset）。 */
  mode?: 'preset' | 'public'
}
export type RolesTabControllerEmits = {
  (e: 'error', msg: string): void
  (e: 'mode-change', mode: RoleMode): void
}

export function useRolesTabController(
  props: RolesTabControllerProps,
  emit: RolesTabControllerEmits,
) {
  const CHERY_NYXUS_ROLE = 'cheryNyxus'

  type RoleDraft = NonNullable<ConfigDto['roles']>[string]

  type SkillCatalog = {
    skills: string[]

    plugins: string[]

    skillTokens: Record<string, number>

    pluginTokens: Record<string, number>
  }

  type RoleMode = 'role' | 'shadow'

  const roleMode = ref<RoleMode>('role')

  const selectedRole = ref('')

  const newRoleType = ref('')

  /** 新增角色时「从其他预设复制」的来源预设名 / 来源角色名（仅普通角色模式可用）。 */
  const newRoleSourcePreset = ref('')
  const newRoleSourceRole = ref('')

  const copiedRole = ref('')

  const titleRef = ref<InstanceType<typeof EditableTitle> | null>(null)

  type EquipmentKind = 'skills' | 'plugins' | 'mcpServers'

  const activeEquipment = ref<EquipmentKind | null>(null)

  // AI 大脑按钮里超长 name / model 的溢出状态：key=`<field>-<brainName>`，true 时该行才允许 tooltip

  const isOverflowing = ref<Record<string, boolean>>({})

  const overflowEls = new Map<string, HTMLElement>()

  function setOverflowRef(el: unknown, key: string): void {
    if (el instanceof HTMLElement) overflowEls.set(key, el)
    else overflowEls.delete(key)
  }

  function checkOverflow(key: string, ev: MouseEvent): void {
    const el = overflowEls.get(key)

    if (!el) return

    // mouseenter 时强制下一帧重排后检测，避免首次 hover 立刻拿旧值

    const target = ev.currentTarget as HTMLElement | null

    void target?.offsetWidth // 强制 reflow

    isOverflowing.value = {
      ...isOverflowing.value,

      [key]: el.scrollWidth > el.clientWidth + 1,
    }
  }

  /** 是否公共角色管理视图（全局维护层）：无预设、只列公共角色。 */
  const publicMode = computed(() => props.mode === 'public')

  /** 角色是否公共角色：显式 scope==='public'，或存量兼容——固定预设（cheryNexus）的非锁定普通成员角色视为公共。 */
  function isPublicRole(name: string): boolean {
    return sharedIsPublicRole(props.draft.roles, props.draft.presets, name)
  }

  /** 公共角色池（普通模式）：固定预设种子 + 显式 scope 公共。 */
  const publicPool = computed(() => listPublicRoles(props.draft))

  /** 可引用进当前预设的公共角色：公共池排除本预设已引用。 */
  const referencePool = computed(() => {
    if (!props.preset) return []
    const preset = props.draft.presets?.[props.preset]
    return publicPool.value.filter((name) => !preset?.roles?.includes(name))
  })

  /** 把公共角色加入当前预设成员（引用，不复制配置）。 */
  function referencePublicRole(name: string): void {
    if (!props.preset) return
    const preset = props.draft.presets?.[props.preset]
    if (!preset || preset.roles?.includes(name)) return
    preset.roles = [...(preset.roles ?? []), name]
    selectedRole.value = name
  }

  /** 新增角色弹窗「引用公共角色」已选角色（选定即加入本预设成员，不产生副本）。 */
  const referenceRolePick = ref('')
  function onReferencePick(name: string): void {
    referenceRolePick.value = ''
    if (!name) return
    referencePublicRole(name)
  }

  /** 公共角色配置是否只读：公共管理视图可编辑（维护层）；预设工作台里公共角色只读（引导去公共层改）。 */
  const readOnly = computed(
    () => !publicMode.value && !!selectedRole.value && isPublicRole(selectedRole.value),
  )

  /** 公共管理视图里选中的固定预设种子公共角色（系统模板，禁止删除）。 */
  const isSeedPublicRoleSelected = computed(() =>
    publicMode.value && isSeedPublicRole(props.draft.roles, props.draft.presets, selectedRole.value),
  )

  const removeImpact = computed(() => {
    const refs = Object.values(props.draft.presets ?? {}).filter(
      (p) =>
        p.roles?.includes(selectedRole.value) ||
        p.shadows?.conversationRouting === selectedRole.value,
    )

    if (isPublicRole(selectedRole.value) && !publicMode.value) {
      return ['该公共角色将移出本预设（不再作为本预设成员），配置保留在「公共角色」管理中。']
    }

    const lines: string[] = [
      '该角色将从所有预设的成员中移除，其全部配置（大脑 / 器官 / 装备）一并删除。',
    ]

    if (refs.length > 1) lines.push(`该角色仍被 ${refs.length - 1} 个其他预设引用，将一并清理。`)

    return lines
  })

  const roles = computed(() => props.draft.roles ?? {})

  /** 普通角色是否属于当前编辑范围：公共管理视图下为公共角色；预设模式下仅该预设引用的成员。 */
  function isInRoleScope(name: string): boolean {
    if (publicMode.value) return isPublicRole(name)
    if (!props.preset) return true
    return !!props.draft.presets?.[props.preset]?.roles?.includes(name)
  }

  const filteredRoles = computed(() =>
    Object.fromEntries(
      Object.entries(roles.value).filter(([name, cfg]) =>
        roleMode.value === 'shadow' ? cfg.kind === 'shadow' : isInRoleScope(name),
      ),
    ),
  )

  const current = computed(() => roles.value[selectedRole.value])

  const isFixedRole = computed(() => selectedRole.value === CHERY_NYXUS_ROLE)

  /** 当前预设（预设范围模式）；缺省为 undefined（全局模式）。 */
  const currentPreset = computed(() =>
    props.preset ? props.draft.presets?.[props.preset] : undefined,
  )

  /** 当前预设是否为固定预设（cheryNyxus）：组长与成员不可改。 */
  const isFixedPreset = computed(() => props.preset === CHERY_NYXUS_ROLE)

  /** 当前角色是否为本预设组长 / 解释角色。 */
  const isLeader = computed(() => currentPreset.value?.leader === selectedRole.value)
  const isDetailRole = computed(() => currentPreset.value?.detailRole === selectedRole.value)

  /** 设 / 取消当前角色为组长；组长不能是公共角色、不能同时作为解释角色。 */
  function toggleLeader(): void {
    const p = currentPreset.value
    if (!p || isFixedPreset.value || isPublicRole(selectedRole.value)) return
    if (p.leader === selectedRole.value) p.leader = ''
    else {
      p.leader = selectedRole.value
      if (p.detailRole === selectedRole.value) p.detailRole = undefined
    }
  }

  /** 设 / 取消当前角色为解释角色；组长不能同时作为解释角色。 */
  function toggleDetailRole(): void {
    const p = currentPreset.value
    if (!p || isFixedPreset.value || p.leader === selectedRole.value) return
    p.detailRole = p.detailRole === selectedRole.value ? undefined : selectedRole.value
  }

  const brainNames = computed(() => Object.keys(props.draft.llm.brain))

  const senseNames = computed(() => Object.keys(props.draft.sense_groups ?? {}))

  const mcpNames = computed(() => Object.keys(props.draft.mcp_servers ?? {}))

  const mcpTokens = computed(() => Object.fromEntries(mcpNames.value.map((name) => [name, 200])))

  const equipmentEditor = computed(() => {
    if (!current.value || !activeEquipment.value) return null

    if (activeEquipment.value === 'skills') {
      return {
        key: 'skills' as const,

        label: '技能',

        value: current.value.skills,

        options: props.skillCatalog.skills,

        tokenMap: props.skillCatalog.skillTokens,
      }
    }

    if (activeEquipment.value === 'plugins') {
      return {
        key: 'plugins' as const,

        label: '插件',

        value: current.value.plugins,

        options: props.skillCatalog.plugins,

        tokenMap: props.skillCatalog.pluginTokens,
      }
    }

    return {
      key: 'mcpServers' as const,

      label: 'MCP 服务',

      value: current.value.mcpServers,

      options: mcpNames.value,

      tokenMap: mcpTokens.value,
    }
  })

  const permissionTemplate = computed({
    get: () => current.value?.permissions?.template ?? 'supervised',

    set: (template: NonNullable<RoleDraft['permissions']>['template']) => {
      // 换模板只换基线，保留显式覆盖项（与后端 mergePolicy 行为一致）

      if (readOnly.value) return
      if (current.value) current.value.permissions = { ...current.value.permissions, template }
    },
  })

  // 生效结果预览：模板默认 + 显式覆盖的合并镜像，见 config/rolePermissions.ts

  const effectivePermission = computed(() => resolveEffectivePolicy(current.value?.permissions))

  const permissionPreview = computed(() => {
    const e = effectivePermission.value

    return [
      {
        key: 'read',
        label: '读',
        value: READ_LABELS[e.read] ?? e.read,
        customized: e.customized.read,
      },

      {
        key: 'write',
        label: '写',
        value: WRITE_LABELS[e.write] ?? e.write,
        customized: e.customized.write,
      },

      {
        key: 'sandbox',

        label: '命令',

        value: SANDBOX_LABELS[e.maxSandboxMode] ?? e.maxSandboxMode,

        customized: e.customized.maxSandboxMode,
      },

      {
        key: 'shells',

        label: '方言',

        value: e.shells.length ? e.shells.join(' / ') : '全部禁用',

        customized: e.customized.shells,
      },

      {
        key: 'mcp',
        label: 'MCP',
        value: EFFECT_LABELS[e.mcpDefault] ?? e.mcpDefault,
        customized: e.customized.mcpDefault,
      },

      {
        key: 'spawn',
        label: '派遣',
        value: EFFECT_LABELS[e.spawnEffect] ?? e.spawnEffect,
        customized: e.customized.spawnEffect,
      },
    ]
  })

  function ensurePermissions(): NonNullable<RoleDraft['permissions']> | undefined {
    if (!current.value) return undefined

    current.value.permissions ??= { template: 'supervised' }

    return current.value.permissions
  }

  const allowedShells = computed<Array<'bash' | 'powershell'>>({
    get: () => current.value?.permissions?.commands?.shells ?? ['bash', 'powershell'],

    set: (shells) => {
      const policy = ensurePermissions()

      if (policy) policy.commands = { ...policy.commands, shells }
    },
  })

  function setPermissionSection(
    section: 'filesystem' | 'commands' | 'mcp' | 'spawn',

    key: string,

    value: unknown,
  ): void {
    const policy = ensurePermissions()

    if (!policy || readOnly.value) return

    ;(policy as unknown as Record<string, unknown>)[section] = {
      ...((policy as unknown as Record<string, unknown>)[section] as
        Record<string, unknown> | undefined),

      [key]: value,
    }
  }

  const promptOptions = computed(() => buildPromptTree(props.prompts))

  // clearable 清空时 cascader emit 空串，归一为 undefined（= 无专属背景，仅用全局）

  const systemPromptModel = computed<string>({
    get: () => current.value?.systemPrompt ?? '',

    set: (v: string) => {
      if (readOnly.value) return
      if (current.value) current.value.systemPrompt = v || undefined
    },
  })

  // 角色说明：header 内注释样式 inline 编辑（锁定角色只读）；空串归一为 undefined

  const descEditing = ref(false)

  const descEditValue = ref('')

  function startDescEdit(): void {
    if (current.value?.lock || isFixedRole.value || readOnly.value) return

    descEditing.value = true

    descEditValue.value = current.value?.description ?? ''
  }

  function commitDescEdit(): void {
    if (!descEditing.value) return

    const v = descEditValue.value.trim()

    if (current.value) current.value.description = v || undefined

    descEditing.value = false

    descEditValue.value = ''
  }

  function cancelDescEdit(): void {
    descEditing.value = false

    descEditValue.value = ''
  }

  // 角色标题超长截断（EditableTitle 内部 .card-name）：在 mounted/updated 时把 fullName 写到

  // title 上做 hover 兜底——EditableTitle 自己固定 title="点击改名"，这里覆盖而非冲突。

  // 用 MutationObserver 监听 selectedRole 变化后 EditableTitle 重新渲染的 .card-name 节点。

  function syncRoleNameTitle(): void {
    const root = document.querySelector<HTMLElement>('.role-name-edit .card-name')

    if (root) root.title = selectedRole.value
  }

  let roleNameObserver: MutationObserver | null = null

  onMounted(() => {
    syncRoleNameTitle()

    roleNameObserver = new MutationObserver(() => syncRoleNameTitle())

    roleNameObserver.observe(document.body, { childList: true, subtree: true })
  })

  onUpdated(() => {
    syncRoleNameTitle()
  })

  onBeforeUnmount(() => {
    roleNameObserver?.disconnect()

    window.clearTimeout(swapTimer)
  })

  function roleTokens(cfg: RoleDraft): number {
    return (
      computeSelectionTokens(
        cfg.skills,
        props.skillCatalog.skills,
        props.skillCatalog.skillTokens,
      ) +
      computeSelectionTokens(
        cfg.plugins,

        props.skillCatalog.plugins,

        props.skillCatalog.pluginTokens,
      ) +
      computeSelectionTokens(cfg.mcpServers, mcpNames.value, mcpTokens.value)
    )
  }

  // 轨道排序：锁定角色固定在上半部分（lock 优先），组内保持原插入顺序；

  // 稳定 sort 仅把 lock 角色提到前面，不改变两类各自内部的相对顺序。

  const railItems = computed<ResourceRailItem[]>(() =>
    Object.entries(filteredRoles.value)

      .sort(([, a], [, b]) => Number(!!b.lock) - Number(!!a.lock))

      .map(([type, cfg]) => ({
        key: type,

        label: type,

        avatar: resolveRoleAvatar(type, cfg.avatar),

        meta: `${cfg.brain || '未选大脑'} · ${cfg.senseGroup || '无器官'}`,

        badge: isPublicRole(type)
          ? '公共'
          : cfg.lock
            ? '锁定'
            : roleTokens(cfg) > 5000
              ? '高负重'
              : undefined,

        danger: !props.draft.llm.brain[cfg.brain],
      })),
  )

  /** 可复制的来源角色：其他预设的普通角色（排除锁定角色与 cheryNyxus 固定角色）；公共管理视图无来源。 */
  const copySources = computed(() => {
    if (publicMode.value) return []
    return Object.entries(props.draft.presets ?? {})
      .filter(([name]) => name !== props.preset)
      .map(([name, p]) => ({
        name,
        roles: (p.roles ?? []).filter((r) => {
          const cfg = props.draft.roles?.[r]
          return !!cfg && cfg.kind !== 'shadow' && !cfg.lock && r !== CHERY_NYXUS_ROLE
        }),
      }))
      .filter((source) => source.roles.length > 0)
  })

  const sourceRoleOptions = computed(
    () =>
      copySources.value.find((source) => source.name === newRoleSourcePreset.value)?.roles ?? [],
  )

  /** 选定复制来源后自动填新角色名（全局唯一化；复制后两份配置独立编辑）。 */
  function onSourceRolePick(role: string): void {
    newRoleSourceRole.value = role
    if (!role) return
    let name = role
    let suffix = 2
    while (props.draft.roles?.[name]) name = `${role}_copy_${suffix++}`
    newRoleType.value = name
  }

  function resetNewRoleSource(): void {
    newRoleSourcePreset.value = ''
    newRoleSourceRole.value = ''
  }

  function addRole(): void {
    const type = newRoleType.value.trim()

    if (!type) return

    if (!props.draft.roles) props.draft.roles = {}

    if (props.draft.roles[type]) {
      emit('error', `角色 "${type}" 已存在`)
      return
    }

    const isShadow = roleMode.value === 'shadow'
    if (!isShadow && !publicMode.value && newRoleSourceRole.value) {
      const source = props.draft.roles?.[newRoleSourceRole.value]
      if (source) {
        const copy = structuredClone(toRaw(source)) as RoleDraft
        delete copy.lock
        props.draft.roles[type] = copy
      }
    }
    props.draft.roles[type] ??= {
      ...(isShadow ? { kind: 'shadow' as const } : {}),

      ...(!isShadow && publicMode.value ? { scope: 'public' as const } : {}),

      brain: brainNames.value[0] ?? '',

      senseGroup: isShadow
        ? (senseNames.value.find((name) =>
            (props.draft.sense_groups?.[name] ?? []).some((entry) =>
              entry.startsWith('select_conversation'),
            ),
          ) ??
          senseNames.value[0] ??
          '')
        : (senseNames.value[0] ?? ''),
    }

    // 预设模式：新建普通角色自动成为本预设成员（公共管理视图不加入任何预设）
    if (!isShadow && !publicMode.value && props.preset) {
      const preset = props.draft.presets?.[props.preset]
      if (preset) preset.roles = [...(preset.roles ?? []), type]
    }

    newRoleType.value = ''
    resetNewRoleSource()
    selectedRole.value = type
  }

  function removeRole(type: string): void {
    if (!props.draft.roles || props.draft.roles[type]?.lock || type === CHERY_NYXUS_ROLE) return

    // 公共管理视图：固定预设种子公共角色属系统模板，禁止删除
    if (publicMode.value && isSeedPublicRole(props.draft.roles, props.draft.presets, type)) return

    // 公共角色：公共管理视图删全局配置；预设工作台只「移出本预设」（配置保留在公共层）
    if (isPublicRole(type)) {
      if (!publicMode.value && props.preset) {
        const preset = props.draft.presets?.[props.preset]
        if (!preset) return
        preset.roles = preset.roles?.filter((name) => name !== type)
        if (preset.detailRole === type) preset.detailRole = undefined
        if (preset.shadows?.conversationRouting === type) {
          preset.shadows.conversationRouting = undefined
        }
        return
      }
      delete props.draft.roles[type]
      for (const preset of Object.values(props.draft.presets ?? {})) {
        preset.roles = preset.roles?.filter((name) => name !== type)
        if (preset.detailRole === type) preset.detailRole = undefined
        if (preset.shadows?.conversationRouting === type) {
          preset.shadows.conversationRouting = undefined
        }
      }
      return
    }

    // 私有角色：连全局删 + 清理所有预设引用
    delete props.draft.roles[type]

    for (const preset of Object.values(props.draft.presets ?? {})) {
      preset.roles = preset.roles?.filter((name) => name !== type)

      if (preset.leader === type) preset.leader = ''

      if (preset.detailRole === type) preset.detailRole = undefined

      if (preset.shadows?.conversationRouting === type) {
        preset.shadows.conversationRouting = undefined
      }
    }
  }

  function duplicateRole(type: string): void {
    if (!props.draft.roles?.[type] || props.draft.roles[type].lock || type === CHERY_NYXUS_ROLE)
      return

    let name = `${type}_copy`

    let suffix = 2

    while (props.draft.roles[name]) name = `${type}_copy_${suffix++}`

    const rebuilt: NonNullable<ConfigDto['roles']> = {}

    for (const [key, value] of Object.entries(props.draft.roles)) {
      rebuilt[key] = value

      if (key === type) {
        const clone = structuredClone(toRaw(value)) as RoleDraft

        if (publicMode.value && clone.kind !== 'shadow') clone.scope = 'public'

        rebuilt[name] = clone
      }
    }

    props.draft.roles = rebuilt

    // 预设模式：普通角色副本加入本预设成员
    if (props.preset && rebuilt[name]?.kind !== 'shadow') {
      const preset = props.draft.presets?.[props.preset]
      if (preset) preset.roles = [...(preset.roles ?? []), name]
    }

    selectedRole.value = name

    copiedRole.value = name

    window.setTimeout(() => {
      copiedRole.value = ''
    }, 700)

    nextTick(() => titleRef.value?.start())
  }

  function renameRole(oldType: string, newType: string): void {
    if (!props.draft.roles?.[oldType] || oldType === CHERY_NYXUS_ROLE) return

    const rebuilt: NonNullable<ConfigDto['roles']> = {}

    for (const [key, value] of Object.entries(props.draft.roles)) {
      const next = key === oldType ? newType : key

      rebuilt[next] = value

      // 公共管理视图：改名后的公共角色显式标 public，避免种子推导失效后退化为私有
      if (publicMode.value && key === oldType) rebuilt[next]!.scope = 'public'
    }

    props.draft.roles = rebuilt

    for (const preset of Object.values(props.draft.presets ?? {})) {
      preset.roles = preset.roles?.map((name) => (name === oldType ? newType : name))

      if (preset.leader === oldType) preset.leader = newType

      if (preset.detailRole === oldType) preset.detailRole = newType

      if (preset.shadows?.conversationRouting === oldType) {
        preset.shadows.conversationRouting = newType
      }
    }

    selectedRole.value = newType
  }

  function validateRename(name: string): string | null {
    return name !== selectedRole.value && props.draft.roles?.[name] ? `角色 "${name}" 已存在` : null
  }

  function supportsTools(brain: string): boolean {
    return props.draft.llm.brain[brain]?.capabilities?.toolCall !== false
  }

  function setBrain(cfg: RoleDraft, brain: string): void {
    if (readOnly.value || (isFixedRole.value && !supportsTools(brain))) return

    cfg.brain = brain

    if (!supportsTools(brain)) {
      cfg.senseGroup = ''

      cfg.mcpServers = []
    }
  }

  function openEquipment(kind: EquipmentKind): void {
    if (isFixedRole.value || readOnly.value) return

    activeEquipment.value = kind
  }

  function closeEquipment(): void {
    activeEquipment.value = null
  }

  function updateEquipment(value: string[]): void {
    const cfg = current.value

    const kind = activeEquipment.value

    if (!cfg || !kind || isFixedRole.value || readOnly.value) return

    cfg[kind] = value
  }

  watch(selectedRole, () => {
    closeEquipment()

    titleRef.value?.cancel()
  })

  // 切换来源预设时清空已选来源角色，避免残留到新来源不存在的角色
  watch(newRoleSourcePreset, () => {
    newRoleSourceRole.value = ''
  })

  function setRoleMode(mode: RoleMode): void {
    if (publicMode.value) return
    if (roleMode.value === mode) return

    roleMode.value = mode

    resetNewRoleSource()

    emit('mode-change', mode)

    selectedRole.value = Object.keys(filteredRoles.value)[0] ?? ''
  }

  // 卡牌换位：点击触发上卡向上 / 下卡向下分离；150ms 分离顶点（完全不重叠）翻转 roleMode，

  // z-index 随 is-front/is-back 同帧互换，再合拢成交叉换层后的姿态。期间连点忽略。

  let swapTimer = 0

  const swapping = ref(false)

  function toggleRoleMode(): void {
    if (publicMode.value) return
    if (swapping.value) return

    swapping.value = true

    swapTimer = window.setTimeout(() => {
      swapping.value = false

      setRoleMode(roleMode.value === 'role' ? 'shadow' : 'role')
    }, 150)
  }

  watch(
    filteredRoles,

    (available) => {
      if (!available[selectedRole.value]) selectedRole.value = Object.keys(available)[0] ?? ''
    },

    { immediate: true },
  )

  onMounted(() => emit('mode-change', roleMode.value))

  return {
    AvatarPicker,
    ConfirmPopover,
    CopyDocument,
    Delete,
    EditableTitle,
    EquipmentEditor,
    EquipmentPicker,
    LabelTip,
    Lock,
    Plus,
    ResourceWorkbench,
    TEMPLATE_CARDS,
    activeEquipment,
    addRole,
    allowedShells,
    brainNames,
    cancelDescEdit,
    checkOverflow,
    closeEquipment,
    commitDescEdit,
    copiedRole,
    copySources,
    current,
    currentPreset,
    descEditValue,
    descEditing,
    duplicateRole,
    effectivePermission,
    equipmentEditor,
    isDetailRole,
    isFixedPreset,
    isFixedRole,
    isLeader,
    isOverflowing,
    isPublicRole,
    isSeedPublicRoleSelected,
    mcpNames,
    mcpTokens,
    newRoleSourcePreset,
    newRoleSourceRole,
    newRoleType,
    onReferencePick,
    onSourceRolePick,
    openEquipment,
    permissionPreview,
    permissionTemplate,
    promptOptions,
    publicMode,
    publicPool,
    railItems,
    readOnly,
    ref,
    referencePool,
    referencePublicRole,
    referenceRolePick,
    removeImpact,
    removeRole,
    renameRole,
    resetNewRoleSource,
    roleMode,
    roleTokens,
    roles,
    selectedRole,
    senseNames,
    setBrain,
    setOverflowRef,
    setPermissionSection,
    sourceRoleOptions,
    startDescEdit,
    supportsTools,
    swapping,
    systemPromptModel,
    titleRef,
    toggleDetailRole,
    toggleLeader,
    toggleRoleMode,
    updateEquipment,
    validateRename,
  }
}
