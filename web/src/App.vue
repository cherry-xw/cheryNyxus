<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  ref,
  watch,
} from 'vue'
import PetStage from '@/features/pets/PetStage.vue'
import NyxusCore from '@/features/pets/nyxus/components/NyxusCore.vue'
import {
  createHistoryDrawerManager,
  HISTORY_DRAWER_MANAGER_KEY,
} from '@/features/agent/drawer/useHistoryDrawerManager'
import {
  useAgentsStore,
  useChatSessionsStore,
  useWorkspaceStore,
} from '@/stores'
import { startApplicationRuntime } from '@/application/runtime/startApplicationRuntime'
import { renderQualityTier } from '@/composables/renderQuality'
import { useClickFxLayer } from '@/composables/useClickFxLayer'
import { installPerformanceDiagnostics } from '@/utils/performanceDiagnostics'
import { visualEventWindow } from '@/features/desktop/visualEvents'
import type { TerminalHeaderMeta } from '@/features/agent/workbench/terminal/WorkbenchTerminal.vue'

// 重界面按实际状态下载，关闭后组件实例及其图形资源可回收。
const ConnectionStatusChip = defineAsyncComponent(
  () => import('@/features/desktop/ConnectionStatusChip.vue'),
)
const WorkbenchSessionBar = defineAsyncComponent(
  () => import('@/features/agent/workbench/WorkbenchSessionBar.vue'),
)
const CyberDesktopHost = defineAsyncComponent(
  () => import('@/features/desktop/CyberDesktopHost.vue'),
)
const WorkspaceCyberWindow = defineAsyncComponent(() => import('@/features/desktop/WorkspaceCyberWindow.vue'))
const AgentDialog = defineAsyncComponent(() => import('@/features/agent/chat/AgentDialog.vue'))
const WorkbenchDialog = defineAsyncComponent(
  () => import('@/features/agent/workbench/WorkbenchDialog.vue'),
)
const TerminalSurface = defineAsyncComponent(
  () => import('@/features/agent/workbench/terminal/TerminalSurface.vue'),
)
const TerminalTitleActions = defineAsyncComponent(
  () => import('@/features/agent/workbench/terminal/TerminalTitleActions.vue'),
)
const WorkbenchViewToggle = defineAsyncComponent(
  () => import('@/features/agent/workbench/WorkbenchViewToggle.vue'),
)
const WorkbenchAttentionIndicator = defineAsyncComponent(
  () => import('@/features/agent/workbench/WorkbenchAttentionIndicator.vue'),
)
const HistoryDrawer = defineAsyncComponent(
  () => import('@/features/agent/drawer/HistoryDrawer.vue'),
)
const SettingsDialog = defineAsyncComponent(
  () => import('@/features/agent/settings/SettingsDialog.vue'),
)
const TaskCenterPanel = defineAsyncComponent(
  () => import('@/features/agent/task-center/TaskCenterPanel.vue'),
)

// 浏览器内每预设一工作台窗（windowId = presetId），由 workbenchWindowsList 渲染。
const agents = useAgentsStore()
const workspace = useWorkspaceStore()
const chatSessions = useChatSessionsStore()
const browserTerminalHeaders = reactive<Record<string, TerminalHeaderMeta>>({})
const browserTerminalRefs = new Map<
  string,
  { clear: () => void; connect: () => void; disconnect: () => void }
>()
function browserTerminalHeader(windowId: string): TerminalHeaderMeta {
  return browserTerminalHeaders[windowId] ?? { username: '', host: '', status: 'idle' }
}
function updateBrowserTerminalHeader(windowId: string, meta: TerminalHeaderMeta): void {
  browserTerminalHeaders[windowId] = meta
}
function setBrowserTerminalRef(windowId: string, instance: unknown): void {
  if (
    instance &&
    typeof instance === 'object' &&
    'clear' in instance &&
    'connect' in instance &&
    'disconnect' in instance
  ) {
    browserTerminalRefs.set(
      windowId,
      instance as { clear: () => void; connect: () => void; disconnect: () => void },
    )
  } else {
    browserTerminalRefs.delete(windowId)
    delete browserTerminalHeaders[windowId]
  }
}

useClickFxLayer()

