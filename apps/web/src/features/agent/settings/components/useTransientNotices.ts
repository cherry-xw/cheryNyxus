import { onBeforeUnmount, ref } from 'vue'
import type { SettingsNotice } from '../model/settingsNotices'

/** Local display lifetime only; durable configuration state is never cleared here. */
export function useTransientNotices() {
  const notices = ref<SettingsNotice[]>([])
  const paused = new Set<string>()
  let timers: ReturnType<typeof setTimeout>[] = []
  function stop(): void {
    timers.forEach(clearTimeout)
    timers = []
  }
  function schedule(): void {
    stop()
    if (paused.size) return
    timers.push(
      setTimeout(() => {
        notices.value = notices.value.filter((notice) => notice.kind !== 'message')
      }, 5000),
    )
    timers.push(
      setTimeout(() => {
        notices.value = []
      }, 10000),
    )
  }
  function show(next: SettingsNotice[]): void {
    notices.value = next
    schedule()
  }
  function pause(reason: string): void {
    paused.add(reason)
    stop()
  }
  function resume(reason: string): void {
    paused.delete(reason)
    schedule()
  }
  onBeforeUnmount(() => {
    stop()
    notices.value = []
    paused.clear()
  })
  return { notices, show, pause, resume }
}
