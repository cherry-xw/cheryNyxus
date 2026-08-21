<script setup lang="ts">
/**
 * PresetsTab：预设管理（config.presets）。
 * 每预设 = 团队成员多选（引用 config.roles 单一源）+ 指定组长（leader）。
 * 运行时采用组长的角色配置（不在预设内重定义 brain/sense）。
 * 增删预设走底部输入框 + ConfirmPopover 二次确认；标题可点击改名。合法性由后端 config.save 校验 fail loud。
 */
import { ref, computed } from 'vue'
import { ArrowDown, Check, Delete, Lock, WarningFilled } from '@element-plus/icons-vue'
import type { ConfigDto, SenseToolInfo } from '@/services/agentApi'
import { pickDirectory, isElectron } from '@/services/platform'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import EditableTitle from '@/components/input/EditableTitle.vue'
import LabelTip from '../config/LabelTip.vue'
import SenseIcon from '../tools/SenseIcon.vue'
import TabShell, { type IndexItem } from '@/components/layout/TabShell.vue'
import { resolveRoleAvatar } from '../../config/roleAvatar'
import WorkspaceDirBrowser from './WorkspaceDirBrowser.vue'

const props = defineProps<{
  draft: ConfigDto
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
type RolePickerMode = 'leader' | 'detail'
const rolePickerModes = ref<Record<string, RolePickerMode>>({})
const ordinaryRoles = computed(() =>
  Object.fromEntries(
    Object.entries(props.draft.roles ?? {}).filter(([, role]) => role.kind !== 'shadow'),
  ),
)
const shadowRoles = computed(() =>
  Object.fromEntries(
    Object.entries(props.draft.roles ?? {}).filter(([, role]) => role.kind === 'shadow'),
  ),
)

function rolePickerMode(pname: string): RolePickerMode {
  if (isFixedPreset(pname)) return 'detail'
  return rolePickerModes.value[pname] ?? 'leader'
}

function setRolePickerMode(pname: string, mode: RolePickerMode): void {
  if (isFixedPreset(pname) && mode === 'leader') return
  rolePickerModes.value[pname] = mode
}

function isFixedPreset(name: string): boolean {
  return name === CHERY_NYXUS_PRESET
}

function removeImpact(pname: string): string[] {
  const preset = props.draft.presets?.[pname]
  const roleCount = preset?.roles?.length ?? 0
  return [
    `预设「${pname}」将被删除。`,
    roleCount ? `${roleCount} 个角色成员配置将一并移除。` : '（无成员）',
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
  // 初始化：空组长 + 空成员。添加成员后选择组长（后端校验组长必填）。
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

/** 下拉多选成员；移除当前组长时同步清空组长。 */
function updateMembers(pname: string, roles: string[]): void {
  const p = props.draft.presets?.[pname]
  if (!p) return
  p.roles =
    isFixedPreset(pname) && p.leader && !roles.includes(p.leader) ? [p.leader, ...roles] : roles
  if (!isFixedPreset(pname) && p.leader && !roles.includes(p.leader)) p.leader = ''
  if (p.detailRole && !roles.includes(p.detailRole)) p.detailRole = undefined
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

/** 点击已选角色卡设为组长。 */
function setLeader(pname: string, role: string): void {
  const p = props.draft.presets?.[pname]
  if (!p || isFixedPreset(pname)) return
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

/** 序号按钮列表：每预设一项。brief 给 mini popper 用（成员数 + 组长 + 媒体服务）。 */
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
  <TabShell tab-key="presets" :index-items="indexItems">
    <template #hints>
      <p class="sect-hint">
        预设用于快速组建团队：选择成员并指定组长，即可一键创建多角色协作会话。Cherry Nexus
        为系统固定预设，成员不可修改。保存后的修改只影响之后新建的会话。
      </p>
    </template>
    <template #popper="{ item }">
      <div class="index-card">
        <div class="index-card-title">{{ item.label as string }}</div>
        <div class="index-card-line">
          <b>成员数</b><span>{{ (item.count as number) || '无' }}</span>
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
            <el-dropdown
              trigger="click"
              :hide-on-click="false"
              class="member-picker"
              :disabled="isFixedPreset(pname as string)"
            >
              <button
                type="button"
                class="member-picker-trigger"
                aria-label="选择团队成员"
                :disabled="isFixedPreset(pname as string)"
                :title="
                  isFixedPreset(pname as string)
                    ? '固定预设：成员不可修改'
                    : '选择团队成员'
                "
              >
                <span>选择成员</span>
                <ArrowDown class="picker-arrow" />
              </button>
              <template #dropdown>
                <el-dropdown-menu class="member-picker-menu">
                  <el-checkbox-group
                    :model-value="preset.roles ?? []"
                    @update:model-value="(roles: string[]) => updateMembers(pname as string, roles)"
                  >
                    <el-checkbox
                      v-for="(_, rname) in ordinaryRoles"
                      :key="rname"
                      :value="rname as string"
                      :disabled="
                        isFixedPreset(pname as string) && preset.leader === (rname as string)
                      "
                    >
                      <span class="picker-role-option"
                        ><span>{{
                          resolveRoleAvatar(rname as string, draft.roles?.[rname as string]?.avatar)
                        }}</span
                        >{{ rname }}</span
                      >
                    </el-checkbox>
                  </el-checkbox-group>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
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
          tip="组长负责主任务；解释角色不参与派发、不会出现在 @角色 中，只用于节点的独立解释上下文。两种职责互斥。"
        />
        <template v-if="draft.roles && Object.keys(ordinaryRoles).length">
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
                    isFixedPreset(pname as string)
                      ? '固定预设的组长不可调整'
                      : '切换为设置组长'
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
                    isFixedPreset(pname as string)
                      ? '固定预设：成员不可修改'
                      : '切换为设置解释'
                  "
                  @click="setRolePickerMode(pname as string, 'detail')"
                >
                  设置解释
                </button>
              </span>
              <span v-if="isFixedPreset(pname as string)" class="fixed-leader-note">
                <Lock />固定预设，组长不可调整
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
                }"
                :disabled="
                  isFixedPreset(pname as string) ||
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
                      ? `设 ${rname} 为组长`
                      : preset.leader === rname
                        ? `${rname} 是组长，不能同时作为解释角色`
                        : `${preset.detailRole === rname ? '取消' : '设'} ${rname} 为解释角色`
                "
                :title="
                  isFixedPreset(pname as string)
                    ? '固定预设：成员不可修改'
                    : rolePickerMode(pname as string) === 'leader'
                      ? `点击设 ${rname} 为组长`
                      : preset.leader === rname
                        ? '组长不能同时作为专用解释角色'
                        : preset.detailRole === rname
                          ? '当前专用解释角色；点击取消'
                          : `点击设 ${rname} 为专用解释角色`
                "
                @click="selectRoleDuty(pname as string, rname)"
              >
                <span class="member-role-name"
                  ><span class="member-avatar">{{
                    resolveRoleAvatar(rname, draft.roles?.[rname]?.avatar)
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
              先选择要设置的职责，再点击成员卡；黄色角标表示组长，青色角标表示解释角色。
            </span>
          </div>
        </template>
        <span v-else class="empty">请先在「角色」中添加成员</span>
        <span v-if="preset.roles && preset.roles.length && !preset.leader" class="hint"
          >⚠️ 必须指定组长</span
        >
        <span v-else-if="!preset.roles || !preset.roles.length" class="hint">先选择团队成员</span>
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
              :tip="'选择会话路由影子角色（Shadow）：\n· 发送消息后、提交前，影子调用 select_conversation 决定继续的会话或新建会话\n· 留空则关闭自动路由\n影子角色在「角色 → 影子角色」中创建。'"
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
              请先在「角色 → 影子角色」中创建会话路由 Shadow。
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
                  props.workspaceWarnings?.[pname as string] || workspaceFormatErrors[pname as string]
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
            <span
              v-if="props.workspaceWarnings?.[pname as string]"
              class="ws-warning"
            >
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

  <WorkspaceDirBrowser
    v-model:open="browserOpen"
    @select="onBrowserSelect"
  />
</template>

<style scoped lang="less">
@import '../../config/shared.less';

.member-picker-trigger {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 24px;
  padding: 0 7px;
  border: 1px solid color-mix(in srgb, var(--ink) 20%, transparent);
  border-radius: 5px;
  background: var(--surface);
  color: color-mix(in srgb, var(--ink) 70%, transparent);
  font-size: 11px;
  cursor: pointer;
  &:hover {
    border-color: color-mix(in srgb, var(--accent) 80%, transparent);
    color: color-mix(in srgb, var(--ink) 90%, transparent);
  }
  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
    &:hover {
      border-color: color-mix(in srgb, var(--ink) 20%, transparent);
      color: color-mix(in srgb, var(--ink) 70%, transparent);
    }
  }
}
.picker-role-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.picker-role-option > span {
  font-size: 16px;
}
.member-avatar {
  width: 26px;
  height: 26px;
  display: inline-grid;
  place-items: center;
  border-radius: 9px;
  box-shadow: 0 0 8px rgba(99, 102, 241, 0.12);
  font-size: 16px;
}
.picker-arrow {
  width: 11px;
  height: 11px;
}
.member-picker-menu {
  min-width: 128px;
  padding: 5px 9px;
  :deep(.el-checkbox-group) {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  :deep(.el-checkbox) {
    margin-right: 0;
    font-size: 12px;
  }
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
  font-size: 11px;
  font-weight: 750;
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
  font-size: 10px;
  cursor: pointer;
  transition: border-color 0.15s, background-color 0.15s, color 0.15s;
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
  font-size: 10px;
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
  &:disabled {
    cursor: default;
    opacity: 0.82;
  }
}
.member-role-name {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  font-weight: 700;
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
  font-size: 10px;
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
    font-weight: 700;
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
// 媒体三选 row：紧凑横排（gap 缩小到 6px），与 small size el-select 配套不显笨重。
.media-row {
  gap: 6px;
  .field {
    gap: 2px;
    .lbl {
      font-size: 10px;
    }
  }
}

// 会话路由/工作区/审批规则三组同行：同 media-row 紧凑规则
.combo-row {
  gap: 6px;
  .field {
    gap: 2px;
    .lbl {
      font-size: 10px;
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
  font-size: 11px;
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
