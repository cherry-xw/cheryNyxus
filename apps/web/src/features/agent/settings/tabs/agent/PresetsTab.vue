<script setup lang="ts">
/**
 * PresetsTab：预设与角色统一管理（config.presets + config.roles）。
 * 合并自原「预设」与「角色」两个一级 Tab：
 *  - 外层：预设卡片列表（TabShell + 序号导航），卡片上「编辑角色」进入该预设的角色工作台。
 *  - 内层：角色工作台（RolesTab），只管理本预设引用的角色成员；新增角色即成为本预设成员。
 * 数据层阶段一仍沿用 config.roles 全局字典 + config.presets.<name>.roles 引用数组过渡，
 * 界面以「角色归属当前预设」的心智呈现；config 结构内嵌属于阶段二（另行规划）。
 */
import { computed, ref } from 'vue'
import { Check, Delete, Lock, User, WarningFilled } from '@element-plus/icons-vue'
import type { ConfigDto, SenseToolInfo } from '@/application/backend/public'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import EditableTitle from '@/features/agent/settings/controls/EditableTitle.vue'
import LabelTip from '../config/LabelTip.vue'
import RolesTab from './RolesTab.vue'
import { resolveRoleAvatar } from '../../config/roleAvatar'
import SenseIcon from '../tools/SenseIcon.vue'
import { isPublicRole, listPublicRoles } from './publicRole'
import TabShell, { type IndexItem } from '@/features/agent/settings/components/TabShell.vue'
import WorkspaceDirBrowser from './WorkspaceDirBrowser.vue'
import { uuid } from '@/utils/uuid'

/** 角色工作台所需技能目录（与 RolesTabControllerProps.skillCatalog 同构）。 */
type SkillCatalog = {
  skills: string[]
  plugins: string[]
  skillTokens: Record<string, number>
  pluginTokens: Record<string, number>
}

const props = defineProps<{
  draft: ConfigDto
  /** .chery/prompt/ 下 .md 路径清单（角色专属背景级联选择器用）。 */
  prompts: string[]
  /** 技能/插件名称与 token 目录（角色装备选择器用）。 */
  skillCatalog: SkillCatalog
  senseTools: SenseToolInfo[]
  /** .chery/rule/ 下覆盖文件名清单（排除 base.yaml 基准），规则文件下拉选项。 */
  rules: string[]
  /** 后端 config.save 返回的 workspace 校验告警，按 presetName 索引，显示在对应 workspace 输入框下方。 */
  workspaceWarnings?: Record<string, string>
}>()
const emit = defineEmits<{
  (e: 'error', msg: string): void
  (e: 'workspaceChange', presetName: string, workspace: string | undefined): void
  /** 规则文件下拉刷新：SettingsDialog 重新拉取 rules.list（手动新建/cheryNyxus 生成后立即可见）。 */
  (e: 'refreshRules'): void
}>()

const newPresetName = ref('')
const CHERY_NYXUS_PRESET = 'cheryNyxus'
/** 预设 Tab 内部视图：列表 ↔ 某预设的角色工作台 ↔ 公共角色管理。 */
const view = ref<'list' | 'workbench' | 'public'>('list')
/** 当前正在编辑角色的预设名。 */
const activePreset = ref('')

/** 公共角色池（scope==='public' 或固定预设的非锁定普通成员角色）。 */
const publicRoles = computed(() => listPublicRoles(props.draft))

const shadowRoles = computed(() =>
  Object.fromEntries(
    Object.entries(props.draft.roles ?? {}).filter(([, role]) => role.kind === 'shadow'),
  ),
)

function isFixedPreset(name: string): boolean {
  return name === CHERY_NYXUS_PRESET
}

function openWorkbench(pname: string): void {
  activePreset.value = pname
  view.value = 'workbench'
}

function closeWorkbench(): void {
  view.value = 'list'
  activePreset.value = ''
}

function openPublicRoles(): void {
  view.value = 'public'
}

function closePublicRoles(): void {
  view.value = 'list'
}