const reportedRunFailures = new Set<string>()
watch(
  () =>
    Object.values(chatSessions.sessionsById).flatMap((session) => {
      const failure = session.run.errorFact
      if (!failure) return []
      return [
        {
          key: `${session.chatId}:${failure.tracingId ?? failure.code}:${failure.message}`,
          chatId: session.chatId,
          failure,
        },
      ]
    }),
  (failures) => {
    for (const { key, chatId, failure } of failures) {
      if (reportedRunFailures.has(key)) continue
      reportedRunFailures.add(key)
      workspace.openOrFocusWindow(
        visualEventWindow({
          type: 'failure',
          source: String(failure.source ?? 'run'),
          message: failure.message,
          code: failure.code,
          chatId,
        }),
      )
    }
  },
  { deep: true },
)

// 历史抽屉跨层管理层：顶层 provide，供 SpawnRenderer「详情」/ HistoryDrawer / panel inject（不耦合 store 数据层）
provide(HISTORY_DRAWER_MANAGER_KEY, createHistoryDrawerManager())

const composerTitle = computed(() => {
  const chatId = workspace.activeDialogChatId
  if (!chatId) return '发消息'
  const pet = agents.petForChat(chatId)
  if (pet?.name) return pet.name
  return chatSessions.catalogSummaries.find((item) => item.chatId === chatId)?.preset ?? '发消息'
})

watch(
  () => workspace.activeDialogChatId,
  (chatId, previous) => {
    if (chatId) {
      workspace.openOrFocusWindow({
        resourceKey: `session:${chatId}`,
        title: composerTitle.value,
        context: { kind: 'session', chatId },
        geometry: { width: 860, height: 680 },
      })
    } else if (previous) {
      workspace.beginWorkspaceWindowClose(`window:session:${previous}`)
    }
  },
  { immediate: true },
)
watch(
  () => workspace.settingsOpen,
  (open) => {
    if (open) {
      workspace.openOrFocusWindow({
        resourceKey: 'settings',
        title: '系统配置',
        context: { kind: 'settings', section: workspace.settingsSection ?? undefined },
        geometry: { width: 1120, height: 760 },
      })
    } else {
      workspace.beginWorkspaceWindowClose('window:settings')
    }
  },
  { immediate: true },
)
watch(
  [() => workspace.topHistoryChatId, () => workspace.historyDrawerMode],
  ([chatId, mode], previous) => {
    const previousChatId = previous?.[0]
    if (chatId && mode === 'overlay') {
      workspace.openOrFocusWindow({
        resourceKey: `history:${chatId}`,
        title: '档案 // 会话追踪',
        context: { kind: 'history', rootChatId: chatId },
        geometry: { width: 1040, height: 760 },
      })
    } else if (previousChatId) {
      workspace.beginWorkspaceWindowClose(`window:history:${previousChatId}`)
    }
  },
  { immediate: true },
)

const browserSessionWindow = computed(() =>
  [...workspace.workspaceWindowsList]
    .reverse()
    .find(
      (window) =>
        window.context.kind === 'session' &&
        (window.context.chatId === workspace.activeDialogChatId || window.lifecycle === 'closing'),
    ),
)
const browserSettingsWindow = computed(() => workspace.workspaceWindows['window:settings'])
const browserTerminalWindows = computed(() =>
  workspace.workspaceWindowsList.filter((window) => window.context.kind === 'terminal'),
)
const browserHistoryWindow = computed(() =>
  [...workspace.workspaceWindowsList]
    .reverse()
    .find(
      (window) =>
        window.context.kind === 'history' &&
        (window.context.rootChatId === workspace.topHistoryChatId ||
          window.lifecycle === 'closing'),
    ),
)
const browserTaskCenterWindow = computed(() => workspace.workspaceWindows['window:task-center'])
const browserWorkbenchWindows = computed(() =>
  workspace.workbenchWindowsList.flatMap((workbench) => {
    const window = workspace.workspaceWindows[`window:graph:${workbench.id}`]
    return window ? [{ workbench, window }] : []
  }),
)

const settingsDialogRef = ref<{
  confirmClose: () => Promise<boolean>
  close: () => Promise<void>
} | null>(null)

