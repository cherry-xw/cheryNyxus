<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { gsap } from 'gsap'
import { useChatSessionsStore, useConnectionStore, useWorkspaceStore } from '@/application/public'
import type { WorkspaceWindowState } from '@/application/shell/public'
import { renderQualityProfile, renderQualityTier } from '@/composables/renderQuality'
import { MOTION } from '@/utils/gsapCore'
import CyberWindow from './CyberWindow.vue'
import CyberDiagnosticPanel from './CyberDiagnosticPanel.vue'
import { visualEventWindow, type WorkspaceVisualEvent } from './visualEvents'

const workspace = useWorkspaceStore()
const connection = useConnectionStore()
const chats = useChatSessionsStore()
const root = ref<HTMLElement | null>(null)
const stage = ref<HTMLElement | null>(null)
let motionContext: gsap.Context | undefined
let stageResizeObserver: ResizeObserver | undefined
const activeWindows = computed(() =>
  workspace.workspaceWindowsList.filter((window) => window.lifecycle !== 'minimized'),
)
const connectionLabel = computed(
  () =>
    ({
      connected: '已连接',
      connecting: '重连中',
      disconnected: '离线',
    })[connection.status] ?? connection.status,
)
const diagnosticWindows = computed(() =>
  workspace.workspaceWindowsList
    .filter((window) => window.context.kind === 'diagnostic')
    .slice(-3),
)
const desktopStyle = computed(() => ({
  '--cyber-noise-opacity': String(
    renderQualityProfile(renderQualityTier.value).desktopNoiseOpacity,
  ),
}))
const activeSummary = computed(() => {
  const chatId = workspace.activeDialogChatId ?? workspace.activeNyxusChatId
  return chats.catalogSummaries.find((summary) => summary.chatId === chatId)
})

function openCapability(kind: 'attention' | 'routing' | 'roles' | 'settings'): void {
  if (kind === 'settings') {
    workspace.settingsOpen = true
    return
  }
  if (kind === 'attention') {
    workspace.openOrFocusWindow({
      resourceKey: 'attention',
      title: '待操作 // 中断队列',
      context: { kind: 'attention', presetId: activeSummary.value?.presetId },
      geometry: { width: 720, height: 520 },
    })
    return
  }
  if (kind === 'routing' && activeSummary.value) {
    workspace.openOrFocusWindow({
      resourceKey: `routing:${activeSummary.value.chatId}`,
      title: '路由 // 会话追踪',
      context: { kind: 'routing', chatId: activeSummary.value.chatId },
      geometry: { width: 760, height: 560 },
    })
    return
  }
  if (kind === 'roles' && activeSummary.value?.presetId) {
    workspace.openOrFocusWindow({
      resourceKey: `roles:${activeSummary.value.presetId}`,
      title: '角色 // 在编名单',
      context: { kind: 'roles', presetId: activeSummary.value.presetId },
      geometry: { width: 720, height: 560 },
    })
  }
}

function openArchive(): void {
  const chatId = activeSummary.value?.chatId ?? chats.catalogSummaries[0]?.chatId
  if (chatId) workspace.openHistoryRoot(chatId)
}

function publish(event: WorkspaceVisualEvent): void {
  workspace.openOrFocusWindow(visualEventWindow(event))
}

function reportWindowError(event: ErrorEvent): void {
  publish({
    type: 'failure',
    source: event.filename || 'browser.runtime',
    message: event.message || 'Unknown browser runtime error',
    code: 'WINDOW_ERROR',
  })
}

function reportUnhandledRejection(event: PromiseRejectionEvent): void {
  const reason = event.reason
  publish({
    type: 'failure',
    source: 'browser.promise',
    message: reason instanceof Error ? reason.message : String(reason ?? 'Unhandled rejection'),
    code: 'UNHANDLED_REJECTION',
  })
}

function closeDiagnostic(id: string): void {
  workspace.beginWorkspaceWindowClose(id)
}

