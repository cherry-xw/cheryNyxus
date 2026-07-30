<script setup lang="ts">
/**
 * AgentDialog orchestrator：发消息弹窗（runtime 切换合一）。
 * 状态/逻辑下沉 useAgentDialogOptions；角色卡下沉 RoleConfigPopover；媒体预览下沉 MediaPreviewBar。
 */
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { AnimatePresence, motion } from 'motion-v'
import { ElPopover, ElTooltip, ElUpload } from 'element-plus'
import RoleConfigPopover from '../dialog/RoleConfigPopover.vue'
import MediaPreviewBar from '../dialog/media/MediaPreviewBar.vue'
import ContextBreakdownTip from '../toolbar/ContextBreakdownTip.vue'
import { fmtTokens } from '../toolbar/contextBreakdown'
import { useAgentDialogOptions } from '../dialog/useAgentDialogOptions'
import { useAgentsStore, useChatSessionsStore } from '@/stores'
import { CHERY_NYXUS_PRESET } from '@/stores/agents/data/petLifecycle'

const agents = useAgentsStore()
const chatSessions = useChatSessionsStore()
// 共用单蒙层：仅当 AgentDialog 是栈顶 overlay 时其蒙层带 blur，否则透明（避免多层 blur 叠加）
const isTopMask = computed(() => agents.topOverlay === 'agentDialog')

const MotionDiv = motion.div

const {
  chatId,
  pet,
  presetName,
  brains,
  senseGroups,
  config,
  senseTools,
  roleSelections,
  primaryRole,
  text,
  editorRef,
  commandOptions,
  commandTabs,
  activeCommandTab,
  comboCommandGroups,
  showCommandMenu,
  activeCommandIndex,
  commandMenuRef,
  roleMenuRef,
  matchingRoleMentions,
  showRoleMenu,
  activeRoleIndex,
  uploading,
  mediaHint,
  mediaAttachments,
  sending,
  loading,
  error,
  primarySelection,
  orderedRoleSelections,
  mediaServicesByType,
  close,
  handleSend,
  onEditorKeydown,
  onEditorInput,
  onEditorSelectionChange,
  onEditorPaste,
  selectCommand,
  selectCommandTab,
  selectRoleMention,
  removeMedia,
  onMediaSelected,
  senseEntries,
  senseTool,
  brainConfig,
  supportsTools,
} = useAgentDialogOptions()

/** Cherry Nexus 会话：弱化角色编制 + 启用会话索引签。 */
const isNyxus = computed(() => presetName.value === CHERY_NYXUS_PRESET)

// ── Nexus 会话索引签（切换/新建入口） ──
const tabOpen = ref(false)
const creating = ref(false)
const tabAnchorRef = ref<HTMLElement | null>(null)

/** 最近 6 条 Nexus 主会话（root + preset=cheryNyxus），按 updatedAt 降序。 */
const nyxusSessions = computed(() =>
  Object.values(chatSessions.sessionsById)
    .filter((s) => !s.meta.parentChatId && s.meta.preset === CHERY_NYXUS_PRESET)
    .sort((a, b) => (b.meta.updatedAt ?? 0) - (a.meta.updatedAt ?? 0))
    .slice(0, 6),
)

function toggleTab(): void {
  tabOpen.value = !tabOpen.value
}

function switchSession(id: string): void {
  if (id === chatId.value) {
    tabOpen.value = false
    return
  }
  // activeDialogChatId 变化触发本文件已有的 watch chatId 自动重载 options，无需手动 hydrate。
  agents.activeNyxusChatId = id
  agents.activeDialogChatId = id
  tabOpen.value = false
}

async function createSession(): Promise<void> {
  if (creating.value) return
  creating.value = true
  try {
    const id = await agents.createNyxusSession()
    await chatSessions.hydrateTree(id)
    agents.activeDialogChatId = id
    tabOpen.value = false
  } catch (e) {
    console.error('[AgentDialog] createNyxusSession failed:', e)
  } finally {
    creating.value = false
  }
}

