<script setup lang="ts">
/**
 * ConsoleShell：console surface 根壳（`?surface=console`，frameless Electron 窗）。
 *
 * 自研标题栏替代系统外壳：拖拽移动（-webkit-app-region: drag）+ 最小化/最大化-还原/关闭
 * 三键经 `console:window-control` IPC 驱动原生窗口（minimize/close = hide，保 WS 存活）。
 * 原生最大化态（双击标题栏 / Win+↑ / 拖到屏幕边缘）经 `console:maximize-changed` 回推，
 * 标题栏图标同步切换。
 *
 * 布局：标题栏 40px 常驻顶部，业务 overlay 全部从标题栏下方开始（--console-titlebar-h），
 * 避免系统窗壳（原生标题栏 + 自绘 UI 双层壳）问题。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { desktopBridge } from './desktopBridge'

const bridge = desktopBridge()
/** 标题栏高度（40px）——CSS 变量 --console-titlebar-h 注入，overlay 偏移规则引用。 */
const CONSOLE_TITLEBAR_H = 40
const maximized = ref(false)
let cleanupMaximize: (() => void) | undefined

onMounted(() => {
  if (!bridge) return
  cleanupMaximize = bridge.onConsoleMaximizeChanged((value) => {
    maximized.value = value
  })
})
onBeforeUnmount(() => cleanupMaximize?.())

function control(action: 'minimize' | 'maximize' | 'restore' | 'close'): void {
  bridge?.consoleWindowControl(action)
}

function toggleMaximize(): void {
  control(maximized.value ? 'restore' : 'maximize')
}
</script>

<template>
  <div
    class="console-shell"
    :class="{ 'is-maximized': maximized }"
    :style="{ '--console-titlebar-h': `${CONSOLE_TITLEBAR_H}px` }"
  >
    <header class="console-titlebar">
      <span class="console-title">🐾 CheryNyxus</span>
      <div class="console-window-actions" role="group" aria-label="窗口控制">
        <button
          type="button"
          class="window-control is-minimize"
          aria-label="最小化"
          title="最小化"
          @click="control('minimize')"
        >
          <span class="window-control-icon is-minimize" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="window-control is-maximize"
          :aria-label="maximized ? '还原窗口' : '最大化窗口'"
          :title="maximized ? '还原' : '最大化'"
          @click="toggleMaximize"
        >
          <span
            class="window-control-icon"
            :class="maximized ? 'is-restore' : 'is-maximize'"
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          class="window-control is-close"
          aria-label="关闭"
          title="关闭"
          @click="control('close')"
        >
          <span class="window-control-icon is-close" aria-hidden="true" />
        </button>
      </div>
    </header>
    <main class="console-body">
      <slot />
    </main>
  </div>
</template>

<style scoped lang="less">
.console-shell {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--ink);
}

.console-titlebar {
  flex: none;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-left: 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  background: var(--panel);
  user-select: none;
  // 系统级拖拽移动 + 双击最大化（Windows 惯例）；按钮区下方 no-drag 恢复点击
  -webkit-app-region: drag;
}

.console-title {
  font-size: 13px;
  font-weight: 700;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
}

.console-window-actions {
  display: flex;
  align-items: stretch;
  height: 100%;
  -webkit-app-region: no-drag;
}

.window-control {
  position: relative;
  width: 46px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  color: color-mix(in srgb, var(--ink) 86%, transparent);
  background: transparent;
  cursor: default;
  transition:
    color 100ms ease,
    background-color 100ms ease;
}

.window-control:hover,
.window-control:focus-visible {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 12%, transparent);
}

.window-control.is-close:hover,
.window-control.is-close:focus-visible {
  color: #fff;
  background: #d6455d;
}

.window-control:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--accent) 86%, transparent);
  outline-offset: -2px;
}

.window-control-icon {
  position: relative;
  width: 11px;
  height: 11px;
}
.window-control-icon.is-minimize::before {
  content: '';
  position: absolute;
  right: 0;
  bottom: 2px;
  left: 0;
  border-top: 1px solid currentcolor;
}
.window-control-icon.is-maximize {
  border: 1px solid currentcolor;
}
.window-control-icon.is-restore::before,
.window-control-icon.is-restore::after {
  content: '';
  position: absolute;
  width: 9px;
  height: 9px;
  border: 2px solid currentcolor;
}
.window-control-icon.is-restore::before {
  top: 0;
  right: 0;
}
.window-control-icon.is-restore::after {
  bottom: 0;
  left: 0;
  background: var(--panel);
}
.window-control-icon.is-close::before,
.window-control-icon.is-close::after {
  content: '';
  position: absolute;
  top: 5px;
  left: 0;
  width: 12px;
  border-top: 1px solid currentcolor;
}
.window-control-icon.is-close::before {
  transform: rotate(45deg);
}
.window-control-icon.is-close::after {
  transform: rotate(-45deg);
}

.console-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

// console surface 下全屏 overlay（settings/workbench/historyDrawer）从标题栏下方开始：
// fixed 元素无法被父级 padding 约束，经外壳类后代选择器统一改写 top。
// 非 console surface 无 .console-shell 祖先，规则不生效。
:global(.console-shell .settings-overlay),
:global(.console-shell .dialog-overlay),
:global(.console-shell .drawer-overlay) {
  top: var(--console-titlebar-h);
}
</style>