function removeDiagnostic(id: string): void {
  workspace.removeWorkspaceWindow(id)
}

function syncStageSize(): void {
  const rect = stage.value?.getBoundingClientRect()
  if (!rect) return
  workspace.setWorkspaceStageSize({ width: rect.width, height: rect.height })
}

async function animateBootTelemetry(): Promise<void> {
  if (!root.value || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const label = root.value.querySelector<HTMLElement>('.cyber-coordinate')
  if (!label) return
  const finalText = label.textContent ?? ''
  const { ScrambleTextPlugin } = await import('gsap/ScrambleTextPlugin')
  if (!root.value || !label.isConnected) return
  gsap.registerPlugin(ScrambleTextPlugin)
  motionContext?.add(() => {
    gsap.fromTo(
      label,
      { autoAlpha: 0.2 },
      {
        autoAlpha: 1,
        duration: 0.86,
        ease: 'none',
        scrambleText: { text: finalText, chars: '01/<>[]{}', revealDelay: 0.18 },
      },
    )
  })
}

onMounted(async () => {
  let catalogKnown = chats.catalogSummaries.length > 0
  if (!catalogKnown) {
    try {
      await chats.refreshCatalog()
      catalogKnown = true
    } catch {
      // Offline startup keeps the last functional layout; canonical catalog
      // validation runs on the next successful application refresh.
    }
  }
  const validChatIds = new Set(chats.catalogSummaries.map((chat) => chat.chatId))
  workspace.restoreWorkspaceLayout((window) => {
    if (!catalogKnown) return true
    const context = window.context
    if (context.kind === 'session' || context.kind === 'routing') {
      return validChatIds.has(context.chatId)
    }
    if (context.kind === 'history') return validChatIds.has(context.rootChatId)
    if (context.kind === 'graph' && context.chatId) return validChatIds.has(context.chatId)
    return true
  })
})

onMounted(() => {
  window.addEventListener('error', reportWindowError)
  window.addEventListener('unhandledrejection', reportUnhandledRejection)
  if (root.value && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    motionContext = gsap.context(() => {
      gsap
        .timeline({ defaults: { ease: 'power2.out' } })
        .from('.cyber-system-bar', { autoAlpha: 0, y: -18, duration: MOTION.panel })
        .from('.cyber-taskbar', { autoAlpha: 0, y: 20, duration: MOTION.panel }, '<0.05')
        .from('.cyber-grid', { autoAlpha: 0, scale: 1.04, duration: MOTION.sweep }, 0)
    }, root.value)
    void animateBootTelemetry()
  }
  try {
    if (sessionStorage.getItem('chery.workspace.boot-diagnostic.v1') !== '1') {
      sessionStorage.setItem('chery.workspace.boot-diagnostic.v1', '1')
      publish({
        type: 'business',
        event: 'workspace.boot',
        message: 'NYXUS_OS 视觉外壳已上线，协议层保持规范态。',
      })
    }
  } catch {
    // A blocked sessionStorage must not prevent the desktop from starting.
  }
  stageResizeObserver = new ResizeObserver(syncStageSize)
  if (stage.value) stageResizeObserver.observe(stage.value)
  void nextTick(syncStageSize)
})

onUnmounted(() => {
  window.removeEventListener('error', reportWindowError)
  window.removeEventListener('unhandledrejection', reportUnhandledRejection)
  motionContext?.revert()
  motionContext = undefined
  stageResizeObserver?.disconnect()
  stageResizeObserver = undefined
})

function activate(window: WorkspaceWindowState): void {
  workspace.restoreWorkspaceWindow(window.id)
  switch (window.context.kind) {
    case 'session':
      workspace.activeDialogChatId = window.context.chatId
      break
    case 'settings':
      workspace.settingsOpen = true
      break
    case 'history':
      workspace.openHistoryRoot(window.context.rootChatId)
      break
    case 'graph':
      workspace.setWorkbenchWindowMinimized(window.context.presetId, false)
      break
  }
}
</script>

<template>
  <div ref="root" class="cyber-desktop" :style="desktopStyle">
    <div class="cyber-grid" aria-hidden="true" />
    <div class="cyber-noise" aria-hidden="true" />
    <header class="cyber-system-bar">
      <span class="cyber-brand">CHERY // NYXUS_OS</span>
      <span class="cyber-coordinate" aria-hidden="true">GRID 1920·1080 / SECTOR 07</span>
      <nav class="cyber-launcher" aria-label="系统功能">
        <button type="button" @click="openCapability('attention')">待操作</button>
        <button type="button" :disabled="!activeSummary" @click="openCapability('routing')">路由</button>
        <button type="button" :disabled="!activeSummary?.presetId" @click="openCapability('roles')">角色</button>
        <button type="button" :disabled="!chats.catalogSummaries.length" @click="openArchive">档案</button>
        <button type="button" @click="openCapability('settings')">设置</button>
      </nav>
      <span class="cyber-link" :class="`is-${connection.status}`">
        <i /> 链路 {{ connectionLabel }}
      </span>
      <span class="cyber-window-count">窗口 {{ activeWindows.length.toString().padStart(2, '0') }}</span>
    </header>
    <aside class="cyber-telemetry" aria-hidden="true">
      <span>系统 / 追踪</span><b>/////</b><span>内存 规范态</span><b>///////</b><span>渲染 自适应</span>
    </aside>
    <main ref="stage" class="cyber-desktop-stage">
      <slot />
      <CyberWindow
        v-for="window in diagnosticWindows"
        :key="window.id"
        :window="window"
        @focus="workspace.focusWorkspaceWindow"
        @opened="workspace.markWorkspaceWindowOpen"
        @minimize="workspace.minimizeWorkspaceWindow"
        @request-close="closeDiagnostic"
        @closed="removeDiagnostic"
        @geometry="workspace.setWorkspaceWindowGeometry"
        @toggle-maximize="workspace.toggleWorkspaceWindowMaximized"
      >
        <CyberDiagnosticPanel :window="window" />
      </CyberWindow>
    </main>
    <footer class="cyber-taskbar" aria-label="窗口任务栏">
      <span class="cyber-taskbar-mark">◫ 活动窗口</span>
      <button
        v-for="window in workspace.workspaceWindowsTaskbarList"
        :key="window.id"
        type="button"
        :class="{ active: window.focused, attention: window.attention }"
        @click="activate(window)"
      >
        <i>{{ window.kind.slice(0, 3).toUpperCase() }}</i>{{ window.title }}
      </button>
      <span class="cyber-taskbar-tail">自适应渲染 · {{ new Date().getFullYear() }}</span>
    </footer>
  </div>
</template>

<style scoped lang="less">
.cyber-desktop {
  position: fixed;
  inset: 0;
  overflow: hidden;
  color: var(--ink);
  background:
    radial-gradient(circle at 76% 18%, var(--stage-glow-b), transparent 34%),
    radial-gradient(circle at 18% 76%, var(--stage-glow-a), transparent 38%),
    var(--cyber-desktop-bg);
  isolation: isolate;
}

.cyber-grid,
.cyber-noise {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.cyber-grid {
  background:
    linear-gradient(color-mix(in srgb, var(--accent) 8%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 8%, transparent) 1px, transparent 1px),
    linear-gradient(color-mix(in srgb, var(--accent) 3%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 3%, transparent) 1px, transparent 1px);
  background-size: 48px 48px, 48px 48px, 12px 12px, 12px 12px;
  mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 88%, transparent);
}

.cyber-noise {
  opacity: var(--cyber-noise-opacity, 0.12);
  background: repeating-linear-gradient(0deg, transparent 0 3px, color-mix(in srgb, var(--ink) 4%, transparent) 4px);
}

.cyber-system-bar,
.cyber-taskbar {
  position: absolute;
  z-index: 490;
  right: 0;
  left: 0;
  display: flex;
  align-items: center;
  font-family: var(--font-mono);
  pointer-events: auto;
}

.cyber-system-bar {
  top: 0;
  height: 30px;
  gap: 18px;
  padding: 0 12px;
  border-bottom: 1px solid var(--cyber-line-soft);
  background: var(--cyber-bar-bg);
  font-size: 9px;
  letter-spacing: 0.11em;
}

.cyber-brand {
  color: var(--accent);
  font-weight: 600;
}

.cyber-coordinate {
  color: color-mix(in srgb, var(--ink) 32%, transparent);
}

.cyber-link {
  margin-left: auto;
}

.cyber-launcher {
  display: flex;
  align-self: stretch;
  gap: 1px;
}

.cyber-launcher button {
  padding: 0 8px;
  border: 0;
  border-left: 1px solid var(--cyber-line-soft);
  border-radius: 0;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 62%, transparent);
  font: 600 10px/1 var(--font-mono);
  letter-spacing: 0.04em;
  cursor: pointer;
}

