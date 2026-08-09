import { execFileSync } from 'node:child_process'

/**
 * 释放前后端 dev 端口：若被占用则 kill 占用进程。
 *
 * 默认端口：
 *   5173  前端 Vite dev（web/vite.config.ts strictPort）
 *   8182  后端 WebSocket（config.server.port）
 *   8183  后端 HTTP / WEB_PORT
 *
 * 覆盖：`KILL_PORTS=5173,8182 pnpm kill:ports` 或 `pnpm kill:ports 5173 8182`
 *
 * 行为：
 *   - 端口空闲 -> 跳过
 *   - 占用 -> 按端口 PID 反查 PGID，SIGTERM 整个进程组（连带 guardian/父进程，
 *     避免只杀 worker 被守护进程重生），1s 后仍存活 -> SIGKILL
 *   - 多端口同属一组 -> 去重，只杀一次
 *   - lsof 缺失 -> 抛错退出（不静默吞）
 *
 * 设计原因：本项目 dev 链 pnpm->nodemon->guardian->worker，worker 持端口、
 * guardian 会重生。按端口单杀无效，必须杀进程组根除。
 */

const DEFAULT_PORTS = [5173, 8182, 8183]

const argPorts = process.argv.slice(2).map(Number).filter((n) => n > 0)
const envPorts =
  process.env.KILL_PORTS?.split(',').map(Number).filter((n) => n > 0) ?? []
const ports = argPorts.length ? argPorts : envPorts.length ? envPorts : DEFAULT_PORTS

function listPids(port) {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' })
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
  } catch {
    // lsof 非零退出 = 无进程监听该端口
    return []
  }
}

// 同步睡 ms（node 20+，避免 CPU 空转）
const syncSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// 反查 PID 所属进程组 ID（pgid）
function pgidOf(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' })
    const n = Number(out.trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

// 杀整个进程组：SIGTERM -> 1s 探活 -> SIGKILL
function killGroup(pgid) {
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch {
    return false
  }
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0) // 组内仍有进程则不抛
    } catch {
      return true // 组已空
    }
    syncSleep(50)
  }
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    /* 组已空 */
  }
  return true
}

let killed = 0
const seenPgid = new Set()
for (const port of ports) {
  const pids = listPids(port)
  if (!pids.length) {
    console.log(`:${port} 空闲`)
    continue
  }
  for (const pid of pids) {
    const pgid = pgidOf(pid)
    if (!pgid || seenPgid.has(pgid)) {
      // 无 pgid（进程已退出）或同组已处理
      console.log(`:${port} pid ${pid} (pgid ${pgid ?? '?'}) skipped`)
      continue
    }
    seenPgid.add(pgid)
    killGroup(pgid)
    console.log(`:${port} pid ${pid} killed pgid ${pgid}`)
    killed++
  }
}

console.log(killed ? `done, killed ${killed} process group(s)` : 'no process killed')
