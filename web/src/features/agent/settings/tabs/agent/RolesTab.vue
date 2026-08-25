<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, toRaw, watch } from 'vue'
import { CopyDocument, Delete, Lock, Plus } from '@element-plus/icons-vue'
import type { ConfigDto } from '@/services/agentApi'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import EditableTitle from '@/components/input/EditableTitle.vue'
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

const CHERY_NYXUS_ROLE = 'cheryNyxus'

type RoleDraft = NonNullable<ConfigDto['roles']>[string]
type SkillCatalog = {
  skills: string[]
  plugins: string[]
  skillTokens: Record<string, number>
  pluginTokens: Record<string, number>
}

const props = defineProps<{ draft: ConfigDto; prompts: string[]; skillCatalog: SkillCatalog }>()
type RoleMode = 'role' | 'shadow'
const emit = defineEmits<{
  (e: 'error', msg: string): void
  (e: 'mode-change', mode: RoleMode): void
}>()
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
</script>

<template>
  <section class="roles-workspace">
    <p class="sect-hint">
      <template v-if="roleMode === 'role'">
        普通角色会进入团队、@ 菜单和节点树。点击左侧头像进入详情；技能、插件和 MCP
        支持继承、自选与全部关闭。
      </template>
      <template v-else>
        Shadow 只运行内部临时流程，不创建会话、Pet 或节点树，也不能成为组长、团队成员或 @ 目标。
      </template>
    </p>
    <div
      class="role-mode-stack"
      :class="{ 'is-swapping': swapping }"
      role="group"
      aria-label="角色类别"
    >
      <button
        type="button"
        class="role-kind-card is-ordinary"
        :class="{ 'is-front': roleMode === 'role', 'is-back': roleMode !== 'role' }"
        :aria-pressed="roleMode === 'role'"
        @click="toggleRoleMode"
      >
        普通角色
      </button>
      <button
        type="button"
        class="role-kind-card is-shadow"
        :class="{ 'is-front': roleMode === 'shadow', 'is-back': roleMode !== 'shadow' }"
        :aria-pressed="roleMode === 'shadow'"
        @click="toggleRoleMode"
      >
        影子角色
      </button>
    </div>
    <ResourceWorkbench
      v-model="selectedRole"
      :items="railItems"
      :search-placeholder="roleMode === 'shadow' ? '搜索影子角色' : '搜索普通角色'"
      :glow-rail="true"
    >
      <template #rail-actions>
        <el-popover trigger="click" placement="bottom-start" :width="230">
          <template #reference
            ><button
              type="button"
              class="rail-add"
              :aria-label="roleMode === 'shadow' ? '新增影子角色' : '新增普通角色'"
            >
              <Plus /></button
          ></template>
          <div class="new-role-pop">
            <el-input
              v-model="newRoleType"
              :placeholder="roleMode === 'shadow' ? '新 Shadow 类型名' : '新角色类型名'"
              @keydown.enter="addRole"
            /><button type="button" class="primary-btn" @click="addRole">创建</button>
          </div>
        </el-popover>
      </template>

      <article
        v-if="current"
        class="role-detail-card"
        :class="{ copied: copiedRole === selectedRole }"
      >
        <header class="role-identity">
          <AvatarPicker
            v-model="current.avatar"
            :role-type="selectedRole"
            :disabled="!!current.lock || isFixedRole"
            @error="emit('error', $event)"
          />
          <div class="role-title-zone">
            <EditableTitle
              ref="titleRef"
              class="role-name-edit"
              :model-value="selectedRole"
              :validate="validateRename"
              :disabled="!!current.lock || isFixedRole"
              @rename="(name: string) => renameRole(selectedRole, name)"
              @error="emit('error', $event)"
            >
              <template #actions>
                <button
                  v-if="!current.lock && !isFixedRole"
                  type="button"
                  class="icon-btn"
                  aria-label="复制角色"
                  @click="duplicateRole(selectedRole)"
                >
                  <CopyDocument class="ico" />
                </button>
                <button
                  v-if="current.lock || isFixedRole"
                  type="button"
                  class="icon-btn"
                  disabled
                  :title="
                    isFixedRole
                      ? '固定角色：仅可切换大脑'
                      : '角色已锁定：禁止改名/复制/改专属背景说明/改角色说明'
                  "
                >
                  <Lock class="ico" />
                </button>
                <ConfirmPopover
                  v-else
                  :title="`删除角色「${selectedRole}」？`"
                  :impact="removeImpact"
                  @confirm="removeRole(selectedRole)"
                >
                  <template #trigger>
                    <button type="button" class="icon-btn danger" aria-label="删除角色">
                      <Delete class="ico" />
                    </button>
                  </template>
                </ConfirmPopover>
              </template>
            </EditableTitle>
            <!-- 角色说明：header 内注释样式，点击 inline 编辑（锁定角色只读） -->
            <div class="role-desc-line">
              <span
                v-if="!descEditing"
                class="role-desc-text"
                :class="{ editable: !current.lock && !isFixedRole }"
                :title="current.lock || isFixedRole ? undefined : '点击编辑说明'"
                @click="startDescEdit"
                >{{
                  current.description || (current.lock || isFixedRole ? '—' : '点击添加角色说明')
                }}</span
              >
              <el-input
                v-else
                v-model="descEditValue"
                v-focus
                size="small"
                placeholder="角色说明（仅 UI 展示，不进 prompt）"
                @keydown.enter="commitDescEdit"
                @keydown.esc="cancelDescEdit"
                @blur="commitDescEdit"
              />
            </div>
            <div class="role-status-line">
              <span class="status-chip">系统负重 ≈ {{ roleTokens(current) }} token</span>
            </div>
          </div>
        </header>

        <section class="detail-section">
          <h3>运行核心</h3>
          <div class="core-field">
            <span>AI 大脑</span>
            <div class="choice-board">
              <button
                v-for="name in brainNames"
                :key="name"
                type="button"
                class="brain-choice"
                :disabled="isFixedRole && !supportsTools(name)"
                :class="{ active: current.brain === name }"
                :data-overflow-name="isOverflowing[`brain-name-${name}`] ? 'true' : undefined"
                :data-overflow-model="isOverflowing[`brain-model-${name}`] ? 'true' : undefined"
                @click="setBrain(current, name)"
              >
                <el-tooltip
                  :content="name"
                  placement="top"
                  :show-after="300"
                  :disabled="!isOverflowing[`brain-name-${name}`]"
                >
                  <b
                    :ref="(el) => setOverflowRef(el, `brain-name-${name}`)"
                    class="brain-choice-name"
                    @mouseenter="checkOverflow(`brain-name-${name}`, $event)"
                    >◈ {{ name }}</b
                  >
                </el-tooltip>
                <el-tooltip
                  :content="draft.llm.brain[name]?.model || '未配置模型'"
                  placement="bottom"
                  :show-after="300"
                  :disabled="!isOverflowing[`brain-model-${name}`]"
                >
                  <small
                    :ref="(el) => setOverflowRef(el, `brain-model-${name}`)"
                    class="brain-choice-model"
                    @mouseenter="checkOverflow(`brain-model-${name}`, $event)"
                    >{{ draft.llm.brain[name]?.model || '未配置模型' }}</small
                  >
                </el-tooltip>
              </button>
            </div>
          </div>
          <div class="core-field">
            <span>器官套装</span>
            <div class="choice-board compact">
              <button
                type="button"
                :disabled="isFixedRole"
                :class="{ active: !current.senseGroup }"
                @click="current.senseGroup = ''"
              >
                无</button
              ><button
                v-for="name in senseNames"
                :key="name"
                type="button"
                :disabled="isFixedRole || !supportsTools(current.brain)"
                :class="{ active: current.senseGroup === name }"
                @click="current.senseGroup = name"
              >
                {{ name }}
              </button>
            </div>
          </div>
          <div class="core-field">
            <span>专属背景说明</span>
            <el-cascader
              v-model="systemPromptModel"
              :options="promptOptions"
              :props="{ emitPath: false }"
              placeholder="无专属背景(仅全局)"
              filterable
              clearable
              :disabled="!!current.lock || isFixedRole"
              popper-class="role-prompt-cascader"
              class="prompt-cascader"
            />
          </div>
        </section>

        <section class="detail-section permission-section">
          <h3>行为权限</h3>
          <p class="permission-hint">器官套装决定角色能看到哪些工具；这里决定每次调用时直接放行、弹审批卡还是拒绝。修改从下一次调用生效。</p>
          <div class="perm-board-head">
            <LabelTip
              label="策略模板"
              :tip="'预设的安全基线，四档风险递增。\n下方覆盖项在模板基础上逐项调整，留空即继承模板值；切换模板会保留已设置的覆盖项。更细粒度的规则（按工具通配、命令风险分类）可手改 config.yaml。'"
            />
          </div>
          <div class="permission-template-board">
            <button
              v-for="card in TEMPLATE_CARDS"
              :key="card.value"
              type="button"
              class="tpl-card"
              :class="[`risk-${card.risk}`, { active: permissionTemplate === card.value }]"
              @click="permissionTemplate = card.value"
            >
              <b class="tpl-name"
                ><i class="risk-dot" />{{ card.label }}<em v-if="card.isDefault" class="tpl-default">默认</em></b
              >
              <small class="tpl-tagline">{{ card.tagline }}</small>
              <small class="tpl-summary">{{ card.summary }}</small>
            </button>
          </div>
          <div class="permission-groups">
            <div class="perm-group">
              <h4>文件</h4>
              <label class="perm-field" :class="{ customized: effectivePermission.customized.read }">
                <span class="perm-field-head">
                  <LabelTip
                    label="读取范围"
                    :tip="'角色读文件可触达的路径。\n工作区 = 会话工作区目录内；越出范围的读取直接拒绝。'"
                  />
                  <em v-if="effectivePermission.customized.read">已自定义</em>
                </span>
                <el-select :model-value="current.permissions?.filesystem?.read" placeholder="继承模板" clearable size="small" @update:model-value="(v: string | undefined) => setPermissionSection('filesystem', 'read', v)">
                  <el-option label="禁止" value="deny" /><el-option label="仅工作区" value="workspace" /><el-option label="任意路径" value="any" />
                </el-select>
              </label>
              <label class="perm-field" :class="{ customized: effectivePermission.customized.write }">
                <span class="perm-field-head">
                  <LabelTip
                    label="写入范围"
                    :tip="'角色写文件的范围。\n仅工作区内：区外一律拒绝；区内直写 · 区外需审核：工作区内直接写入，工作区外先弹审批卡确认。'"
                  />
                  <em v-if="effectivePermission.customized.write">已自定义</em>
                </span>
                <el-select :model-value="current.permissions?.filesystem?.write" placeholder="继承模板" clearable size="small" @update:model-value="(v: string | undefined) => setPermissionSection('filesystem', 'write', v)">
                  <el-option label="禁止" value="deny" /><el-option label="仅工作区内" value="workspace" /><el-option label="区内直写 · 区外需审核" value="any-with-approval" />
                </el-select>
              </label>
            </div>
            <div class="perm-group">
              <h4>命令</h4>
              <label class="perm-field" :class="{ customized: effectivePermission.customized.maxSandboxMode }">
                <span class="perm-field-head">
                  <LabelTip
                    label="最大沙箱权限"
                    :tip="'execute_command 的 OS 沙箱权限上限。\n命令分析器判定需要更高权限的命令会被直接拒绝而非降级执行；完全访问也仍运行在 OS 沙箱内。'"
                  />
                  <em v-if="effectivePermission.customized.maxSandboxMode">已自定义</em>
                </span>
                <el-select :model-value="current.permissions?.commands?.maxSandboxMode" placeholder="继承模板" clearable size="small" @update:model-value="(v: string | undefined) => setPermissionSection('commands', 'maxSandboxMode', v)">
                  <el-option label="只读沙箱" value="read-only" /><el-option label="工作区可写" value="workspace-write" /><el-option label="完全访问（仍经 OS 沙箱）" value="danger-full-access" />
                </el-select>
              </label>
              <div class="perm-field" :class="{ customized: effectivePermission.customized.shells }">
                <span class="perm-field-head">
                  <LabelTip
                    label="允许脚本方言"
                    :tip="'角色执行命令可用的 shell 方言。\n未勾选的方言调用会被直接拒绝。'"
                  />
                  <em v-if="effectivePermission.customized.shells">已自定义</em>
                </span>
                <el-checkbox-group v-model="allowedShells"><el-checkbox value="bash">Bash</el-checkbox><el-checkbox value="powershell">PowerShell</el-checkbox></el-checkbox-group>
              </div>
            </div>
            <div class="perm-group">
              <h4>集成</h4>
              <label class="perm-field" :class="{ customized: effectivePermission.customized.mcpDefault }">
                <span class="perm-field-head">
                  <LabelTip
                    label="MCP 默认"
                    :tip="'调用 MCP 工具的默认处置。\n继承 = 按模板与未知工具监管处理：受信模板放行，其余模板每次审核。'"
                  />
                  <em v-if="effectivePermission.customized.mcpDefault">已自定义</em>
                </span>
                <el-select :model-value="current.permissions?.mcp?.default" placeholder="继承模板" clearable size="small" @update:model-value="(v: string | undefined) => setPermissionSection('mcp', 'default', v)">
                  <el-option label="继承（按模板监管）" value="inherit" /><el-option label="允许" value="allow" /><el-option label="每次审核" value="ask" /><el-option label="拒绝" value="deny" />
                </el-select>
              </label>
              <label class="perm-field" :class="{ customized: effectivePermission.customized.spawnEffect }">
                <span class="perm-field-head">
                  <LabelTip
                    label="派遣角色"
                    :tip="'spawn_role 派遣子角色的处置。\n继承 = 按模板默认（只读模板拒绝，其余允许）。'"
                  />
                  <em v-if="effectivePermission.customized.spawnEffect">已自定义</em>
                </span>
                <el-select :model-value="current.permissions?.spawn?.effect" placeholder="继承模板" clearable size="small" @update:model-value="(v: string | undefined) => setPermissionSection('spawn', 'effect', v)">
                  <el-option label="继承（按模板）" value="inherit" /><el-option label="允许" value="allow" /><el-option label="每次审核" value="ask" /><el-option label="拒绝" value="deny" />
                </el-select>
              </label>
            </div>
          </div>
          <div class="effective-preview">
            <span class="preview-k">生效策略</span>
            <span
              v-for="dim in permissionPreview"
              :key="dim.key"
              class="preview-dim"
              :class="{ customized: dim.customized }"
              >{{ dim.label }} {{ dim.value }}<em v-if="dim.customized">自定义</em></span
            >
          </div>
        </section>

        <section class="detail-section">
          <h3>装备栏</h3>
          <div class="equipment-grid">
            <EquipmentPicker
              v-model="current.skills"
              label="技能"
              :options="skillCatalog.skills"
              :token-map="skillCatalog.skillTokens"
              :disabled="isFixedRole"
              @edit="openEquipment('skills')"
              @mode-change="closeEquipment"
            />
            <EquipmentPicker
              v-model="current.plugins"
              label="插件"
              :options="skillCatalog.plugins"
              :token-map="skillCatalog.pluginTokens"
              :disabled="isFixedRole"
              @edit="openEquipment('plugins')"
              @mode-change="closeEquipment"
            />
            <EquipmentPicker
              v-model="current.mcpServers"
              label="MCP 服务"
              :options="mcpNames"
              :token-map="mcpTokens"
              :disabled="isFixedRole"
              @edit="openEquipment('mcpServers')"
              @mode-change="closeEquipment"
            />
          </div>
          <EquipmentEditor
            v-if="equipmentEditor"
            :editor-key="`${selectedRole}:${equipmentEditor.key}`"
            :label="equipmentEditor.label"
            :model-value="equipmentEditor.value"
            :options="equipmentEditor.options"
            :token-map="equipmentEditor.tokenMap"
            @update:model-value="updateEquipment"
            @close="closeEquipment"
          />
          <div class="equipment-roster" :class="{ 'equipment-editing': !!activeEquipment }">
            <div class="roster-row">
              <span class="roster-k">技能</span>
              <span v-if="!current.skills" class="roster-empty">继承全部</span>
              <span v-else-if="!current.skills.length" class="roster-empty">已关闭</span>
              <span v-for="name in current.skills" :key="`sk-${name}`" class="roster-tag"
                >{{ name
                }}<small v-if="skillCatalog.skillTokens[name]">
                  ≈{{ skillCatalog.skillTokens[name] }}</small
                ></span
              >
            </div>
            <div class="roster-row">
              <span class="roster-k">插件</span>
              <span v-if="!current.plugins" class="roster-empty">继承全部</span>
              <span v-else-if="!current.plugins.length" class="roster-empty">已关闭</span>
              <span v-for="name in current.plugins" :key="`pl-${name}`" class="roster-tag"
                >{{ name
                }}<small v-if="skillCatalog.pluginTokens[name]">
                  ≈{{ skillCatalog.pluginTokens[name] }}</small
                ></span
              >
            </div>
            <div class="roster-row">
              <span class="roster-k">MCP</span>
              <span v-if="!current.mcpServers" class="roster-empty">继承全部</span>
              <span v-else-if="!current.mcpServers.length" class="roster-empty">已关闭</span>
              <span v-for="name in current.mcpServers" :key="`mc-${name}`" class="roster-tag"
                >{{ name }}<small v-if="mcpTokens[name]"> ≈{{ mcpTokens[name] }}</small></span
              >
            </div>
          </div>
        </section>
      </article>
    </ResourceWorkbench>
  </section>