.cyber-launcher button:hover,
.cyber-launcher button:focus-visible {
  background: var(--accent-soft);
  color: var(--accent);
}

.cyber-launcher button:disabled {
  opacity: 0.28;
  cursor: default;
}

.cyber-link i {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 5px;
  background: var(--danger);
}

.cyber-link.is-connected i {
  background: var(--success);
  box-shadow: 0 0 8px color-mix(in srgb, var(--success) 74%, transparent);
}

.cyber-telemetry {
  position: absolute;
  z-index: 2;
  top: 46px;
  right: 8px;
  display: grid;
  gap: 4px;
  justify-items: end;
  color: color-mix(in srgb, var(--accent) 44%, transparent);
  font: 400 8px/1.2 var(--font-mono);
  letter-spacing: 0.12em;
  pointer-events: none;
}

.cyber-telemetry b {
  font-weight: 400;
  letter-spacing: 0.32em;
}

.cyber-desktop-stage {
  position: absolute;
  z-index: 5;
  inset: 30px 0 40px;
}

.cyber-taskbar {
  bottom: 0;
  min-height: 40px;
  gap: 5px;
  padding: 5px 8px;
  border-top: 1px solid var(--cyber-line-soft);
  background: var(--cyber-bar-bg);
}

.cyber-taskbar-mark,
.cyber-taskbar-tail {
  padding: 0 7px;
  color: color-mix(in srgb, var(--ink) 48%, transparent);
  font-size: 9px;
  letter-spacing: 0.1em;
}

.cyber-taskbar button {
  max-width: 180px;
  height: 28px;
  overflow: hidden;
  padding: 0 9px 0 0;
  border: 1px solid var(--cyber-line-soft);
  border-radius: 0;
  background: color-mix(in srgb, var(--surface) 76%, transparent);
  color: color-mix(in srgb, var(--ink) 72%, transparent);
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 400 10px/1 var(--font-mono);
  cursor: pointer;
}

.cyber-taskbar button i {
  display: inline-grid;
  height: 100%;
  margin-right: 7px;
  padding: 0 5px;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent);
  font-style: normal;
  font-size: 8px;
}

.cyber-taskbar button.active {
  border-color: var(--accent);
  color: var(--ink);
  box-shadow: inset 2px 0 var(--accent), inset 0 -2px var(--accent);
}

.cyber-taskbar button.attention {
  border-color: var(--warning);
}

.cyber-taskbar-tail {
  margin-left: auto;
}

@media (max-width: 1279px) {
  .cyber-coordinate,
  .cyber-telemetry,
  .cyber-taskbar-mark {
    display: none;
  }

  .cyber-launcher button {
    padding: 0 5px;
  }
}
</style>
