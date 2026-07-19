<script setup lang="ts">
/**
 * PresetsTab：预设管理（config.presets）。
 * 每预设 = 团队成员多选（引用 config.roles 单一源）+ 指定组长（leader）。
 * 运行时采用组长的角色配置（不在预设内重定义 brain/sense）。
 * 增删预设走底部输入框 + ConfirmDialog 居中 modal 二次确认；标题可点击改名。合法性由后端 config.save 校验 fail loud。
 */
import { ref, computed } from 'vue'
import { ArrowDown, Check, Delete, WarningFilled } from '@element-plus/icons-vue'
import type { ConfigDto, SenseToolInfo } from '@/services/agentApi'
import { pickDirectory, isElectron } from '@/services/platform'
import ConfirmDialog from '@/components/confirm/ConfirmDialog.vue'
import EditableTitle from '@/components/input/EditableTitle.vue'
import SenseIcon from '../tools/SenseIcon.vue'
import TabShell, { type IndexItem } from '@/components/layout/TabShell.vue'
import { resolveRoleAvatar } from '../../config/roleAvatar'

const props = defineProps<{
  draft: ConfigDto
  senseTools: SenseToolInfo[]
  /** 后端 config.save 返回的 workspace 校验告警，按 presetName 索引，显示在对应 workspace 输入框下方。 */
  workspaceWarnings?: Record<string, string>
}>()
const emit = defineEmits<{
  (e: 'error', msg: string): void
  (e: 'workspaceChange', presetName: string, workspace: string | undefined): void
}>()

const newPresetName = ref('')

// 删预设二次确认（重删 → ConfirmDialog 居中 modal）
const removeDialog = ref(false)
const removePname = ref<string | undefined>(undefined)
const removeImpact = computed(() => {
  const pname = removePname.value
  if (pname === undefined) return [] as string[]
  const preset = props.draft.presets?.[pname]
  const roleCount = preset?.roles?.length ?? 0
  return [
    `预设「${pname}」将被删除。`,
    roleCount ? `${roleCount} 个角色成员配置将一并移除。` : '（无成员）',
  ]
})

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
  props.draft.presets[name] = { leader: '', roles: [] }
  newPresetName.value = ''
}

function removePreset(name: string): void {
  if (!props.draft.presets) return
  delete props.draft.presets[name]
}

/** 改名：保序重建 presets。 */
function renamePreset(oldName: string, newName: string): void {
  if (!props.draft.presets) return
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
  p.roles = roles
  if (p.leader && !roles.includes(p.leader)) p.leader = ''
}

/** 点击已选角色卡设为组长。 */
function setLeader(pname: string, role: string): void {
  const p = props.draft.presets?.[pname]
  if (!p) return
  if (!(p.roles ?? []).includes(role)) p.roles = [...(p.roles ?? []), role]
  p.leader = role
}

/** 按类型筛选媒体服务名（供下拉选项）。 */
function mediaNamesByType(type: 'image' | 'video' | 'audio'): string[] {
  if (!props.draft.media) return []
  return Object.entries(props.draft.media)
    .filter(([, cfg]) => cfg.type === type)
    .map(([name]) => name)
}

/** Electron 模式有原生目录选择对话框；浏览器模式降级为纯文本框输入。 */
const canPickDir = isElectron

/** 调原生目录选择器选工作区；取消（null）不改值。 */
async function onPickWorkspace(pname: string): Promise<void> {
  const dir = await pickDirectory()
  const p = props.draft.presets?.[pname]
  if (dir && p) updateWorkspace(pname, dir)
}

/** 输入与目录选择共用：写 draft 后立刻通知外壳按该预设单独校验。 */
function updateWorkspace(pname: string, value: string): void {
  const p = props.draft.presets?.[pname]
  if (!p) return
  p.workspace = value || undefined
  emit('workspaceChange', pname, p.workspace)
}

