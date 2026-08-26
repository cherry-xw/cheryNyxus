import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, toRaw, watch } from 'vue'
import { CopyDocument, Delete, Lock, Plus } from '@element-plus/icons-vue'
import type { ConfigDto } from '@/application/backend/public'
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

export type RolesTabControllerProps = { draft: ConfigDto; prompts: string[]; skillCatalog: SkillCatalog }
export type RolesTabControllerEmits = {
  (e: 'error', msg: string): void
  (e: 'mode-change', mode: RoleMode): void
}

export function useRolesTabController(props: RolesTabControllerProps, emit: RolesTabControllerEmits) {
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
  
  const removeImpact = computed(() => {
  
    const presetRefs = Object.values(props.draft.presets ?? {}).filter(
  
      (p) =>
  
        p.roles?.includes(selectedRole.value) ||
  
        p.shadows?.conversationRouting === selectedRole.value,
  
    ).length
  
    const lines: string[] = ['该角色的全部配置（大脑 / 器官 / 装备）将被移除。']
  
    if (presetRefs) lines.push(`${presetRefs} 个预设引用了本角色，将自动清理。`)
  
    return lines
  
  })
  
  const roles = computed(() => props.draft.roles ?? {})
  
  const filteredRoles = computed(() =>
  
    Object.fromEntries(
  
      Object.entries(roles.value).filter(([, cfg]) =>
  
        roleMode.value === 'shadow' ? cfg.kind === 'shadow' : cfg.kind !== 'shadow',
  
      ),
  
    ),
  
  )
  
  const current = computed(() => roles.value[selectedRole.value])
  
  const isFixedRole = computed(() => selectedRole.value === CHERY_NYXUS_ROLE)
  
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
  
      if (current.value) current.value.permissions = { ...current.value.permissions, template }
  
    },
  
  })
  
  // 生效结果预览：模板默认 + 显式覆盖的合并镜像，见 config/rolePermissions.ts
  
  const effectivePermission = computed(() => resolveEffectivePolicy(current.value?.permissions))
  
  const permissionPreview = computed(() => {
  
    const e = effectivePermission.value
  
    return [
  
      { key: 'read', label: '读', value: READ_LABELS[e.read] ?? e.read, customized: e.customized.read },
  
      { key: 'write', label: '写', value: WRITE_LABELS[e.write] ?? e.write, customized: e.customized.write },
  
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
  
      { key: 'mcp', label: 'MCP', value: EFFECT_LABELS[e.mcpDefault] ?? e.mcpDefault, customized: e.customized.mcpDefault },
  
      { key: 'spawn', label: '派遣', value: EFFECT_LABELS[e.spawnEffect] ?? e.spawnEffect, customized: e.customized.spawnEffect },
  
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
  
    if (!policy) return
  
    ;(policy as unknown as Record<string, unknown>)[section] = {
  
      ...((policy as unknown as Record<string, unknown>)[section] as Record<string, unknown> | undefined),
  
      [key]: value,
  
    }
  
  }
  
  const promptOptions = computed(() => buildPromptTree(props.prompts))
  
  // clearable 清空时 cascader emit 空串，归一为 undefined（= 无专属背景，仅用全局）
  
  const systemPromptModel = computed<string>({
  
    get: () => current.value?.systemPrompt ?? '',
  
    set: (v: string) => {
  
      if (current.value) current.value.systemPrompt = v || undefined
  
    },
  
  })
  
  // 角色说明：header 内注释样式 inline 编辑（锁定角色只读）；空串归一为 undefined
  
  const descEditing = ref(false)
  
  const descEditValue = ref('')
  
  const vFocus = { mounted: (el: HTMLElement) => el.querySelector('input')?.focus() }
  
  function startDescEdit(): void {
  
    if (current.value?.lock || isFixedRole.value) return
  
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
  
      computeSelectionTokens(cfg.skills, props.skillCatalog.skills, props.skillCatalog.skillTokens) +
  
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
  
        badge: cfg.lock ? '锁定' : roleTokens(cfg) > 5000 ? '高负重' : undefined,
  
        danger: !props.draft.llm.brain[cfg.brain],
  
      })),
  
  )
  
  function addRole(): void {
  
    const type = newRoleType.value.trim()
  
    if (!type) return
  
    if (!props.draft.roles) props.draft.roles = {}
  
    if (props.draft.roles[type]) {
  
      emit('error', `角色 "${type}" 已存在`)
  
      return
  
    }
  
    props.draft.roles[type] = {
  
      ...(roleMode.value === 'shadow' ? { kind: 'shadow' as const } : {}),
  
      brain: brainNames.value[0] ?? '',
  
      senseGroup:
  
        roleMode.value === 'shadow'
  
          ? (senseNames.value.find((name) =>
  
              (props.draft.sense_groups?.[name] ?? []).some((entry) =>
  
                entry.startsWith('select_conversation'),
  
              ),
  
            ) ??
  
            senseNames.value[0] ??
  
            '')
  
          : (senseNames.value[0] ?? ''),
  
    }
  
    newRoleType.value = ''
  
    selectedRole.value = type
  
  }
  
  function removeRole(type: string): void {
  
    if (!props.draft.roles || props.draft.roles[type]?.lock || type === CHERY_NYXUS_ROLE) return
  
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
  
      if (key === type) rebuilt[name] = structuredClone(toRaw(value))
  
    }
  
    props.draft.roles = rebuilt
  
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
  
    for (const [key, value] of Object.entries(props.draft.roles))
  
      rebuilt[key === oldType ? newType : key] = value
  
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
  
    if (isFixedRole.value && !supportsTools(brain)) return
  
    cfg.brain = brain
  
    if (!supportsTools(brain)) {
  
      cfg.senseGroup = ''
  
      cfg.mcpServers = []
  
    }
  
  }
  
  function openEquipment(kind: EquipmentKind): void {
  
    if (isFixedRole.value) return
  
    activeEquipment.value = kind
  
  }
  
  function closeEquipment(): void {
  
    activeEquipment.value = null
  
  }
  
  function updateEquipment(value: string[]): void {
  
    const cfg = current.value
  
    const kind = activeEquipment.value
  
    if (!cfg || !kind || isFixedRole.value) return
  
    cfg[kind] = value
  
  }
  
  watch(selectedRole, () => {
  
    closeEquipment()
  
    titleRef.value?.cancel()
  
  })
  
  function setRoleMode(mode: RoleMode): void {
  
    if (roleMode.value === mode) return
  
    roleMode.value = mode
  
    emit('mode-change', mode)
  
    selectedRole.value = Object.keys(filteredRoles.value)[0] ?? ''
  
  }
  
  // 卡牌换位：点击触发上卡向上 / 下卡向下分离；150ms 分离顶点（完全不重叠）翻转 roleMode，
  
  // z-index 随 is-front/is-back 同帧互换，再合拢成交叉换层后的姿态。期间连点忽略。
  
  let swapTimer = 0
  
  const swapping = ref(false)
  
  function toggleRoleMode(): void {
  
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
    AvatarPicker, ConfirmPopover, CopyDocument, Delete, EditableTitle, EquipmentEditor,
    EquipmentPicker, LabelTip, Lock, Plus, ResourceWorkbench, TEMPLATE_CARDS, activeEquipment,
    addRole, allowedShells, brainNames, cancelDescEdit, checkOverflow, closeEquipment,
    commitDescEdit, copiedRole, current, descEditValue, descEditing, duplicateRole,
    effectivePermission, equipmentEditor, isFixedRole, isOverflowing, mcpNames, mcpTokens,
    newRoleType, openEquipment, permissionPreview, permissionTemplate, promptOptions, railItems,
    ref, removeImpact, removeRole, renameRole, roleMode, roleTokens, roles, selectedRole,
    senseNames, setBrain, setOverflowRef, setPermissionSection, startDescEdit, supportsTools,
    swapping, systemPromptModel, titleRef, toggleRoleMode, updateEquipment, validateRename,
  }
}