function previewText(s: { chatId: string; meta: { preview?: string } }): string {
  const p = s.meta.preview?.trim()
  if (p) return p.length > 28 ? `${p.slice(0, 28)}…` : p
  return s.chatId.slice(0, 8)
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`
}

// 点索引签锚点外任意处 → 关闭浮层。
function onDocClick(e: MouseEvent): void {
  if (!tabOpen.value) return
  const anchor = tabAnchorRef.value
  if (anchor && !anchor.contains(e.target as Node)) tabOpen.value = false
}
if (typeof document !== 'undefined') {
  document.addEventListener('click', onDocClick)
  onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
}
// 会话切换/关闭时收起浮层，避免下次打开仍展开。
watch(chatId, () => {
  tabOpen.value = false
})

// ── 斜杠指令菜单定位（Teleport 到 body 后用 fixed 定位；锚定 .msg-input 顶部，向上展开） ──
const commandMenuStyle = reactive({
  bottom: '0px',
  left: '0px',
  width: '390px',
  maxHeight: '280px',
})
function positionCommandMenu(): void {
  const editor = editorRef.value
  const menu = commandMenuRef.value ?? roleMenuRef.value
  if (!editor || !menu) return
  const editorRect = editor.getBoundingClientRect()
  const margin = 8
  const minWidth = 280
  const maxWidth = Math.min(420, window.innerWidth - margin * 2)
  const width = Math.max(minWidth, Math.min(maxWidth, editorRect.width))
  const left = Math.max(margin, Math.min(editorRect.left, window.innerWidth - width - margin))
  // 菜单底边固定在输入框上沿 6px；内容/Tab 高度变化时只向上伸缩。
  commandMenuStyle.bottom = `${window.innerHeight - editorRect.top + 6}px`
  commandMenuStyle.left = `${left}px`
  commandMenuStyle.width = `${width}px`
  commandMenuStyle.maxHeight = `${Math.min(280, Math.max(0, editorRect.top - margin - 6))}px`
}
watch(showCommandMenu, async (open) => {
  if (open) {
    await nextTick()
    positionCommandMenu()
  }
})
watch(showRoleMenu, async (open) => {
  if (open) {
    await nextTick()
    positionCommandMenu()
  }
})
watch(activeCommandIndex, () => {
  // 高亮项滚动进视口后再校准菜单位置（菜单高度变化时）
  if (showCommandMenu.value) {
    nextTick(() => positionCommandMenu())
  }
})
watch([activeCommandTab, commandOptions], () => {
  if (showCommandMenu.value) nextTick(() => positionCommandMenu())
})
if (typeof window !== 'undefined') {
  window.addEventListener('resize', positionCommandMenu)
  window.addEventListener('scroll', positionCommandMenu, true)
}
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', positionCommandMenu)
    window.removeEventListener('scroll', positionCommandMenu, true)
  }
})

/** 颜色分级（与 SessionList / HistoryDrawerPanel / ContextBar 对齐：<50% 绿 / 50-80% 黄 / >=80% 红）。 */
function usageClass(u: number): 'usage-low' | 'usage-mid' | 'usage-high' {
  if (u >= 0.8) return 'usage-high'
  if (u >= 0.5) return 'usage-mid'
  return 'usage-low'
}

/** 每角色上下文占用（按当前 brain 的 contextLimit 折算）。brain / config / pet 任一未就绪 → null（chip 隐藏）。 */
const roleUsages = computed<Record<string, { used: number; total: number; usage: number } | null>>(
  () => {
    const p = pet.value
    const out: Record<string, { used: number; total: number; usage: number } | null> = {}
    for (const [role, sel] of Object.entries(roleSelections.value)) {
      const limit = brainConfig(sel.brain)?.contextLimit
      if (!limit || !p) {
        out[role] = null
        continue
      }
      const used = p.contextUsed ?? 0
      const usage = Math.min(1, Math.max(0, used / limit))
      out[role] = { used, total: limit, usage }
    }
    return out
  },
)

/** dialog-head 工作区模式：workspace 有值时 pet name 前 📁（路径失效改 ⚠ 红色），hover 显全路径。无 workspace 纯文本。 */
const workspaceInvalid = computed(() => pet.value?.workspaceValid === false)
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="chatId"
      key="overlay"
      class="dialog-overlay"
      :class="{ 'is-top-mask': isTopMask }"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      :transition="{ duration: 0.16 }"
    >
      <MotionDiv
        key="panel"
        class="dialog-panel"
        :class="{ 'is-nyxus-panel': isNyxus }"
        :initial="{ opacity: 0, y: 16, scale: 0.96 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :exit="{ opacity: 0, y: 12, scale: 0.97 }"
        :transition="{ duration: 0.18, ease: 'easeOut' }"
        role="dialog"
        aria-modal="true"
        :aria-label="`向 ${isNyxus ? 'Cherry Nexus' : (pet?.name ?? '智能体')} 发送消息`"
      >
        <header class="dialog-head">
          <span class="title">
            <span class="title-row">
              <el-tooltip
                v-if="pet?.workspace && !isNyxus"
                placement="bottom"
                :show-after="200"
                :hide-after="0"
              >
                <template #content>
                  <span>工作区：{{ pet.workspace }}</span>
                  <span v-if="workspaceInvalid" style="color: #fca5a5"> · 路径失效</span>
                </template>
                <span class="who" :class="{ 'is-ws-invalid': workspaceInvalid }">
                  <span class="who-icon">{{ workspaceInvalid ? '⚠' : '📁' }}</span
                  >{{ pet?.name ?? 'agent' }}
                </span>
              </el-tooltip>
              <span v-else class="who">{{
                isNyxus ? 'Cherry Nexus' : (pet?.name ?? 'agent')
              }}</span>
            </span>
            <span class="hint">Cmd/Ctrl+Enter 发送 · Esc 关闭</span>
          </span>
          <button type="button" class="close-btn" aria-label="关闭" @click="close">✕</button>
        </header>

        <div v-if="!isNyxus" class="role-configs">
          <div class="session-note">小组角色编制</div>
          <div
            v-if="loading"
            class="role-tags role-tags-skel"
            aria-busy="true"
            aria-label="角色编制加载中"
          >
            <span v-for="n in 3" :key="n" class="role-skel-tile" aria-hidden="true" />
          </div>
          <div v-else class="role-tags" aria-label="小组角色编制">
            <el-popover
              v-for="[role, selection] in orderedRoleSelections"
              :key="role"
              trigger="click"
              placement="bottom-start"
              :width="420"
              popper-class="role-runtime-popper"
            >
              <template #reference>
                <button
                  type="button"
                  class="role-summary-tag"
                  :class="{ 'is-primary': role === primaryRole }"
                  :aria-label="`配置角色 ${role}，大脑 ${selection.brain || '未选择'}，${senseEntries(selection.senseGroup).length} 项能力`"
                >
                  <span class="role-summary-main">
                    <span aria-hidden="true">{{ role === primaryRole ? '♛' : '✦' }}</span>
                    <span class="role-summary-name">{{ role }}</span>
                  </span>
                  <span class="role-summary-meta-row">
                    <span class="role-summary-model-slot">
                      <span class="role-summary-model">◈ {{ selection.brain || '—' }}</span>
                    </span>
                    <el-tooltip
                      v-if="roleUsages[role]"
                      placement="top"
                      :show-after="200"
                      :hide-after="0"
                    >
                      <template #content>
                        <ContextBreakdownTip
                          v-if="pet?.contextBreakdown"
                          :breakdown="pet.contextBreakdown"
                        />
                        <span v-else>上下文 {{ Math.round(roleUsages[role]!.usage * 100) }}%</span>
                      </template>
                      <span
                        class="role-usage-chip"
                        :class="usageClass(roleUsages[role]!.usage)"
                        :aria-label="`上下文 ${Math.round(roleUsages[role]!.usage * 100)}% · ${fmtTokens(roleUsages[role]!.used)} / ${fmtTokens(roleUsages[role]!.total)}`"
                        >{{ fmtTokens(roleUsages[role]!.used) }}/{{
                          fmtTokens(roleUsages[role]!.total)
                        }}</span
                      >
                    </el-tooltip>
                  </span>
                  <span
                    v-if="senseEntries(selection.senseGroup).length"
                    class="role-summary-senses"
                    aria-label="当前能力"
                  >
                    <span
                      v-for="entry in senseEntries(selection.senseGroup)"
                      :key="entry"
                      class="role-summary-sense-icon"
                    >
                      {{ senseTool(entry)?.icon ?? '⚙' }}
                    </span>
                  </span>
                </button>
              </template>

              <RoleConfigPopover
                :role="role"
                :selection="selection"
                :brains="brains"
                :sense-groups="senseGroups"
                :config="config"
                :sense-tools="senseTools"
                :is-primary="role === primaryRole"
                :primary-role="primaryRole"
                @update:selection="roleSelections[role] = $event"
              />
            </el-popover>
          </div>
        </div>

        <MediaPreviewBar :attachments="mediaAttachments" @remove="removeMedia" />

        <div v-if="mediaHint" class="media-hint-row">{{ mediaHint }}</div>

        <div class="composer-wrap">
          <div v-if="isNyxus" ref="tabAnchorRef" class="index-tab-anchor">
            <button
              type="button"
              class="index-tab"
              :class="{ 'is-open': tabOpen }"
              :aria-expanded="tabOpen"
              aria-label="切换 Nexus 会话"
              @click="toggleTab"
            >
              <span class="index-tab-label">会话</span>
              <span class="index-tab-count">{{ nyxusSessions.length }}</span>
            </button>
            <div v-if="tabOpen" class="index-tab-panel" role="menu" aria-label="最近 Nexus 会话">
              <div class="index-tab-panel-title">最近 Nexus 会话</div>
              <button
                v-for="s in nyxusSessions"
                :key="s.chatId"
                type="button"
                class="index-tab-item"
                :class="{ 'is-active': s.chatId === chatId }"
                role="menuitem"
                @click="switchSession(s.chatId)"
              >
                <span class="index-tab-item-preview">{{ previewText(s) }}</span>
                <span class="index-tab-item-meta">{{ formatTime(s.meta.updatedAt) }}</span>
              </button>
              <button
                type="button"
                class="index-tab-new"
                role="menuitem"
                :disabled="creating"
                @click="createSession"
              >
                + 新建会话
              </button>
            </div>
          </div>
          <div class="textarea-row">
          <div
            ref="editorRef"
            class="msg-input rich-message-input"
            :class="{ 'is-disabled': sending, 'is-empty': !text }"
            :contenteditable="!sending"
            role="textbox"
            aria-multiline="true"
            aria-label="输入消息"
            data-placeholder="输入消息…（输入 / 选择指令）"
            @input="onEditorInput"
            @keydown="onEditorKeydown"
            @keyup="onEditorSelectionChange"
            @click="onEditorSelectionChange"
            @paste="onEditorPaste"
          />
          <Teleport v-if="showCommandMenu" to="body">
            <div
              ref="commandMenuRef"
              class="command-menu"
              role="listbox"
              aria-label="可用指令"
              :style="commandMenuStyle"
            >
              <div class="command-tabs" role="tablist" aria-label="指令类型">
                <button
                  v-for="tab in commandTabs"
                  :key="tab.id"
                  type="button"
                  class="command-tab"
                  :class="{ 'is-active': tab.id === activeCommandTab }"
                  :disabled="tab.count === 0"
                  role="tab"
                  :aria-selected="tab.id === activeCommandTab"
                  @mousedown.prevent
                  @click="selectCommandTab(tab.id)"
                >
                  {{ tab.label }}<span class="command-tab-count">{{ tab.count }}</span>
                </button>
              </div>
              <div class="command-options-scroll">
                <template v-if="activeCommandTab === 'combo'">
                  <section
                    v-for="group in comboCommandGroups"
                    :key="group.plugin"
                    class="combo-command-group"
                  >
                    <div class="combo-command-group-title">
                      <span>{{ group.plugin }}</span
                      ><span>{{ group.commands.length }} 项</span>
                    </div>
                    <button
                      v-for="command in group.commands"
                      :key="command.id"
                      type="button"
                      class="command-option"
                      :class="{
                        'is-active': commandOptions.indexOf(command) === activeCommandIndex,
                      }"
                      role="option"
                      :aria-selected="commandOptions.indexOf(command) === activeCommandIndex"
                      @mousedown.prevent
                      @mousemove="activeCommandIndex = commandOptions.indexOf(command)"
                      @click="selectCommand(command)"
                    >
                      <span class="command-option-name">{{ command.label }}</span>
                      <span class="command-option-desc">{{ command.description }}</span>
                    </button>
                  </section>
                </template>
                <template v-else>
                  <button
                    v-for="(command, index) in commandOptions"
                    :key="command.id"
                    type="button"
                    class="command-option"
                    :class="{ 'is-active': index === activeCommandIndex }"
                    role="option"
                    :aria-selected="index === activeCommandIndex"
                    @mousedown.prevent
                    @mousemove="activeCommandIndex = index"
                    @click="selectCommand(command)"
                  >
                    <span class="command-option-name">{{ command.label }}</span>
                    <span class="command-option-desc">{{ command.description }}</span>
                  </button>
                </template>
              </div>
            </div>
          </Teleport>
          <Teleport v-if="showRoleMenu" to="body">
            <div
              ref="roleMenuRef"
              class="command-menu role-mention-menu"
              role="listbox"
              aria-label="可委派角色"
              :style="commandMenuStyle"
            >
              <button
                v-for="(role, index) in matchingRoleMentions"
                :key="role.name"
                type="button"
                class="command-option"
                :class="{ 'is-active': index === activeRoleIndex }"
                role="option"
                :aria-selected="index === activeRoleIndex"
                @mousedown.prevent
                @mousemove="activeRoleIndex = index"
                @click="selectRoleMention(role)"
              >
                <span class="command-option-name">@{{ role.name }}</span>
                <span class="command-option-desc">{{ role.description }}</span>
              </button>
            </div>
          </Teleport>
          <div class="textarea-actions">
            <ElPopover
              trigger="click"
              placement="top-end"
              :width="160"
              popper-class="add-media-popper"
              popper-style="padding: 4px;"
            >
              <template #reference>
                <button
                  type="button"
                  class="add-media-btn"
                  :disabled="uploading || !primarySelection?.brain"
                  :title="uploading ? '上传中…' : '添加媒体'"
                  aria-label="添加媒体附件"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    width="16"
                    height="16"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              </template>
              <div class="add-media-menu" @click.stop>
                <ElUpload
                  :auto-upload="false"
                  :show-file-list="false"
                  accept="image/*"
                  :disabled="uploading || !primarySelection?.brain"
                  :on-change="(f: any) => onMediaSelected(f)"
                  class="add-media-upload"
                >
                  <div class="add-media-item">
                    <span>🖼️</span><span>图片</span
                    ><span v-if="mediaServicesByType.image" class="media-svc-tag">{{
                      mediaServicesByType.image
                    }}</span
                    ><span v-else class="media-svc-tag missing">未配置</span>
                  </div>
                </ElUpload>
                <ElUpload
                  :auto-upload="false"
                  :show-file-list="false"
                  accept="video/*"
                  :disabled="uploading || !primarySelection?.brain"
                  :on-change="(f: any) => onMediaSelected(f)"
                  class="add-media-upload"
                >
                  <div class="add-media-item">
                    <span>🎬</span><span>视频</span
                    ><span v-if="mediaServicesByType.video" class="media-svc-tag">{{
                      mediaServicesByType.video
                    }}</span
                    ><span v-else class="media-svc-tag missing">未配置</span>
                  </div>
                </ElUpload>
                <ElUpload
                  :auto-upload="false"
                  :show-file-list="false"
                  accept="audio/*"
                  :disabled="uploading || !primarySelection?.brain"
                  :on-change="(f: any) => onMediaSelected(f)"
                  class="add-media-upload"
                >
                  <div class="add-media-item">
                    <span>🎵</span><span>音频</span
                    ><span v-if="mediaServicesByType.audio" class="media-svc-tag">{{
                      mediaServicesByType.audio
                    }}</span
                    ><span v-else class="media-svc-tag missing">未配置</span>
                  </div>
                </ElUpload>
              </div>
            </ElPopover>
            <button
              type="button"
              class="send-btn"
              :disabled="
                !text.trim() ||
                sending ||
                loading ||
                !primarySelection?.brain ||
                (supportsTools(primarySelection.brain) && !primarySelection.senseGroup)
              "
              aria-label="发送消息"
              @click="handleSend"
            >
              <svg
                class="send-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
            </button>
          </div>
        </div>
        </div>

        <div v-if="error" class="error-row" role="alert">{{ error }}</div>
      </MotionDiv>
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
@import '../dialog/agentDialog.less';

.role-usage-chip {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}
.role-summary-meta-row {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
  max-width: 100%;
}
.role-usage-chip.usage-low {
  background: rgba(34, 197, 94, 0.14);
  color: #16a34a;
}
.role-usage-chip.usage-mid {
  background: rgba(234, 179, 8, 0.16);
  color: #a16207;
}
.role-usage-chip.usage-high {
  background: rgba(239, 68, 68, 0.16);
  color: #b91c1c;
}

// ── Nexus 会话索引签（composer 左外沿，折叠/展开双态） ──
// dialog-panel 默认 overflow:auto 会裁断外溢的索引签；Nexus 会话内容短，放开 visible 让签+浮层外溢。
.dialog-panel.is-nyxus-panel {
  overflow: visible;
}

.composer-wrap {
  position: relative;
}

.index-tab-anchor {
  position: absolute;
  right: 100%;
  top: 50%;
  transform: translateY(-50%);
  margin-right: 6px;
  // row-reverse：button（DOM 首位）贴右（邻近 composer），panel 向左展开。
  display: flex;
  flex-direction: row-reverse;
  align-items: center;
  gap: 6px;
  z-index: 4;
}

.index-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 8px 6px;
  border: 1px solid rgba(246, 183, 60, 0.4);
  border-radius: 8px;
  background: rgba(246, 183, 60, 0.12);
  color: #9a7422;
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  transition: background-color 120ms ease, border-color 120ms ease;
  &:hover {
    background: rgba(246, 183, 60, 0.2);
    border-color: rgba(246, 183, 60, 0.6);
  }
  &.is-open {
    background: rgba(246, 183, 60, 0.28);
    border-color: rgba(246, 183, 60, 0.7);
  }
}

.index-tab-label {
  writing-mode: vertical-rl;
  text-orientation: upright;
  letter-spacing: 1px;
}

.index-tab-count {
  padding: 1px 5px;
  border-radius: 8px;
  background: rgba(246, 183, 60, 0.3);
  color: #7a5a18;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.index-tab-panel {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 220px;
  padding: 8px;
  border: 1px solid rgba(35, 38, 44, 0.12);
  border-radius: 10px;
  background: #fffdf8;
  box-shadow: 0 8px 20px rgba(20, 22, 26, 0.18);
  color: #14161a;
  font-size: 12px;
  white-space: normal;
}

.index-tab-panel-title {
  padding: 2px 6px 6px;
  color: #8c6114;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.3px;
}

.index-tab-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color 100ms ease;
  &:hover {
    background: rgba(246, 183, 60, 0.12);
  }
  &.is-active {
    background: rgba(246, 183, 60, 0.22);
  }
}

.index-tab-item-preview {
  font-size: 12px;
  font-weight: 550;
  color: #14161a;
  overflow: hidden;
  text-overflow: ellipsis;
}

.index-tab-item-meta {
  font-size: 10px;
  color: rgba(20, 22, 26, 0.55);
  font-variant-numeric: tabular-nums;
}

.index-tab-new {
  margin-top: 4px;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: rgba(246, 183, 60, 0.14);
  color: #9a7422;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 100ms ease;
  &:hover:not(:disabled) {
    background: rgba(246, 183, 60, 0.24);
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}
</style>

<!-- Popover 挂载到 Teleport 根节点，需用非 scoped 样式去除 Element Plus 的外层壳。 -->
<style lang="less">
.role-runtime-popper.el-popper {
  --el-popover-border-color: transparent;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.role-runtime-popper .el-popper__arrow {
  display: none;
}

.add-media-popper.el-popover {
  border-radius: 10px;
}

.add-media-menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.add-media-upload {
  width: 100%;

  .el-upload {
    width: 100%;
    display: block;
  }
}

.add-media-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 550;
  color: #14161a;
  transition: background-color 100ms ease;

  &:hover {
    background: rgba(246, 183, 60, 0.12);
  }

  span:first-child {
    font-size: 14px;
  }
}

.media-svc-tag {
  margin-left: auto;
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(246, 183, 60, 0.15);
  color: #9a7422;
  &.missing {
    background: rgba(180, 30, 30, 0.08);
    color: #b04040;
  }
}

// 指令卡片由富文本编辑器在 hover 时挂到 body，避免被输入框和弹窗滚动容器裁剪。
.instruction-token-floating-popover {
  position: fixed;
  z-index: 320;
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 248px;
  padding: 8px 9px;
  border: 1px solid rgba(35, 38, 44, 0.14);
  border-radius: 7px;
  background: #fffdf8;
  box-shadow: 0 7px 18px rgba(20, 22, 26, 0.18);
  color: #14161a;
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1.45;
  pointer-events: none;
}

.instruction-token-floating-title {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  font-weight: 750;
}

.instruction-token-floating-description {
  color: rgba(20, 22, 26, 0.76);
}

.instruction-token-floating-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 5px;
  border-top: 1px solid rgba(35, 38, 44, 0.1);
  color: #8c6114;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 700;
}
</style>
