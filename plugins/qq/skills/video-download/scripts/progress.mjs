import { readdir, lstat } from 'node:fs/promises'
import path from 'node:path'
let state
export function progressPhase(phase, totalBytes) {
  if (state) { state.phase = phase; state.totalBytes = totalBytes }
}
async function files(root, result = new Map()) {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) await files(file, result)
    else if (entry.isFile()) { const st = await lstat(file).catch(() => null); if (st?.isFile()) result.set(file, st.size) }
  }
  return result
}
export async function withVideoProgress(root, operation) {
  const baseline = await files(root)
  state = { phase: 'preparing', totalBytes: undefined }
  let busy = false, stopped = false
  const tick = async () => {
    if (busy || stopped) return
    busy = true
    try {
      const current = await files(root)
      let bytes = 0
      for (const [file, size] of current) if (!baseline.has(file)) bytes += size
      if (!stopped) process.stderr.write('QQ_PROGRESS:' + JSON.stringify({ ...state, bytes }) + '\n')
    } catch { /* Observability must not fail execution. */ }
    finally { busy = false }
  }
  await tick()
  const timer = setInterval(() => { void tick() }, 5000)
  timer.unref()
  try { return await operation() }
  finally { stopped = true; clearInterval(timer); state = undefined }
}
