<script setup lang="ts">
/**
 * WindowFrame：原生独立窗通用外壳（settings / workbench 面）。
 *
 * 自绘 40px 标题栏（拖拽移动 + 双击最大化）+ 三键（最小化/最大化-还原/关闭），
 * 经 useWindowFrame → `window:control` IPC 驱动原生窗；原生最大化态经 `window:maximized`
 * 回推切标题栏图标（双击标题栏 / Win+↑ / 拖到屏幕边缘）。
 * 主题边框（暖橙 22% 描边）+ `var(--bg)` 底；body slot 铺满剩余空间。
 *
 * 挂载时 lockWindowRootColorScheme() 锁根画布 color-scheme（灰边修复）+ 加 window-surface class。
 * 仅 Electron settings/workbench 面渲染；浏览器单页不经过此组件。
 */
import { onMounted } from 'vue'
import { useWindowFrame, lockWindowRootColorScheme } from './useWindowFrame'

defineProps<{ title?: string }>()

const { maximized, control, toggleMaximize } = useWindowFrame()

onMounted(() => {
  lockWindowRootColorScheme()
})
</script>

<template>
  <div class="window-frame">
    <header class="window-frame-titlebar" @dblclick="toggleMaximize">
      <span class="window-frame-title">{{ title ?? '' }}</span>
      <div class="window-frame-actions" role="group" aria-label="窗口控制">
        <slot name="title-actions" />
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
  background: var(--bg);
  color: var(--ink);
  // 主题边框：独立窗以暖橙 22% 描边区分窗与桌面
  border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
}

.window-frame-titlebar {
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

.window-frame-title {
  font-size: 13px;
  font-weight: 700;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
}

.window-frame-actions {
  display: flex;
  align-items: stretch;
  height: 100%;
  -webkit-app-region: no-drag;
}

.window-frame-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
