<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue'
import { CopyDocument, Delete, Lock, Plus, Search } from '@element-plus/icons-vue'
import type { ConfigDto } from '@/services/agentApi'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import EditableTitle from '@/components/input/EditableTitle.vue'
import ResourceWorkbench, { type ResourceRailItem } from './ResourceWorkbench.vue'
import AvatarPicker from './AvatarPicker.vue'
import EquipmentPicker from '../../controls/EquipmentPicker.vue'
import EquipmentEditor from '../../controls/EquipmentEditor.vue'
import { resolveRoleAvatar } from '../../config/roleAvatar'
import { computeSelectionTokens } from '../../config/shared'

type RoleDraft = NonNullable<ConfigDto['roles']>[string]
type SkillCatalog = {
  skills: string[]
  plugins: string[]
  skillTokens: Record<string, number>
  pluginTokens: Record<string, number>
}

const props = defineProps<{ draft: ConfigDto; prompts: string[]; skillCatalog: SkillCatalog }>()
const emit = defineEmits<{ (e: 'error', msg: string): void }>()
const selectedRole = ref('')
const newRoleType = ref('')
const promptSearch = ref('')
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
  const presetRefs = Object.values(props.draft.presets ?? {}).filter((p) =>
    p.roles?.includes(selectedRole.value),
  ).length
  const lines: string[] = ['该角色的全部配置（大脑 / 器官 / 装备）将被移除。']
  if (presetRefs) lines.push(`${presetRefs} 个预设引用了本角色，将自动清理。`)
  return lines
})

