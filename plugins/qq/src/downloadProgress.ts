import type { WorkerProgress } from './workerClient.js'

const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
/** Request-local, model-free throttling. No timer survives command completion. */
export function createDownloadReporter(intervalMs: number, notify: (text: string) => void, now = Date.now) {
  let lastAt = now(), lastBytes = 0, lastPhase = '', unchangedSince = lastAt, observedBytes = 0, observedPhase = ''
  return (p: WorkerProgress) => {
    const at = now()
    if (p.bytes !== observedBytes || p.phase !== observedPhase) unchangedSince = at
    observedBytes = p.bytes; observedPhase = p.phase
    if (at - lastAt < intervalMs) return
    const speed = p.phase === lastPhase && p.bytes >= lastBytes ? (p.bytes - lastBytes) / ((at - lastAt) / 1000) : undefined
    let text = `${p.phase === 'processing' ? '正在合并或转码' : p.phase === 'preparing' ? '正在解析或准备下载' : '下载仍在进行'}：已运行约 ${Math.floor(p.elapsedMs / 60000)} 分钟，当前任务文件约 ${size(p.bytes)}。`
    if (p.phase === 'downloading' && p.totalBytes && Number.isFinite(p.totalBytes) && p.totalBytes >= p.bytes)
      text += `预计总量 ${size(p.totalBytes)}，进度约 ${Math.min(99, Math.floor(p.bytes / p.totalBytes * 100))}%。`
    if (speed !== undefined) text += `近期文件增长速度约 ${size(speed)}/s。`
    if (at - unchangedSince >= intervalMs) text += '暂未观察到进度增长，仍在等待处理或源站响应。'
    lastAt = at; lastBytes = p.bytes; lastPhase = p.phase
    try { notify(text) } catch { /* Delivery failure must not terminate downloading. */ }
  }
}
