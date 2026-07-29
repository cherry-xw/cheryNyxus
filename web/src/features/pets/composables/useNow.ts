import { onBeforeUnmount, ref } from 'vue'
import type { Ref } from 'vue'

/**
 * 响应式时基：每 intervalMs 毫秒刷新一次 now（Date.now 时间戳）。
 * 用于驱动周期性重算（如审批倒计时/闪烁节奏）。
 * 组件卸载时自动 clearInterval。
 */
export function useNow(intervalMs = 250): Ref<number> {
  const now = ref(Date.now())
  const timer = setInterval(() => {
    now.value = Date.now()
  }, intervalMs)
  onBeforeUnmount(() => clearInterval(timer))
  return now
}