function removeImpact(pname: string): string[] {
  const preset = props.draft.presets?.[pname]
  const roleCount = preset?.roles?.length ?? 0
  return [
    `预设「${pname}」将被删除。`,
    roleCount ? `${roleCount} 个角色成员将从本预设移除（角色配置保留，可在其他预设或角色工作台继续管理）。` : '（无成员）',
  ]
}

function onError(msg: string): void {
  emit('error', msg)
}

function addPreset(): void {
  const name = newPresetName.value.trim()
  if (!name) return
  if (!props.draft.presets) props.draft.presets = {}
  if (props.draft.presets[name]) {
    emit('error', `预设 "${name}" 已存在`)
    return
  }
  // 初始化：空组长 + 空成员。进入工作台后添加角色成员并指定组长（后端校验组长必填）。
  props.draft.presets[name] = {
    id: `preset-${uuid().replaceAll('-', '')}`,
    leader: '',
    roles: [],
  }
  newPresetName.value = ''
}

function removePreset(name: string): void {
  if (!props.draft.presets || isFixedPreset(name)) return
  delete props.draft.presets[name]
}

/** 改名：保序重建 presets。 */
function renamePreset(oldName: string, newName: string): void {
  if (!props.draft.presets || isFixedPreset(oldName)) return
  const cfg = props.draft.presets[oldName]
  const rebuilt = {} as typeof props.draft.presets
  for (const [k, v] of Object.entries(props.draft.presets)) {
    if (k === oldName) rebuilt[newName] = cfg!
    else rebuilt[k] = v
  }
  props.draft.presets = rebuilt
  emit('error', '')
}
function validateRename(newName: string): string | null {
  if (!props.draft.presets) return null
  return props.draft.presets[newName] ? `预设 "${newName}" 已存在` : null
}

function setConversationRoutingShadow(pname: string, value: string): void {
  const preset = props.draft.presets?.[pname]
  if (!preset) return
  if (!value) {
    if (preset.shadows) preset.shadows.conversationRouting = undefined
    return
  }
  preset.shadows ??= {}
  preset.shadows.conversationRouting = value
}

type RolePickerMode = 'leader' | 'detail'
/** 每预设当前职责指定模式（组长 / 解释角色），与成员卡点击联动。 */
const rolePickerModes = ref<Record<string, RolePickerMode>>({})

function rolePickerMode(pname: string): RolePickerMode {
  return rolePickerModes.value[pname] ?? 'leader'
}

function setRolePickerMode(pname: string, mode: RolePickerMode): void {
  if (isFixedPreset(pname) && mode === 'leader') return
  rolePickerModes.value[pname] = mode
}

/** 点击已选成员卡设为组长；组长不能是公共角色（后端校验），固定预设组长不可调整。 */
function setLeader(pname: string, role: string): void {
  const p = props.draft.presets?.[pname]
  if (!p || isFixedPreset(pname)) return
  if (isPublicRole(props.draft.roles, props.draft.presets, role)) return
  if (!(p.roles ?? []).includes(role)) p.roles = [...(p.roles ?? []), role]
  p.leader = role
  if (p.detailRole === role) p.detailRole = undefined
}

function setDetailRole(pname: string, role: string): void {
  const p = props.draft.presets?.[pname]
  if (!p || p.leader === role || !(p.roles ?? []).includes(role)) return
  p.detailRole = p.detailRole === role ? undefined : role
}

function selectRoleDuty(pname: string, role: string): void {
  if (rolePickerMode(pname) === 'detail') setDetailRole(pname, role)
  else setLeader(pname, role)
}

/** 每预设的绝对路径格式错误提示（前端即时校验；存在性由后端 validateWorkspace RPC 校验）。 */
const workspaceFormatErrors = ref<Record<string, string>>({})

/** 绝对路径格式校验：POSIX `/` 开头；Windows `C:\`、`C:/` 或 UNC `\\server\share`。 */
function isAbsolutePathFormat(p: string): boolean {
  return /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p)
}