</template>

<style scoped lang="less">
@import '../../config/shared.less';
.roles-workspace {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.roles-workspace :deep(.resource-workbench) {
  flex: 1;
}
.permission-hint { margin: 0 0 8px; color: color-mix(in srgb, var(--ink) 58%, transparent); font-size: 10px; }
.perm-board-head { margin: -2px 0 4px; }
// 模板卡片：风险色点 + 定位句 + 维度摘要，选中态对齐 choice-board active 的视觉语言
.permission-template-board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(158px, 1fr));
  gap: 5px;
}
.tpl-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 7px 9px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 8px;
  background: var(--surface);
  color: color-mix(in srgb, var(--ink) 70%, transparent);
  text-align: left;
  cursor: pointer;
  min-width: 0;
  &:hover {
    border-color: color-mix(in srgb, var(--tab-color, @accent) 40%, transparent);
  }
  &.active {
    border-color: color-mix(in srgb, var(--tab-color, @accent) 55%, transparent);
    background: color-mix(in srgb, var(--tab-color, @accent) 16%, transparent);
    color: color-mix(in srgb, var(--tab-color, @accent) 75%, var(--ink));
  }
  &:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--tab-color, @accent) 55%, transparent);
    outline-offset: 2px;
  }
}
.tpl-name {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
}
.risk-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex: none;
}
.tpl-card.risk-0 .risk-dot { background: #34d399; }
.tpl-card.risk-1 .risk-dot { background: #fbbf24; }
.tpl-card.risk-2 .risk-dot { background: #fb923c; }
.tpl-card.risk-3 .risk-dot { background: #f87171; }
.tpl-default {
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--tab-color, @accent) 16%, transparent);
  font-size: 9px;
  font-style: normal;
  font-weight: 600;
}
.tpl-tagline {
  font-size: 10px;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
}
.tpl-summary {
  font-size: 9px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--ink) 52%, transparent);
  word-break: break-all;
}
// 覆盖项三组（文件 / 命令 / 集成）：label 挂 LabelTip，自定义时点亮主题色标记
.permission-groups {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.perm-group {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 7px 8px;
  border: 1px dashed color-mix(in srgb, var(--ink) 10%, transparent);
  border-radius: 8px;
  h4 {
    margin: 0;
    font-size: 10px;
    font-weight: 600;
    color: color-mix(in srgb, var(--ink) 60%, transparent);
  }
}
.perm-field {
  display: grid;
  gap: 3px;
  font-size: 10px;
}
.perm-field-head {
  display: flex;
  align-items: center;
  gap: 5px;
  em {
    font-size: 9px;
    font-style: normal;
    font-weight: 600;
    color: var(--tab-color, @accent);
    &::before {
      content: '';
      display: inline-block;
      width: 5px;
      height: 5px;
      margin-right: 3px;
      border-radius: 999px;
      background: currentColor;
      vertical-align: 1px;
    }
  }
}
.perm-field .el-checkbox-group {
  display: flex;
  gap: 4px;
  min-height: 24px;
  align-items: center;
}
// 生效结果预览条：常驻展示模板 + 覆盖合并结果，自定义维度主题色高亮
.effective-preview {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  padding: 7px 9px;
  border: 1px solid color-mix(in srgb, var(--ink) 11%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface) 55%, transparent);
  font-size: 10px;
}
.preview-k {
  font-weight: 400;
  color: color-mix(in srgb, var(--ink) 62%, transparent);
}
.preview-dim {
  color: color-mix(in srgb, var(--ink) 66%, transparent);
  &.customized {
    font-weight: 400;
    color: color-mix(in srgb, var(--tab-color, @accent) 82%, @ink);
  }
  em {
    margin-left: 3px;
    font-size: 9px;
    font-style: normal;
    opacity: 0.85;
  }
}
.role-mode-stack {
  position: relative;
  width: 142px;
  height: 39px;
  flex: none;
  margin: 0 8px 2px;
}
.role-kind-card {
  position: absolute;
  inset: 0;
  width: 134px;
  height: 29px;
  padding: 0 12px;
  border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 8px;
  background: var(--surface);
  color: color-mix(in srgb, var(--ink) 72%, transparent);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transform-origin: center;
  transition:
    transform 220ms cubic-bezier(0.77, 0, 0.175, 1),
    background-color 180ms ease,
    border-color 180ms ease,
    color 180ms ease,
    box-shadow 180ms ease;
  &.is-front {
    z-index: 2;
    transform: translate3d(0, 0, 0) rotate(0) scale(1);
    border-color: color-mix(in srgb, var(--tab-color, @accent) 52%, transparent);
    background: color-mix(in srgb, var(--tab-color, @accent) 14%, var(--surface));
    color: color-mix(in srgb, var(--tab-color, @accent) 82%, var(--ink));
    box-shadow: 0 5px 12px color-mix(in srgb, var(--tab-color, @accent) 15%, transparent);
  }
  &.is-back {
    z-index: 1;
  }
  &.is-ordinary.is-back {
    transform: translate3d(-8px, 10px, 0) rotate(-1.5deg) scale(0.97);
  }
  &.is-shadow.is-back {
    transform: translate3d(8px, 10px, 0) rotate(1.5deg) scale(0.97);
  }
  &:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--tab-color, @accent) 55%, transparent);
    outline-offset: 2px;
  }
}
// 卡牌换位分离段：上层卡向上、下层卡向下各拉 14px（合计 28px > 19px 竖向重叠高度，保证完全不重叠）；
// JS 在 150ms 分离顶点翻转 roleMode，z-index 随 is-front/is-back 同帧互换后按基础 220ms 合拢交叉换层。
// 减弱动态偏好下跳过分离位移，仅保留原有小位移过渡。
@media (prefers-reduced-motion: no-preference) {
  .role-mode-stack.is-swapping .role-kind-card {
    transition-duration: 140ms;
    &.is-front {
      transform: translate3d(0, -14px, 0);
    }
    &.is-ordinary.is-back {
      transform: translate3d(-8px, 24px, 0) rotate(-1.5deg) scale(0.97);
    }
    &.is-shadow.is-back {
      transform: translate3d(8px, 24px, 0) rotate(1.5deg) scale(0.97);
    }
  }
}
.rail-add {
  width: 27px;
  height: 27px;
  border: 1px solid color-mix(in srgb, var(--tab-color, @accent) 38%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--tab-color, @accent) 14%, transparent);
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
  cursor: pointer;
}
.rail-add svg {
  width: 13px;
}
.new-role-pop {
  display: flex;
  gap: 5px;
}
.primary-btn {
  border: 0;
  border-radius: 6px;
  background: var(--tab-color, @accent);
  font-weight: 600;
  cursor: pointer;
  padding: 0 11px;
}
.role-detail-card {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.role-detail-card.copied {
  animation: role-spawn 0.65s ease-out;
}
.role-identity {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 11px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 12px;
  background: var(--surface-soft);
}
.role-title-zone {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

// 角色名超长：单行省略 + 原生 title 兜底显示完整名
.role-name-edit {
  max-width: 100%;
  min-width: 0;
  .card-name {
    display: block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    &.editable {
      display: block;
    }
  }
}
.role-name-edit-tooltip {
  max-width: 240px;
  white-space: normal;
  line-height: 1.45;
  word-break: break-word;
}
.role-status-line {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.role-desc-line {
  margin-top: 3px;
  min-height: 16px;
  max-width: 100%;
}
.role-desc-text {
  display: inline-block;
  max-width: 100%;
  font-size: 11px;
  line-height: 1.4;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
  word-break: break-word;
  &.editable {
    cursor: text;
    border-radius: 4px;
    &:hover {
      color: color-mix(in srgb, var(--ink) 68%, transparent);
      background: color-mix(in srgb, var(--tab-color, @accent) 8%, transparent);
    }
  }
}
.status-chip {
  padding: 2px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--tab-color, @accent) 14%, transparent);
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
  font-size: 10px;
  font-weight: 600;
}
.detail-section {
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--ink) 11%, transparent);
  border-radius: 10px;
  background: var(--surface-soft);
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.detail-section h3 {
  margin: 0;
  font-size: 12px;
  color: color-mix(in srgb, var(--ink) 68%, transparent);
}
.core-field {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  align-items: start;
  gap: 7px;
}
.core-field > span {
  padding-top: 6px;
  font-size: 10px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 70%, transparent);
}
.choice-board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 5px;
}
.choice-board.compact {
  display: flex;
  flex-wrap: wrap;
}
.choice-board button {
  min-height: 38px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 8px;
  background: var(--surface);
  color: color-mix(in srgb, var(--ink) 70%, transparent);
  cursor: pointer;
  min-width: 0;
  overflow: hidden;
}

