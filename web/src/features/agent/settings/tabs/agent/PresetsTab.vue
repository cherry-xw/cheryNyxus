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
import { pickDirectory, isElectron } from '@/application/platform/public'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import EditableTitle from '@/features/agent/settings/controls/EditableTitle.vue'
import LabelTip from '../config/LabelTip.vue'
import RolesTab from './RolesTab.vue'
import { resolveRoleAvatar } from '../../config/roleAvatar'
import SenseIcon from '../tools/SenseIcon.vue'
import { isPublicRole, listPublicRoles } from './publicRole'
import TabShell, { type IndexItem } from '@/features/agent/settings/components/TabShell.vue'
import WorkspaceDirBrowser from './WorkspaceDirBrowser.vue'

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
  /** 规则文件下拉刷新：SettingsDialog 重新拉取 rules.list（手动新建/Cherry Nexus 生成后立即可见）。 */
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
    id: `preset-${crypto.randomUUID().replaceAll('-', '')}`,
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

/** 按类型筛选媒体服务名（供下拉选项）。 */
function mediaNamesByType(type: 'image' | 'video' | 'audio'): string[] {
  if (!props.draft.media) return []
  return Object.entries(props.draft.media)
    .filter(([, cfg]) => cfg.type === type)
    .map(([name]) => name)
}

/** 目录选择按钮按运行模式互斥展示：Electron 用原生「选择目录」（后端同机绝对路径）；浏览器用「浏览」服务端目录弹层（前端机器路径与后端无关）。 */
const canPickDir = isElectron

/** 每预设的绝对路径格式错误提示（前端即时校验；存在性由后端 validateWorkspace RPC 校验）。 */
const workspaceFormatErrors = ref<Record<string, string>>({})

/** 绝对路径格式校验：POSIX `/` 开头；Windows `C:\`、`C:/` 或 UNC `\\server\share`。 */
function isAbsolutePathFormat(p: string): boolean {
  return /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p)
}

