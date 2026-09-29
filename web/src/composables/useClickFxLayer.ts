import { onBeforeUnmount, onMounted, watch } from 'vue'
import type { BAClickFX as BAClickFXInstance, BAClickFXOptions } from 'ba-click-fx'
import { useClickFxPreference } from './useClickFxPreference'
import { useMotionPreference } from './useMotionPreference'

/**
 * 鼠标点击特效（ba-click-fx，蔚蓝档案风格）全局宿主。
 *
 * 在 App.vue 挂载一次：
 *  - 动态 import ba-click-fx，不进入首屏 chunk；
 *  - 使用普通网页覆盖层配置；
 *  - 尊重用户偏好：关闭或 reduced 动效模式时销毁实例，恢复时重新创建；
 *  - 卸载时销毁实例（释放监听与 Canvas）。
 *
 * 配置依据官方 README / rendering-guide：普通网页覆盖层。
 */
export function useClickFxLayer() {
  const { enabled } = useClickFxPreference()
  const { effectiveMode } = useMotionPreference()
  let fx: BAClickFXInstance | null = null
  let disposed = false

  /** 特效是否应当运行：用户开启 且 当前动效模式为完整动效。 */
  function shouldRun(): boolean {
    return enabled.value && effectiveMode.value === 'full'
  }

  async function createFx(): Promise<void> {
    if (disposed) return
    const { BAClickFX } = await import('ba-click-fx')
    if (disposed || fx) return
    const config: BAClickFXOptions = {
      scale: 0.6,
      trailAlways: true,
      outputCompositing: 'browser-overlay',
      hostCompositing: 'screen',
      hostCompositingSurface: 'dom-backdrop',
    }
    try {
      fx = new BAClickFX(config)
    } catch (error) {
      // WebGL/Canvas 不可用等初始化失败不应影响应用本身。
      console.warn('[ClickFx] ba-click-fx 初始化失败，已停用鼠标特效：', error)
      fx = null
    }
  }

  function destroyFx(): void {
    fx?.destroy()
    fx = null
  }

  /** 按「是否应当运行」同步实例：需要则创建，不需要则销毁（释放 GPU 资源）。 */
  function syncFx(): void {
    if (shouldRun()) {
      if (!fx) void createFx()
    } else {
      destroyFx()
    }
  }

  onMounted(() => {
    syncFx()
  })

  // 用户偏好 / 系统动效偏好变化时实时同步：开启则创建，关闭或 reduced 则销毁。
  watch([enabled, effectiveMode], () => syncFx())

  onBeforeUnmount(() => {
    disposed = true
    destroyFx()
  })

  return {
    /** 当前是否已创建特效实例（响应式偏好在 composable 内部驱动，无需向外暴露状态）。 */
    destroy: destroyFx,
  }
}