.brain-choice-name,
.brain-choice-model {
  display: block;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.brain-choice-name {
  font-size: 12px;
  font-weight: 600;
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
}

.brain-choice-model {
  font-size: 10px;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
  font-weight: 400;
}
.choice-board.compact button {
  min-height: 26px;
  padding: 3px 10px;
}
.choice-board button.active {
  border-color: color-mix(in srgb, var(--tab-color, @accent) 55%, transparent);
  background: color-mix(in srgb, var(--tab-color, @accent) 16%, transparent);
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
}
.choice-board small {
  font-size: 9px;
  color: color-mix(in srgb, var(--ink) 64%, transparent);
}
.prompt-cascader {
  width: 100%;
  // 覆盖 element 默认主题色 #f6b73c（黄）为角色 tab 粉；trigger 区（输入框 focus/hover 边框、清除图标）
  --el-color-primary: #fb7185;
}
.equipment-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}
.equipment-roster {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 8px;
  padding: 8px;
  border: 1px dashed color-mix(in srgb, var(--ink) 10%, transparent);
  border-radius: 8px;
  // 主题自适应底：深色时为深灰而非硬编码白 32%（白底 + 白字不可读）
  background: color-mix(in srgb, var(--surface) 55%, transparent);
}
// 装备整理面板展开时，给装备栏胶囊加主题色发光，提示正在编辑这一栏。
.equipment-roster.equipment-editing {
  border-color: color-mix(in srgb, var(--tab-color, @accent) 50%, transparent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--tab-color, @accent) 16%, transparent);
}
.roster-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-height: 20px;
}
.roster-k {
  flex: none;
  width: 32px;
  font-size: 10px;
  font-weight: 400;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
}
.roster-tag {
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--tab-color, @accent) 12%, transparent);
  font-size: 10px;
  color: color-mix(in srgb, var(--tab-color, @accent) 88%, @ink);
}
.roster-tag small {
  font-size: 9px;
  opacity: 0.9;
}
.roster-empty {
  font-size: 10px;
  color: color-mix(in srgb, var(--ink) 62%, transparent);
  font-style: italic;
}
@keyframes role-spawn {
  0% {
    transform: translateY(10px);
    opacity: 0.2;
  }
  55% {
    transform: translateY(-2px);
  }
  100% {
    transform: none;
    opacity: 1;
  }
}
@media (max-width: 950px) {
  .equipment-grid {
    grid-template-columns: 1fr;
  }
  .permission-groups {
    grid-template-columns: 1fr;
  }
  .core-field {
    grid-template-columns: 1fr;
  }
  .core-field > span {
    padding: 0;
  }
}
</style>

<style lang="less">
// cascader 下拉面板 teleport 到 body，scoped 够不着；用 popper-class 注入粉色覆盖默认主题黄
.role-prompt-cascader {
  --el-color-primary: #fb7185;
}
</style>