/** 输入与目录选择共用：写 draft 后立刻通知外壳按该预设单独校验；前端同时做绝对路径格式校验。 */
function updateWorkspace(pname: string, value: string): void {
  const p = props.draft.presets?.[pname]
  if (!p) return
  p.workspace = value || undefined
  if (p.workspace && !isAbsolutePathFormat(p.workspace)) {
    workspaceFormatErrors.value[pname] =
      '路径格式不正确：请填绝对路径（POSIX `/xxx` 或 Windows `C:\\xxx`）'
  } else {
    delete workspaceFormatErrors.value[pname]
  }
  emit('workspaceChange', pname, p.workspace)
}

/** 服务端文件夹浏览弹层（全模式可用；选中目录走 updateWorkspace 同一链路）。 */
const browserOpenFor = ref<string | null>(null)
const browserOpen = computed({
  get: () => browserOpenFor.value !== null,
  set: (v: boolean) => {
    if (!v) browserOpenFor.value = null
  },
})
function openBrowser(pname: string): void {
  browserOpenFor.value = pname
}
function onBrowserSelect(path: string): void {
  if (browserOpenFor.value) updateWorkspace(browserOpenFor.value, path)
  browserOpenFor.value = null
}

/** 序号按钮列表：每预设一项。brief 给 mini popper 用（角色数 + 组长 + 媒体服务）。 */
const indexItems = computed<IndexItem[]>(() => {
  const presets = props.draft.presets ?? {}
  return Object.entries(presets).map(([pname, p]) => ({
    label: pname,
    count: (p.roles ?? []).length,
    leader: p.leader || '未指定',
    detailRole: p.detailRole || '未指定',
    workspace: p.workspace || '未限定',
  }))
})
</script>