async function requestCyberWindowClose(id: string): Promise<void> {
  if (workspace.workspaceWindows[id]?.context.kind === 'settings') {
    if (!(await settingsDialogRef.value?.confirmClose())) return
  }
  workspace.beginWorkspaceWindowClose(id)
}

function minimizeCyberWindow(id: string): void {
  const window = workspace.workspaceWindows[id]
  if (window?.context.kind === 'graph') {
    workspace.setWorkbenchWindowMinimized(window.context.presetId, true)
    return
  }
  workspace.minimizeWorkspaceWindow(id)
}

function focusTaskCenterWindow(id: string): void {
  workspace.setWorkspaceWindowAttention(id, false)
  workspace.focusWorkspaceWindow(id)
}

const cyberWindowHandlers = {
  opened: workspace.markWorkspaceWindowOpen,
  minimize: minimizeCyberWindow,
  requestClose: requestCyberWindowClose,
  closed: finishCyberWindowClose,
  geometry: workspace.setWorkspaceWindowGeometry,
  toggleMaximize: workspace.toggleWorkspaceWindowMaximized,
}

function finishCyberWindowClose(id: string): void {
  const window = workspace.workspaceWindows[id]
  if (
    window?.context.kind === 'session' &&
    workspace.activeDialogChatId === window.context.chatId
  ) {
    workspace.activeDialogChatId = null
  }
  if (window?.context.kind === 'settings') workspace.settingsOpen = false
  if (window?.context.kind === 'history') workspace.closeAllHistory()
  if (window?.context.kind === 'graph') {
    workspace.closeWorkbenchWindow(window.context.presetId)
    return
  }
  workspace.removeWorkspaceWindow(id)
}
type WorkbenchDialogHandle = { toggleWorkspaceBrowser: () => void; toggleFilesWorkspace: () => void; closeFilesWorkspace: () => void; closeTaskBrowser: () => void; getFilesOpen: () => boolean }
const browserWorkbenchRefs = new Map<string, WorkbenchDialogHandle>()
const browserFilesOpen = reactive(new Map<string, boolean>())
function hasPresetWorkspace(presetId?: string, presetName?: string): boolean {
  const presets = agents.globalConfig?.presets
  const preset = presetName
    ? presets?.[presetName]
    : Object.values(presets ?? {}).find((item) => item.id === presetId)
  return Boolean(preset?.workspace?.trim())
}
function setBrowserFilesOpen(windowId: string, open: boolean): void {
  browserFilesOpen.set(windowId, open)
}
function setBrowserWorkbenchRef(
  windowId: string,
  instance: unknown,
): void {
  if (instance && typeof instance === 'object' && 'toggleFilesWorkspace' in instance) {
    browserWorkbenchRefs.set(windowId, instance as WorkbenchDialogHandle)
  } else {
    browserWorkbenchRefs.delete(windowId)
  }
}
function toggleBrowserWorkbenchFiles(windowId: string): void {
  browserWorkbenchRefs.get(windowId)?.closeTaskBrowser()
  browserWorkbenchRefs.get(windowId)?.toggleFilesWorkspace()
}
onMounted(() => {
  stopPerformanceDiagnostics = installPerformanceDiagnostics(() => renderQualityTier.value)
  void bootstrap()
})
onBeforeUnmount(() => {
  stopApplicationRuntime?.()
  stopPerformanceDiagnostics?.()
})

let stopApplicationRuntime: (() => void) | undefined
let stopPerformanceDiagnostics: (() => void) | undefined

async function bootstrap(): Promise<void> {
  stopApplicationRuntime = startApplicationRuntime()
}
</script>