/** 调 Electron 原生目录选择器选工作区（后端同机绝对路径）；取消（null）不改值。 */
async function onPickWorkspace(pname: string): Promise<void> {
  const dir = await pickDirectory()
  const p = props.draft.presets?.[pname]
  if (dir && p) updateWorkspace(pname, dir)
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
    mediaImage: p.mediaImage || '未挂载',
    mediaVideo: p.mediaVideo || '未挂载',
    mediaAudio: p.mediaAudio || '未挂载',
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
            <b>🖼️ 图片</b><span>{{ item.mediaImage as string }}</span>
          </div>
          <div class="index-card-line">
            <b>🎬 视频</b><span>{{ item.mediaVideo as string }}</span>
          </div>
          <div class="index-card-line">
            <b>🎵 音频</b><span>{{ item.mediaAudio as string }}</span>
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
          <span class="lbl">媒体服务</span>
          <template v-if="draft.media && Object.keys(draft.media).length">
            <div class="card-grid card-grid-3 media-row">
              <label class="field">
                <span class="lbl">🖼️ 图片</span>
                <el-select
                  :model-value="preset.mediaImage ?? ''"
                  placeholder="未选择"
                  clearable
                  size="small"
                  @update:model-value="(v: string) => (preset.mediaImage = v || undefined)"
                >
                  <el-option v-for="n in mediaNamesByType('image')" :key="n" :value="n" :label="n" />
                </el-select>
              </label>
              <label class="field">
                <span class="lbl">🎬 视频</span>
                <el-select
                  :model-value="preset.mediaVideo ?? ''"
                  placeholder="未选择"
                  clearable
                  size="small"
                  @update:model-value="(v: string) => (preset.mediaVideo = v || undefined)"
                >
                  <el-option v-for="n in mediaNamesByType('video')" :key="n" :value="n" :label="n" />
                </el-select>
              </label>
              <label class="field">
                <span class="lbl">🎵 音频</span>
                <el-select
                  :model-value="preset.mediaAudio ?? ''"
                  placeholder="未选择"
                  clearable
                  size="small"
                  @update:model-value="(v: string) => (preset.mediaAudio = v || undefined)"
                >
                  <el-option v-for="n in mediaNamesByType('audio')" :key="n" :value="n" :label="n" />
                </el-select>
              </label>
            </div>
            <span class="hint">按类型选择媒体服务。不选则该类型无媒体能力。</span>
          </template>
          <span v-else class="empty"> 暂无媒体服务。在「🖼️ 媒体服务」tab 中新建。 </span>
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
                :tip="'该预设创建的会话把此目录作为项目工作区写入系统提示词（仅提示 AI，不限制实际文件操作）：\n· 留空则不限定\n· 「选择目录」打开系统目录选择器（Electron）或「浏览」逐层选择服务端目录（浏览器），受 server.workspace_browse.roots 白名单限制\n· 也可手动填写绝对路径'"
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
                  v-if="canPickDir"
                  type="button"
                  class="ghost-btn"
                  @click="onPickWorkspace(pname as string)"
                >
                  选择目录
                </button>
                <button
                  v-else
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
                :tip="'审批规则决定系统如何审批你的操作：\n· 命中规则中的危险行为（删除、格式化磁盘）→ 拦截，请你确认\n· 未命中 → 自动放行执行\n选中后与系统默认基准规则（base.yaml）合并生效。\n\n新建/修改：\n· 与「Cherry Nexus」对话让它生成规则文件\n· 或手动在 .chery/rule/ 下创建 yaml，点「刷新」后在本下拉选择\n· 点底部「保存」，服务自动重启后生效\n\n规则项：\n· extract 取匹配字段\n· dangerPatterns 危险模式列表\n· false 表示该操作整体需确认\n留空仅用基准。'"
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

<style scoped lang="less">
@import '../../config/shared.less';

.presets-tab-root {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

// 角色工作台视图：顶部导航 + RolesTab 撑满剩余高度
.preset-workbench {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.workbench-nav {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
}
.back-btn {
  height: 26px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--ink) 18%, transparent);
  border-radius: 6px;
  background: var(--surface);
  color: color-mix(in srgb, var(--ink) 78%, transparent);
  font-size: 13px;
  cursor: pointer;
  &:hover {
    border-color: color-mix(in srgb, var(--accent) 70%, transparent);
    color: color-mix(in srgb, var(--ink) 92%, transparent);
  }
}
.workbench-title {
  font-size: 14px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 86%, transparent);
}
.workbench-sub {
  font-size: 12px;
  color: color-mix(in srgb, var(--ink) 52%, transparent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preset-roles-host {
  flex: 1 1 auto;
  min-height: 0;
}

// 卡片 header 的「编辑角色」入口
.edit-roles-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: color-mix(in srgb, var(--accent) 82%, var(--ink));
  font-size: 13px;
  cursor: pointer;
  &:hover {
    border-color: color-mix(in srgb, var(--accent) 60%, transparent);
    background: color-mix(in srgb, var(--accent) 20%, transparent);
  }
  .ico {
    width: 13px;
    height: 13px;
  }
}

// 团队成员与角色职责区（卡片表面恢复的设置组长/解释角色入口）
.member-avatar {
  width: 26px;
  height: 26px;
  display: inline-grid;
  place-items: center;
  border-radius: 9px;
  box-shadow: 0 0 8px rgba(99, 102, 241, 0.12);
  font-size: 18px;
}
.member-roles {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.role-picker-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 9px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink) 2%, var(--surface));
}
.role-picker-head {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
  color: color-mix(in srgb, var(--ink) 68%, transparent);
}
.role-picker-modes {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.role-mode {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-height: 23px;
  padding: 0 7px;
  border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 5px;
  background: var(--surface);
  color: color-mix(in srgb, var(--ink) 58%, transparent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background-color 0.15s,
    color 0.15s;
  svg {
    width: 10px;
    height: 10px;
  }
  &:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
    outline-offset: 1px;
  }
  &.is-leader:hover,
  &.is-leader.active {
    border-color: #d99717;
    background: color-mix(in srgb, #d99717 16%, var(--surface));
    color: color-mix(in srgb, #d99717 82%, var(--ink));
  }
  &.is-detail:hover,
  &.is-detail.active {
    border-color: var(--nx-cyan, #38bdf8);
    background: color-mix(in srgb, var(--nx-cyan, #38bdf8) 16%, var(--surface));
    color: color-mix(in srgb, var(--nx-cyan, #0284c7) 82%, var(--ink));
  }
  &:disabled {
    cursor: not-allowed;
    opacity: 0.48;
  }
}
.fixed-leader-note {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: color-mix(in srgb, #d99717 72%, var(--ink));
  font-size: 12px;
  font-weight: 600;
  svg {
    width: 10px;
    height: 10px;
  }
}
.member-role {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  padding: 0 9px;
  border: 1px solid color-mix(in srgb, var(--ink) 18%, transparent);
  border-radius: 6px;
  background: var(--surface);
  color: color-mix(in srgb, var(--ink) 62%, transparent);
  cursor: pointer;
  font-family: inherit;
  transition:
    border-color 0.15s,
    background 0.15s,
    color 0.15s;
  &:hover,
  &:focus-visible {
    outline: none;
    border-color: color-mix(in srgb, var(--accent) 75%, transparent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    color: color-mix(in srgb, var(--ink) 90%, transparent);
  }
  &.leader {
    border-color: #d99717;
    background: color-mix(in srgb, #d99717 12%, var(--surface));
  }
  &.detail-role {
    border-color: var(--nx-cyan, #38bdf8);
    background: color-mix(in srgb, var(--nx-cyan, #38bdf8) 18%, transparent);
  }
  &.is-locked {
    cursor: default;
    opacity: 0.82;
  }
  &.is-public:not(.is-locked) {
    cursor: not-allowed;
    opacity: 0.68;
  }
  &:disabled {
    cursor: default;
    opacity: 0.82;
  }
}
.member-role-name {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 14px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 86%, transparent);
}
.member-role-card {
  position: absolute;
  z-index: 3;
  left: 0;
  top: calc(100% + 7px);
  display: none;
  width: max-content;
  max-width: 260px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 8px;
  background: var(--surface-hover);
  box-shadow: 0 5px 14px color-mix(in srgb, var(--ink) 14%, transparent);
  color: color-mix(in srgb, var(--ink) 72%, transparent);
  font-size: 12px;
  line-height: 1.35;
}
.member-role:hover .member-role-card,
.member-role:focus-visible .member-role-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.member-card-line {
  display: flex;
  gap: 6px;
  b {
    color: color-mix(in srgb, var(--ink) 66%, transparent);
    font-weight: 600;
  }
}
.member-card-senses {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-height: 15px;
  padding-top: 2px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
}
.no-senses {
  color: color-mix(in srgb, var(--ink) 62%, transparent);
}
.leader-mark {
  position: absolute;
  top: -1px;
  right: -0.6px;
  width: 24px;
  height: 14px;
  display: inline-flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 2px 2px 0 0;
  box-sizing: border-box;
  border-radius: 0 6px 0 0;
  clip-path: polygon(100% 0, 100% 100%, 0 0);
  background: #d99717;
  color: #fff;
  svg {
    width: 6px;
    height: 6px;
  }
}
.detail-role-mark {
  background: var(--nx-cyan, #38bdf8);
}


// 公共角色入口：预设列表顶部通栏，虚线边框与预设卡片区分
.public-roles-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  margin-bottom: 10px;
  border: 1px dashed color-mix(in srgb, var(--nx-cyan, #38bdf8) 48%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--nx-cyan, #38bdf8) 8%, var(--surface));
  color: color-mix(in srgb, var(--ink) 78%, transparent);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background-color 0.15s;
  &:hover {
    border-color: color-mix(in srgb, var(--nx-cyan, #38bdf8) 72%, transparent);
    background: color-mix(in srgb, var(--nx-cyan, #38bdf8) 14%, var(--surface));
  }
  .ico {
    flex: 0 0 auto;
    width: 15px;
    height: 15px;
    color: var(--nx-cyan, #38bdf8);
  }
  .entry-title {
    flex: 0 0 auto;
    font-size: 13px;
    font-weight: 600;
    color: color-mix(in srgb, var(--ink) 88%, transparent);
  }
  .entry-sub {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: color-mix(in srgb, var(--ink) 52%, transparent);
  }
}

// 媒体三选 row：紧凑横排（gap 缩小到 6px），与 small size el-select 配套不显笨重。
.media-row {
  gap: 6px;
  .field {
    gap: 2px;
    .lbl {
      font-size: 12px;
    }
  }
}

// 会话路由/工作区/审批规则三组同行：同 media-row 紧凑规则
.combo-row {
  gap: 6px;
  .field {
    gap: 2px;
    .lbl {
      font-size: 12px;
    }
  }
}

// 工作区：输入框 + 选择目录/浏览按钮横排
.workspace-row {
  display: flex;
  gap: 6px;
  align-items: center;

  .workspace-input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .ghost-btn {
    flex: 0 0 auto;
    padding: 0 8px;
    white-space: nowrap;
  }
}

// 审批规则：下拉 + 刷新按钮横排
.rule-row {
  display: flex;
  gap: 6px;
  align-items: center;
  .ghost-btn {
    flex: 0 0 auto;
    padding: 0 8px;
  }
}

// 工作区校验告警（后端 config.save 返 warnings / 前端格式错误，显示在输入框下方）
.ws-warning {
  display: block;
  margin-top: 4px;
  color: var(--danger);
  font-size: 13px;
  line-height: 1.4;
}
.workspace-input.is-invalid {
  :deep(.el-input__wrapper) {
    box-shadow: 0 0 0 1px var(--danger) inset;
  }
  :deep(.el-input__suffix-inner) {
    color: var(--danger);
  }
}
</style>