<template>
  <div class="presets-tab-root">
    <!-- 内层：角色工作台（某预设） -->
    <div v-if="view === 'workbench'" class="preset-workbench">
      <div class="workbench-nav">
        <button type="button" class="back-btn" aria-label="返回预设列表" @click="closeWorkbench">
          ← 返回预设列表
        </button>
        <span class="workbench-title">预设「{{ activePreset }}」的角色</span>
        <span class="workbench-sub">管理本预设的角色成员；新增角色即成为本预设成员</span>
      </div>
      <RolesTab
        class="preset-roles-host"
        :draft="draft"
        :prompts="prompts"
        :skill-catalog="skillCatalog"
        :preset="activePreset"
        @error="onError"
      />
    </div>

    <!-- 内层：公共角色管理视图（全局维护层） -->
    <div v-else-if="view === 'public'" class="preset-workbench">
      <div class="workbench-nav">
        <button type="button" class="back-btn" aria-label="返回预设列表" @click="closePublicRoles">
          ← 返回预设列表
        </button>
        <span class="workbench-title">公共角色</span>
        <span class="workbench-sub"
          >全局共享的基础角色：任意预设可引用；配置改动对所有引用它的预设生效</span
        >
      </div>
      <RolesTab
        class="preset-roles-host"
        :draft="draft"
        :prompts="prompts"
        :skill-catalog="skillCatalog"
        mode="public"
        @error="onError"
      />
    </div>

    <!-- 外层：预设列表 -->
    <TabShell v-else tab-key="presets" :index-items="indexItems">
      <template #hints>
        <p class="sect-hint">
          预设用于组建团队：点击「编辑角色」管理本预设的角色成员并指定组长，即可一键创建多角色协作会话。Cherry
          Nexus 为系统固定预设，成员不可修改。保存后的修改只影响之后新建的会话。
        </p>
      </template>
      <template #popper="{ item }">
        <div class="index-card">
          <div class="index-card-title">{{ item.label as string }}</div>
          <div class="index-card-line">
            <b>角色数</b><span>{{ (item.count as number) || '无' }}</span>
          </div>
          <div class="index-card-line">
            <b>组长</b><span>{{ item.leader as string }}</span>
          </div>
          <div class="index-card-line">
            <b>解释角色</b><span>{{ item.detailRole as string }}</span>
          </div>
          <div class="index-card-line">
            <b>📁 工作区</b><span>{{ item.workspace as string }}</span>
          </div>
        </div>
      </template>

      <button type="button" class="public-roles-entry" @click="openPublicRoles">
        <User class="ico" />
        <span class="entry-title">公共角色</span>
        <span class="entry-sub"
          >{{ publicRoles.length }} 个全局共享基础角色，任意预设可「引用」为成员 · 点此管理</span
        >
      </button>

      <article
        v-for="(preset, pname, idx) in draft.presets"
        :key="pname"
        class="card"
        :data-anchor="idx"
      >
        <span class="card-idx">{{ idx + 1 }}</span>
        <header class="card-head">
          <EditableTitle
            :model-value="pname as string"
            :validate="validateRename"
            :disabled="isFixedPreset(pname as string)"
            @rename="(n: string) => renamePreset(pname as string, n)"
            @error="onError"
          >
            <template #actions>
              <button
                type="button"
                class="edit-roles-btn"
                aria-label="编辑本预设的角色"
                @click="openWorkbench(pname as string)"
              >
                <User class="ico" />编辑角色
              </button>
              <button
                v-if="isFixedPreset(pname as string)"
                type="button"
                class="icon-btn"
                disabled
                title="固定预设：不可改名、删除或更换组长"
                aria-label="固定预设"
              >
                <Lock class="ico" />
              </button>
              <ConfirmPopover
                v-else
                :title="`删除预设「${String(pname)}」？`"
                :impact="removeImpact(String(pname))"
                @confirm="removePreset(String(pname))"
              >
                <template #trigger>
                  <button type="button" class="icon-btn danger" aria-label="删除预设">
                    <Delete class="ico" />
                  </button>
                </template>
              </ConfirmPopover>
            </template>
          </EditableTitle>
        </header>

        <div class="field">
          <LabelTip
            label="团队成员与角色职责"
            tip="组长负责主任务；解释角色不参与派发、不会出现在 @角色 中，只用于节点的独立解释上下文。两种职责互斥。公共角色不能设为组长。"
          />
          <template v-if="draft.roles && Object.keys(draft.roles).length">
            <div v-if="preset.roles?.length" class="role-picker-section">
              <div class="role-picker-head">
                <span>为成员指定职责</span>
                <span class="role-picker-modes" role="group" aria-label="选择要设置的职责">
                  <button
                    type="button"
                    class="role-mode is-leader"
                    :class="{ active: rolePickerMode(pname as string) === 'leader' }"
                    :disabled="isFixedPreset(pname as string)"
                    :aria-pressed="rolePickerMode(pname as string) === 'leader'"
                    :title="
                      isFixedPreset(pname as string) ? '固定预设的组长不可调整' : '切换为设置组长'
                    "
                    @click="setRolePickerMode(pname as string, 'leader')"
                  >
                    <Lock v-if="isFixedPreset(pname as string)" />
                    设置组长
                  </button>
                  <button
                    type="button"
                    class="role-mode is-detail"
                    :class="{ active: rolePickerMode(pname as string) === 'detail' }"
                    :disabled="isFixedPreset(pname as string)"
                    :aria-pressed="rolePickerMode(pname as string) === 'detail'"
                    :title="
                      isFixedPreset(pname as string) ? '固定预设：成员不可修改' : '切换为设置解释'
                    "
                    @click="setRolePickerMode(pname as string, 'detail')"
                  >
                    设置解释
                  </button>
                </span>
                <span v-if="isFixedPreset(pname as string)" class="fixed-leader-note">
                  <Lock />固定预设，成员与组长不可调整
                </span>
              </div>
              <div class="member-roles">
                <button
                  v-for="rname in preset.roles"
                  :key="rname"
                  type="button"
                  class="member-role"
                  :class="{
                    leader: preset.leader === rname,
                    'detail-role': preset.detailRole === rname,
                    'is-locked': !!draft.roles?.[rname as string]?.lock,
                    'is-public': isPublicRole(draft.roles, draft.presets, rname as string),
                  }"
                  :disabled="
                    isFixedPreset(pname as string) ||
                    (rolePickerMode(pname as string) === 'leader' &&
                      isPublicRole(draft.roles, draft.presets, rname as string)) ||
                    (rolePickerMode(pname as string) === 'detail' &&
                      preset.leader === (rname as string))
                  "
                  :aria-pressed="
                    rolePickerMode(pname as string) === 'leader'
                      ? preset.leader === rname
                      : preset.detailRole === rname
                  "
                  :aria-label="
                    isFixedPreset(pname as string)
                      ? `${rname}，固定预设：成员不可修改`
                      : rolePickerMode(pname as string) === 'leader'
                        ? isPublicRole(draft.roles, draft.presets, rname as string)
                          ? `${rname} 是公共角色，不能设为组长`
                          : `设 ${rname} 为组长`
                        : preset.leader === rname
                          ? `${rname} 是组长，不能同时作为解释角色`
                          : `${preset.detailRole === rname ? '取消' : '设'} ${rname} 为解释角色`
                  "
                  :title="
                    isFixedPreset(pname as string)
                      ? '固定预设：成员不可修改'
                      : rolePickerMode(pname as string) === 'leader'
                        ? isPublicRole(draft.roles, draft.presets, rname as string)
                          ? '公共角色不能设为组长'
                          : `点击设 ${rname} 为组长`
                        : preset.leader === rname
                          ? '组长不能同时作为专用解释角色'
                          : preset.detailRole === rname
                            ? '当前专用解释角色；点击取消'
                            : `点击设 ${rname} 为专用解释角色`
                  "
                  @click="selectRoleDuty(pname as string, rname as string)"
                >
                  <span class="member-role-name"
                    ><span class="member-avatar">{{
                      resolveRoleAvatar(rname as string, draft.roles?.[rname as string]?.avatar)
                    }}</span
                    >{{ rname }}</span
                  >
                  <span v-if="draft.roles[rname]" class="member-role-card">
                    <span class="member-card-line"
                      ><b>大脑</b>{{ draft.roles[rname].brain || '未选' }}</span
                    >
                    <span class="member-card-line"
                      ><b>器官组</b>{{ draft.roles[rname].senseGroup || '未选' }}</span
                    >
                    <span v-if="draft.roles[rname].senseGroup" class="member-card-senses">
                      <template
                        v-for="entry in draft.sense_groups?.[draft.roles[rname].senseGroup] ?? []"
                        :key="entry"
                      >
                        <SenseIcon :name="entry" :tools="senseTools" />
                      </template>
                      <span
                        v-if="!(draft.sense_groups?.[draft.roles[rname].senseGroup] ?? []).length"
                        class="no-senses"
                        >未配置能力</span
                      >
                    </span>
                    <span v-if="draft.roles[rname].mcpServers?.length" class="member-card-line"
                      ><b>MCP</b>{{ draft.roles[rname].mcpServers.join('、') }}</span
                    >
                  </span>
                  <span v-if="preset.leader === rname" class="leader-mark" aria-label="当前组长">
                    <Check />
                  </span>
                  <span
                    v-else-if="preset.detailRole === rname"
                    class="leader-mark detail-role-mark"
                    aria-label="当前解释角色"
                  >
                    <Check />
                  </span>
                </button>
              </div>
              <span class="hint">
                先选择要设置的职责，再点击成员卡；黄色角标表示组长，青色角标表示解释角色。公共角色不能设为组长。
              </span>
            </div>
          </template>
          <span v-else class="empty">请先在角色工作台添加角色成员。</span>
          <span v-if="preset.roles && preset.roles.length && !preset.leader" class="hint"
            >⚠️ 必须指定组长</span
          >
          <span v-else-if="!preset.roles || !preset.roles.length" class="hint"
            >点击「编辑角色」进入工作台添加角色成员</span
          >
        </div>

        <div class="field">
          <div class="card-grid card-grid-3 combo-row">
            <label class="field">
              <LabelTip
                label="角色选择(路由)"
                :tip="'选择会话路由影子角色（Shadow）：\n· 发送消息后、提交前，影子调用 select_conversation 决定继续的会话或新建会话\n· 留空则关闭自动路由\n影子角色在本 Tab 顶部的「影子角色」分类中创建。'"
              />
              <el-select
                :model-value="preset.shadows?.conversationRouting ?? ''"
                placeholder="关闭自动路由"
                clearable
                size="small"
                @update:model-value="(v: string) => setConversationRoutingShadow(pname as string, v)"
              >
                <el-option
                  v-for="(_, shadowName) in shadowRoles"
                  :key="shadowName"
                  :value="shadowName as string"
                  :label="shadowName as string"
                />
              </el-select>
              <span v-if="!Object.keys(shadowRoles).length" class="empty">
                请先点击某预设的「编辑角色」进入工作台，在「影子角色」分类创建会话路由 Shadow。
              </span>
            </label>
            <label class="field">
              <LabelTip
                label="工作区"
                :tip="'该预设创建的会话把此目录作为项目工作区写入系统提示词（仅提示 AI，不限制实际文件操作）：\n· 留空则不限定\n· 「浏览」逐层选择服务端目录，受 server.workspace_browse.roots 白名单限制\n· 也可手动填写绝对路径'"
              />
              <div class="workspace-row">
                <el-input
                  class="workspace-input"
                  :class="{
                    'is-invalid':
                      !!props.workspaceWarnings?.[pname as string] ||
                      !!workspaceFormatErrors[pname as string],
                  }"
                  :model-value="preset.workspace ?? ''"
                  placeholder="项目根目录绝对路径（留空则不限定）"
                  size="small"
                  :suffix-icon="
                    props.workspaceWarnings?.[pname as string] ||
                    workspaceFormatErrors[pname as string]
                      ? WarningFilled
                      : undefined
                  "
                  @update:model-value="(v: string) => updateWorkspace(pname as string, v)"
                />
                <button
                  type="button"
                  class="ghost-btn"
                  title="浏览服务端文件系统，逐层选择目录"
                  @click="openBrowser(pname as string)"
                >
                  浏览
                </button>
              </div>
              <!-- 校验告警紧跟工作区输入框（后端 config.save 返 warnings / 前端格式错误），不再放整个三列块底部 -->
              <span v-if="props.workspaceWarnings?.[pname as string]" class="ws-warning">
                {{ props.workspaceWarnings[pname as string] }}
              </span>
              <span v-else-if="workspaceFormatErrors[pname as string]" class="ws-warning">
                {{ workspaceFormatErrors[pname as string] }}
              </span>
            </label>
            <label class="field">
              <LabelTip
                label="审批规则"
                :tip="'审批规则决定系统如何审批你的操作：\n· 命中规则中的危险行为（删除、格式化磁盘）→ 拦截，请你确认\n· 未命中 → 自动放行执行\n选中后与系统默认基准规则（base.yaml）合并生效。\n\n新建/修改：\n· 与「cheryNyxus」对话让它生成规则文件\n· 或手动在 .chery/rule/ 下创建 yaml，点「刷新」后在本下拉选择\n· 点底部「保存」，服务自动重启后生效\n\n规则项：\n· extract 取匹配字段\n· dangerPatterns 危险模式列表\n· false 表示该操作整体需确认\n留空仅用基准。'"
              />
              <div class="rule-row">
                <el-select
                  :model-value="preset.rule ?? ''"
                  placeholder="使用基准（base.yaml）"
                  clearable
                  size="small"
                  @update:model-value="(v: string) => (preset.rule = v || undefined)"
                >
                  <el-option v-for="n in rules" :key="n" :value="n" :label="n" />
                </el-select>
                <button
                  type="button"
                  class="ghost-btn"
                  title="重新拉取 .chery/rule/ 下的规则文件清单"
                  @click="emit('refreshRules')"
                >
                  刷新
                </button>
              </div>
            </label>
          </div>
        </div>
      </article>

      <p v-if="!draft.presets || !Object.keys(draft.presets).length" class="empty">
        暂无预设。输入名称后新建一个团队预设。
      </p>

      <div class="add-row">
        <el-input
          v-model="newPresetName"
          placeholder="新预设名（如 light / project）"
          @keydown.enter="addPreset"
        />
        <button type="button" class="ghost-btn" @click="addPreset">+ 新增预设</button>
      </div>
    </TabShell>
  </div>

  <WorkspaceDirBrowser v-model:open="browserOpen" @select="onBrowserSelect" />
</template>

<style scoped lang="less" src="./PresetsTab.scoped.less"></style>
