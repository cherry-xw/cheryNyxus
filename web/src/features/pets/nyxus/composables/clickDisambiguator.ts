export interface ClickDisambiguator {
  single: () => void
  double: () => void
  dispose: () => void
}

/** 延迟单击，给浏览器的 dblclick 留出判定窗口；双击必须取消尚未执行的单击。 */
export function createClickDisambiguator(
  onSingle: () => void,
  onDouble: () => void,
  delayMs = 220,
): ClickDisambiguator {
  let timer: ReturnType<typeof setTimeout> | undefined

  function clear(): void {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
  }

  return {
    single() {
      clear()
      timer = setTimeout(() => {
        timer = undefined
        onSingle()
      }, delayMs)
    },
    double() {
      clear()
      onDouble()
    },
    dispose: clear,
  }
}