const roles = computed(() => props.draft.roles ?? {})
const current = computed(() => roles.value[selectedRole.value])
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
const filteredPrompts = computed(() => {
  const q = promptSearch.value.trim().toLowerCase()
  return props.prompts.filter((path) => !q || path.toLowerCase().includes(q))
})

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
const railItems = computed<ResourceRailItem[]>(() =>
  Object.entries(roles.value).map(([type, cfg]) => ({
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
    brain: brainNames.value[0] ?? '',
    senseGroup: senseNames.value[0] ?? '',
  }
  newRoleType.value = ''
  selectedRole.value = type
}
function removeRole(type: string): void {
  if (!props.draft.roles || props.draft.roles[type]?.lock) return
  delete props.draft.roles[type]
  for (const preset of Object.values(props.draft.presets ?? {})) {
    preset.roles = preset.roles?.filter((name) => name !== type)
    if (preset.leader === type) preset.leader = ''
  }
}
function duplicateRole(type: string): void {
  if (!props.draft.roles?.[type]) return
  let name = `${type}_copy`
  let suffix = 2
  while (props.draft.roles[name]) name = `${type}_copy_${suffix++}`
  const rebuilt: NonNullable<ConfigDto['roles']> = {}
  for (const [key, value] of Object.entries(props.draft.roles)) {
    rebuilt[key] = value
    if (key === type) rebuilt[name] = structuredClone(value)
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
  if (!props.draft.roles?.[oldType]) return
  const rebuilt: NonNullable<ConfigDto['roles']> = {}
  for (const [key, value] of Object.entries(props.draft.roles))
    rebuilt[key === oldType ? newType : key] = value
  props.draft.roles = rebuilt
  for (const preset of Object.values(props.draft.presets ?? {})) {
    preset.roles = preset.roles?.map((name) => (name === oldType ? newType : name))
    if (preset.leader === oldType) preset.leader = newType
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
  cfg.brain = brain
  if (!supportsTools(brain)) {
    cfg.senseGroup = ''
    cfg.mcpServers = []
  }
}

function openEquipment(kind: EquipmentKind): void {
  activeEquipment.value = kind
}

function closeEquipment(): void {
  activeEquipment.value = null
}

function updateEquipment(value: string[]): void {
  const cfg = current.value
  const kind = activeEquipment.value
  if (!cfg || !kind) return
  cfg[kind] = value
}

watch(selectedRole, closeEquipment)
</script>

<template>
  <section class="roles-workspace">
    <p class="sect-hint">
      像管理小队装备一样配置角色。点击左侧头像进入详情；技能、插件和 MCP 支持继承、自选与全部关闭。
    </p>
    <ResourceWorkbench
      v-model="selectedRole"
      :items="railItems"
      search-placeholder="搜索角色"
      :glow-rail="true"
    >
      <template #rail-actions>
        <el-popover trigger="click" placement="bottom-start" :width="230">
          <template #reference
            ><button type="button" class="rail-add" aria-label="新增角色"><Plus /></button
          ></template>
          <div class="new-role-pop">
            <el-input
              v-model="newRoleType"
              placeholder="新角色类型名"
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
            @error="emit('error', $event)"
          />
          <div class="role-title-zone">
            <EditableTitle
              ref="titleRef"
              class="role-name-edit"
              :model-value="selectedRole"
              :validate="validateRename"
              @rename="(name: string) => renameRole(selectedRole, name)"
              @error="emit('error', $event)"
            >
              <template #actions>
                <button
                  type="button"
                  class="icon-btn"
                  aria-label="复制角色"
                  @click="duplicateRole(selectedRole)"
                >
                  <CopyDocument class="ico" />
                </button>
                <button
                  v-if="current.lock"
                  type="button"
                  class="icon-btn"
                  disabled
                  title="角色已锁定"
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
                  :content="draft.llm.brain[name]?.model || '未配置型号'"
                  placement="bottom"
                  :show-after="300"
                  :disabled="!isOverflowing[`brain-model-${name}`]"
                >
                  <small
                    :ref="(el) => setOverflowRef(el, `brain-model-${name}`)"
                    class="brain-choice-model"
                    @mouseenter="checkOverflow(`brain-model-${name}`, $event)"
                    >{{ draft.llm.brain[name]?.model || '未配置型号' }}</small
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
                :class="{ active: !current.senseGroup }"
                @click="current.senseGroup = ''"
              >
                无</button
              ><button
                v-for="name in senseNames"
                :key="name"
                type="button"
                :disabled="!supportsTools(current.brain)"
                :class="{ active: current.senseGroup === name }"
                @click="current.senseGroup = name"
              >
                {{ name }}
              </button>
            </div>
          </div>
          <div class="core-field">
            <span>专属背景说明</span>
            <el-popover trigger="click" placement="bottom-start" :width="420">
              <template #reference
                ><button type="button" class="prompt-trigger">
                  {{ current.systemPrompt || '使用全局 system_prompt' }}
                </button></template
              >
              <div class="prompt-picker">
                <el-input v-model="promptSearch" clearable placeholder="搜索提示词"
                  ><template #prefix><Search class="prompt-search-icon" /></template></el-input
                ><button
                  type="button"
                  :class="{ active: !current.systemPrompt }"
                  @click="current.systemPrompt = undefined"
                >
                  使用全局</button
                ><button
                  v-for="path in filteredPrompts"
                  :key="path"
                  type="button"
                  :class="{ active: current.systemPrompt === path }"
                  @click="current.systemPrompt = path"
                >
                  {{ path }}
                </button>
              </div>
            </el-popover>
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
              :editing="activeEquipment === 'skills'"
              @edit="openEquipment('skills')"
              @mode-change="closeEquipment"
            />
            <EquipmentPicker
              v-model="current.plugins"
              label="插件"
              :options="skillCatalog.plugins"
              :token-map="skillCatalog.pluginTokens"
              :editing="activeEquipment === 'plugins'"
              @edit="openEquipment('plugins')"
              @mode-change="closeEquipment"
            />
            <EquipmentPicker
              v-model="current.mcpServers"
              label="MCP 服务"
              :options="mcpNames"
              :token-map="mcpTokens"
              :editing="activeEquipment === 'mcpServers'"
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
          <div class="equipment-roster">
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
  font-weight: 800;
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
  border: 1px solid rgba(36, 38, 45, 0.12);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.58);
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
.status-chip {
  padding: 2px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--tab-color, @accent) 14%, transparent);
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
  font-size: 10px;
  font-weight: 700;
}
.detail-section {
  padding: 10px;
  border: 1px solid rgba(36, 38, 45, 0.11);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.42);
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.detail-section h3 {
  margin: 0;
  font-size: 12px;
  color: fade(@ink, 68%);
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
  font-weight: 800;
  color: fade(@ink, 54%);
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
  border: 1px solid rgba(36, 38, 45, 0.12);
  border-radius: 8px;
  background: #fff;
  color: fade(@ink, 70%);
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
  font-weight: 800;
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
}

.brain-choice-model {
  font-size: 10px;
  color: fade(@ink, 50%);
  font-weight: 500;
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
  color: fade(@ink, 45%);
}
.prompt-trigger {
  width: 100%;
  height: 29px;
  border: 1px dashed rgba(36, 38, 45, 0.2);
  border-radius: 7px;
  background: #fff;
  text-align: left;
  padding: 0 9px;
  color: fade(@ink, 68%);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prompt-picker {
  max-height: 330px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.prompt-picker > button {
  min-height: 29px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  padding: 4px 7px;
  cursor: pointer;
}
.prompt-picker > button:hover,
.prompt-picker > button.active {
  background: color-mix(in srgb, var(--tab-color, @accent) 15%, transparent);
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
}
.prompt-search-icon {
  width: 12px;
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
  border: 1px dashed rgba(36, 38, 45, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.32);
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
  font-weight: 800;
  color: fade(@ink, 50%);
}
.roster-tag {
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--tab-color, @accent) 12%, transparent);
  font-size: 10px;
  color: color-mix(in srgb, var(--tab-color, @accent) 76%, @ink);
}
.roster-tag small {
  font-size: 9px;
  opacity: 0.7;
}
.roster-empty {
  font-size: 10px;
  color: fade(@ink, 40%);
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
  .core-field {
    grid-template-columns: 1fr;
  }
  .core-field > span {
    padding: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .role-detail-card.copied {
    animation: none;
  }
}
</style>