<template>
      <CyberDesktopHost>
      <PetStage transparent />
      <NyxusCore />
      <WorkspaceCyberWindow
        v-if="browserSessionWindow"
        :handlers="cyberWindowHandlers"
        :window="browserSessionWindow"
        :focus="workspace.focusWorkspaceWindow"
      >
        <AgentDialog v-if="workspace.activeDialogChatId" embedded />
      </WorkspaceCyberWindow>
      <WorkspaceCyberWindow
        v-if="browserTaskCenterWindow"
        :handlers="cyberWindowHandlers"
        :window="browserTaskCenterWindow"
        :focus="focusTaskCenterWindow"
      >
        <TaskCenterPanel />
      </WorkspaceCyberWindow>
      <WorkspaceCyberWindow
        v-if="browserHistoryWindow && workspace.historyDrawerMode === 'overlay'"
        :handlers="cyberWindowHandlers"
        :window="browserHistoryWindow"
        :focus="workspace.focusWorkspaceWindow"
      >
        <HistoryDrawer embedded />
      </WorkspaceCyberWindow>
      <WorkspaceCyberWindow
        v-if="browserSettingsWindow"
        :handlers="cyberWindowHandlers"
        :window="browserSettingsWindow"
        :focus="workspace.focusWorkspaceWindow"
      >
        <SettingsDialog v-if="workspace.settingsOpen" ref="settingsDialogRef" embedded />
      </WorkspaceCyberWindow>
      <WorkspaceCyberWindow
        v-for="terminalWindow in browserTerminalWindows"
        :key="terminalWindow.id"
        :handlers="cyberWindowHandlers"
        :window="terminalWindow"
        :focus="workspace.focusWorkspaceWindow"
      >
        <template #title-actions>
          <TerminalTitleActions
            :meta="browserTerminalHeader(terminalWindow.id)"
            @connect="browserTerminalRefs.get(terminalWindow.id)?.connect()"
            @disconnect="browserTerminalRefs.get(terminalWindow.id)?.disconnect()"
            @clear="browserTerminalRefs.get(terminalWindow.id)?.clear()"
          />
        </template>
        <TerminalSurface
          v-if="terminalWindow.context.kind === 'terminal'"
          :ref="(instance) => setBrowserTerminalRef(terminalWindow.id, instance)"
          :preset-id="terminalWindow.context.presetId"
          @meta="updateBrowserTerminalHeader(terminalWindow.id, $event)"
        />
      </WorkspaceCyberWindow>
      <WorkspaceCyberWindow
        v-for="entry in browserWorkbenchWindows"
        :key="entry.window.id"
        :handlers="cyberWindowHandlers"
        :window="entry.window"
        :focus="() => workspace.focusWorkbenchWindow(entry.workbench.id)"
      >
        <template #title-actions>
          <!-- 树模式待处理提示：标题栏内不可点击图标（hover 显示数量），与 WorkbenchDialog 内部标题栏同一组件 -->
          <WorkbenchAttentionIndicator :window-id="entry.workbench.id" @click="browserWorkbenchRefs.get(entry.workbench.id)?.toggleWorkspaceBrowser()" />
          <ConnectionStatusChip />
          <!-- 标题栏稳定任务快捷位：浏览器面工作台窗由 CyberWindow 承载
               标题栏（WorkbenchDialog embedded 自绘 titlebar 不渲染），strip 挂此 slot；
               senseTool 不注入，strip 内部自拉 sense.tools 兜底 -->
          <WorkbenchSessionBar
            :window-id="entry.workbench.id"
            :preset-id="entry.workbench.presetId"
            :preset-name="entry.workbench.presetName ?? undefined"
            :active-chat-id="entry.workbench.chatId"
            :foreground="entry.window.focused"
            @select="(id: string) => workspace.setWorkbenchWindowChat(entry.workbench.id, id)"
            @before-expand="() => browserWorkbenchRefs.get(entry.workbench.id)?.closeFilesWorkspace()"
          />
          <button
            v-if="hasPresetWorkspace(entry.workbench.presetId, entry.workbench.presetName ?? undefined)"
            type="button"
            class="workbench-files-title-action"
            aria-label="打开文件工作区"
            :aria-pressed="browserFilesOpen.get(entry.workbench.id) ?? false"
            :disabled="!entry.workbench.chatId"
            @click="toggleBrowserWorkbenchFiles(entry.workbench.id)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h7l2 2h9v9.5H3z" /><path d="M3 6.5V5h7l2 2" /></svg>
          </button>
          <WorkbenchViewToggle :window-id="entry.workbench.id" />
        </template>
        <WorkbenchDialog
          :ref="(instance) => setBrowserWorkbenchRef(entry.workbench.id, instance)"
          :window-id="entry.workbench.id"
          :preset-id="entry.workbench.presetId"
          embedded
          @files-open-change="(open) => setBrowserFilesOpen(entry.workbench.id, open)"
        />
      </WorkspaceCyberWindow>
    </CyberDesktopHost>