/** 序号按钮列表：每预设一项。brief 给 mini popper 用（成员数 + 组长 + 媒体服务）。 */
const indexItems = computed<IndexItem[]>(() => {
  const presets = props.draft.presets ?? {}
  return Object.entries(presets).map(([pname, p]) => ({
    label: pname,
    count: (p.roles ?? []).length,
    leader: p.leader || '未指定',
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
        预设用于快速组建团队：选择成员，再从成员中指定组长。保存后的修改只会用于之后新建的会话，进行中的会话不受影响。
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
          @rename="(n: string) => renamePreset(pname as string, n)"
          @error="onError"
        >
          <template #actions>
            <el-dropdown trigger="click" :hide-on-click="false" class="member-picker">
              <button type="button" class="member-picker-trigger" aria-label="选择团队成员">
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
                      v-for="(_, rname) in draft.roles"
                      :key="rname"
                      :value="rname as string"
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
              type="button"
              class="icon-btn danger"
              aria-label="删除预设"
              @click=";(removePname = String(pname)), (removeDialog = true)"
            >
              <Delete class="ico" />
            </button>
          </template>
        </EditableTitle>
      </header>

      <div class="field">
        <span class="lbl">团队成员与组长</span>
        <template v-if="draft.roles && Object.keys(draft.roles).length">
          <div v-if="preset.roles?.length" class="member-roles">
            <button
              v-for="rname in preset.roles"
              :key="rname"
              class="member-role"
              :class="{ leader: preset.leader === rname }"
              :aria-label="`设 ${rname} 为组长`"
              :title="preset.leader === rname ? `${rname}（当前组长）` : `点击设 ${rname} 为组长`"
              @click="setLeader(pname as string, rname)"
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
            </button>
          </div>
          <span class="hint">在上方选择团队成员；点击成员卡片即可设为组长。</span>
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
        <span class="lbl">工作区</span>
        <div class="workspace-row">
          <el-input
            class="workspace-input"
            :class="{ 'is-invalid': !!props.workspaceWarnings?.[pname as string] }"
            :model-value="preset.workspace ?? ''"
            placeholder="项目根目录绝对路径（留空则不限定）"
            size="small"
            :suffix-icon="props.workspaceWarnings?.[pname as string] ? WarningFilled : undefined"
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
        </div>
        <span v-if="props.workspaceWarnings?.[pname as string]" class="ws-warning">
          {{ props.workspaceWarnings[pname as string] }}
        </span>
        <span class="hint">
          该预设创建的会话把此目录作为项目工作区写入系统提示词（仅提示 AI，不限制实际文件操作）。
          {{ canPickDir ? '' : '浏览器模式请手动填写绝对路径。' }}
        </span>
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

    <ConfirmDialog
      v-model="removeDialog"
      icon="🗑️"
      :title="`删除预设「${removePname ?? ''}」？`"
      :impact="removeImpact"
      tab-color="#f6b73c"
      @confirm="removePreset(removePname ?? '')"
    />
  </TabShell>
</template>

<style scoped lang="less">
@import '../../config/shared.less';

.member-picker-trigger {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 24px;
  padding: 0 7px;
  border: 1px solid rgba(36, 38, 45, 0.2);
  border-radius: 5px;
  background: #fff;
  color: rgba(20, 22, 26, 0.7);
  font-size: 11px;
  cursor: pointer;
  &:hover {
    border-color: rgba(246, 183, 60, 0.8);
    color: rgba(20, 22, 26, 0.9);
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
.member-role {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  padding: 0 9px;
  border: 1px solid rgba(20, 22, 26, 0.18);
  border-radius: 6px;
  background: #fff;
  color: rgba(20, 22, 26, 0.62);
  cursor: pointer;
  font-family: inherit;
  transition:
    border-color 0.15s,
    background 0.15s,
    color 0.15s;
  &:hover,
  &:focus-visible {
    outline: none;
    border-color: rgba(246, 183, 60, 0.75);
    background: rgba(246, 183, 60, 0.1);
    color: rgba(20, 22, 26, 0.9);
  }
  &.leader {
    border-color: #d99717;
    background: rgba(246, 183, 60, 0.23);
  }
}
.member-role-name {
  font-size: 12px;
  font-weight: 700;
  color: rgba(20, 22, 26, 0.86);
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
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 8px;
  background: #fffdf8;
  box-shadow: 0 5px 14px rgba(36, 38, 45, 0.14);
  color: rgba(20, 22, 26, 0.72);
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
    color: rgba(20, 22, 26, 0.48);
    font-weight: 700;
  }
}
.member-card-senses {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-height: 15px;
  padding-top: 2px;
  border-top: 1px solid rgba(20, 22, 26, 0.08);
}
.no-senses {
  color: rgba(20, 22, 26, 0.42);
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
  // 右上贴合成员 pill 的圆角；左下留出斜切的三角缺口。
  border-radius: 0 6px 0 0;
  clip-path: polygon(100% 0, 100% 100%, 0 0);
  background: #d99717;
  color: #fff;
  svg {
    width: 6px;
    height: 6px;
  }
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

// 工作区：输入框 + 选择目录按钮横排
.workspace-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

// 工作区校验告警（后端 config.save 返 warnings 时显示在输入框下方）
.ws-warning {
  display: block;
  margin-top: 4px;
  color: #b91c1c;
  font-size: 11px;
  line-height: 1.4;
}
.workspace-input.is-invalid {
  :deep(.el-input__wrapper) {
    box-shadow: 0 0 0 1px #dc2626 inset;
  }
  :deep(.el-input__suffix-inner) {
    color: #dc2626;
  }
}
</style>
