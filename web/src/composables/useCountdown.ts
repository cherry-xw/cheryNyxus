import { computed, onBeforeUnmount, ref } from 'vue'

/** 250ms 间隔倒计时。waitTime=0 不启动定时器。返回 remainingMs/remainingSec/expired。 */
export function useCountdown(waitTime: number, createdAt: number) {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  if (waitTime > 0) {
    timer = setInterval(() => {
      now.value = Date.now()
    }, 250)
  }
  onBeforeUnmount(() => {
    if (timer !== undefined) clearInterval(timer)
  })

  const show = computed(() => waitTime > 0)
  const remainingMs = computed(() => Math.max(0, waitTime - (now.value - createdAt)))
  const remainingSec = computed(() => Math.ceil(remainingMs.value / 1000))
  const expired = computed(() => show.value && remainingMs.value <= 0)
  return { now, show, remainingMs, remainingSec, expired }
}