</template>

<style lang="less">
* {
  box-sizing: border-box;
}

html,
body,
#app {
  width: 100%;
  height: 100%;
  margin: 0;
}

body {
  overflow: hidden;
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
}

.workbench-files-title-action {
  flex: none;
  padding: 4px 8px;
  border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 0;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 78%, transparent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.workbench-files-title-action svg {
  width: 16px;
  height: 16px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: square;
  stroke-linejoin: miter;
}
.workbench-files-title-action:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--ink);
}
.workbench-files-title-action[aria-pressed='true'] svg,
.workbench-files-title-action:hover:not(:disabled) svg {
  animation: workbench-title-file-signal 1.1s steps(2, end) infinite;
  filter: drop-shadow(-1px 0 color-mix(in srgb, var(--accent) 75%, #f44))
    drop-shadow(1px 0 color-mix(in srgb, var(--accent) 70%, #4ff));
}
@keyframes workbench-title-file-signal {
  0%, 100% { transform: translate(0, 0) skewX(0deg); }
  25% { transform: translate(-1px, 0) skewX(-4deg); }
  50% { transform: translate(1px, 1px) skewX(5deg); }
  75% { transform: translate(-1px, 0) skewX(-2deg); }
}
.workbench-files-title-action:focus-visible,
.workbench-files-title-action[aria-pressed='true'] {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-ink);
  outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
  outline-offset: 1px;
}
.workbench-files-title-action:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.terminal-title-connection,
.terminal-title-state,
.terminal-title-clear {
  flex: none;
  font: 12px/1.2 var(--font-mono);
  letter-spacing: 0.04em;
  white-space: nowrap;
  pointer-events: auto;
}
.terminal-window-frame .window-frame-signal {
  display: none;
}
// 终端窗标题栏：title-actions 撑满空白以把「清空」按钮推至右侧（margin-left:auto），
// 但对空白区放开 pointer-events，让鼠标穿透到标题栏拖拽区（原生走 OS -webkit-app-region），
// 元素本体（连接信息/连接状态按钮/清空）保持可交互（原生由各自 no-drag 保证可点击）。
.terminal-window-frame .window-frame-titlebar .window-frame-title-actions {
  flex: 1;
  pointer-events: none;
}
.terminal-window-frame .window-frame-titlebar .window-frame-title-actions > * {
  pointer-events: auto;
}
.cyber-window.is-terminal .cyber-window-title-actions {
  flex: 1;
  pointer-events: none;
}
.cyber-window.is-terminal .cyber-window-signal {
  display: none;
}
.terminal-title-connection {
  max-width: 190px;
  overflow: hidden;
  color: color-mix(in srgb, var(--ink) 68%, transparent);
  text-overflow: ellipsis;
}
.terminal-title-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 4px;
  border: 0;
  color: color-mix(in srgb, var(--ink) 58%, transparent);
  background: transparent;
  cursor: default;
}
.terminal-title-state.is-connected {
  color: var(--el-color-success);
}
.terminal-title-state.is-connected:hover {
  color: color-mix(in srgb, var(--el-color-success) 75%, var(--ink) 25%);
  cursor: pointer;
}
.terminal-title-state.is-connected.is-confirming {
  color: var(--el-color-danger);
}
.terminal-title-state.is-connecting {
  color: var(--accent);
}
.terminal-title-state.is-reconnect {
  color: var(--accent);
  cursor: pointer;
}
.terminal-title-state.is-reconnect:hover {
  color: color-mix(in srgb, var(--accent) 70%, var(--ink) 30%);
}
.terminal-title-clear {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 70%, transparent);
  cursor: pointer;
}
.terminal-title-clear:hover,
.terminal-title-clear:focus-visible {
  color: var(--accent);
  outline: none;
}
.terminal-title-clear:focus-visible {
  text-decoration: underline;
  text-underline-offset: 3px;
}
@media (prefers-reduced-motion: reduce) {
  .workbench-files-title-action[aria-pressed='true'] svg,
  .workbench-files-title-action:hover:not(:disabled) svg {
    animation: none;
    filter: none;
  }
}
</style>
