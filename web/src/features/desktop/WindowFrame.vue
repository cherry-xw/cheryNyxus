<script setup lang="ts">
/**
 * WindowFrame：原生独立窗通用外壳（settings / workbench 面）。
 *
 * 自绘 40px 标题栏（拖拽移动 + 双击最大化）+ 三键（最小化/最大化-还原/关闭），
 * 经 useWindowFrame → `window:control` IPC 驱动原生窗；原生最大化态经 `window:maximized`
 * 回推切标题栏图标（双击标题栏 / Win+↑ / 拖到屏幕边缘）。
 * 主题边框（暖橙 22% 描边）+ `var(--bg)` 底；body slot 铺满剩余空间。
 *
 * 三键行为默认 `windowControl`，可经 `minimize` / `maximize` / `close` 函数 prop 覆盖
 * （workbench 关闭需先释放根时间线订阅再交 main；传入覆盖后按钮即调覆盖实现）。
 * `attention` prop 驱动标题栏暖橙外发光闪烁（workbench 收到需用户操作的通知时置位）。
 * `title-actions` slot 位于标题与三键之间（settings 面放「打开配置文件夹」按钮）。
 *
 * 挂载时 lockWindowRootColorScheme() 锁根画布 color-scheme（灰边修复）+ 加 window-surface class。
 * 仅 Electron settings/workbench 面渲染；浏览器单页不经过此组件。
 */
import { onMounted } from 'vue'
import { useWindowFrame, lockWindowRootColorScheme } from './useWindowFrame'

defineProps<{
  title?: string
  /** channel 徽记（CyberWindow 同款，如登录窗 'AUTH'）；缺省不渲染。 */
  channel?: string
  /** 需用户操作（审批/提问）时标题栏闪烁；非聚焦窗由 store 置位，点击标题栏熄灭。 */
  attention?: boolean
  /** 三键覆盖：传入即替代默认 windowControl 驱动（如 workbench 关闭先释放订阅）。 */
  minimize?: () => void
  maximize?: () => void
  close?: () => void
  /** 标题栏 pointerdown 透传：workbench 面点击标题栏熄灭 attentionBlink（Phase E）。 */
  titlePointerDown?: (e: PointerEvent) => void
}>()

const { maximized, control, toggleMaximize } = useWindowFrame()

onMounted(() => {
  lockWindowRootColorScheme()
})
</script>

<template>
  <div class="window-frame">
    <header
      class="window-frame-titlebar"
      :class="{ 'has-attention': attention }"
      @dblclick="toggleMaximize"
      @pointerdown="titlePointerDown?.($event)"
    >
      <div class="window-frame-title-group">
        <span v-if="channel" class="window-frame-channel">{{ channel }}</span>
        <span class="window-frame-title">{{ title ?? '' }}</span>
        <!-- 标题位置扩展点：slot 紧贴标题右侧、垂直居中（与标题同行），三键保持最右 -->
        <div class="window-frame-title-actions">
          <slot name="title-actions" />
        </div>
      </div>
      <span class="window-frame-signal" aria-hidden="true">01 ▰▰▰</span>
      <div class="window-frame-actions" role="group" aria-label="窗口控制">
        <button
          type="button"
          class="window-control is-minimize"
          aria-label="最小化"
          title="最小化"
          @click="minimize?.() ?? control('minimize')"
        >
          _
        </button>
        <button
          type="button"
          class="window-control is-maximize"
          :aria-label="maximized ? '还原窗口' : '最大化窗口'"
          :title="maximized ? '还原' : '最大化'"
          @click="maximize?.() ?? toggleMaximize()"
        >
          {{ maximized ? '❐' : '□' }}
        </button>
        <button
          type="button"
          class="window-control is-close"
          aria-label="关闭"
          title="关闭"
          @click="close?.() ?? control('close')"
        >
          ×
        </button>
      </div>
    </header>
    <main class="window-frame-body">
      <slot />
    </main>
  </div>
</template>

<style lang="less">
// 三键共享样式（windowControls.less 非 scoped，供 WorkbenchDialog native 面同款按钮复用）
@import '@/styles/windowControls.less';
</style>

<style scoped lang="less">
.window-frame {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--cyber-desktop-bg);
  color: var(--ink);
  // 主题边框：独立窗以暖橙 22% 描边区分窗与桌面
  border: 1px solid var(--cyber-line-soft);
  border-radius: 0;
}

.window-frame-titlebar {
  flex: none;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding-left: 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--cyber-line) 64%, transparent);
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 15%, transparent), transparent 42%),
    var(--cyber-title-bg);
  user-select: none;
  // 系统级拖拽移动 + 双击最大化（Windows 惯例）；按钮区下方 no-drag 恢复点击
  -webkit-app-region: drag;
}

// —— CyberWindow 同款 channel 徽记 / signal / 文字三键（2026-09 视觉统一） ——
.window-frame-channel {
  flex: none;
  padding: 2px 5px;
  border: 1px solid color-mix(in srgb, var(--accent) 46%, transparent);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.12em;
}
.window-frame-signal {
  flex: none;
  margin-left: auto;
  opacity: 0.64;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.12em;
}
.window-frame-actions {
  display: flex;
  align-items: stretch;
  height: 100%;
  -webkit-app-region: no-drag;
}
// 覆盖 windowControls.less（46px icon 键）：WindowFrame 面改 CyberWindow 文字键
.window-frame .window-control {
  width: 38px;
  border: 0;
  border-left: 1px solid color-mix(in srgb, var(--cyber-line) 44%, transparent);
  border-radius: 0;
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1;
}
.window-frame .window-control:hover,
.window-frame .window-control:focus-visible {
  background: var(--accent-soft);
  color: var(--accent);
}
.window-frame .window-control.is-close:hover,
.window-frame .window-control.is-close:focus-visible {
  background: color-mix(in srgb, var(--danger) 76%, transparent);
  color: white;
}

.window-frame-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

// 标题右侧扩展点容器：垂直居中对齐标题、水平紧贴标题；按钮区恢复 no-drag 可点击
// （header 是 drag 区，若不覆盖则按钮无法点击）
.window-frame-title-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  -webkit-app-region: no-drag;
}

.window-frame-title {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
  letter-spacing: 0.06em;
}

// 需用户操作（审批/提问）时标题栏暖橙外发光闪烁（与 WorkbenchDialog has-attention 同语义，
// 用主题 accent 而非硬编码暖橙，保持设置窗 / 工作台窗观感一致）。
.window-frame-titlebar.has-attention {
  animation: window-frame-box-blink 1.1s ease-in-out infinite;
}
@keyframes window-frame-box-blink {
  0%,
  100% {
    box-shadow: 0 0 0 0 transparent;
    border-bottom-color: color-mix(in srgb, var(--ink) 12%, transparent);
  }
  50% {
    box-shadow: 0 0 16px 1px color-mix(in srgb, var(--accent) 55%, transparent);
    border-bottom-color: color-mix(in srgb, var(--accent) 55%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .window-frame-titlebar.has-attention {
    animation: none;
    border-bottom-color: var(--accent);
  }
}

.window-frame-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
