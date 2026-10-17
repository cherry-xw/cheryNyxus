import http from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const idPattern = /^[1-9]\d{0,19}$/
export function validateTask(input) {
  const { subject, command, scope = 'auto', cwd = '.', limits = {} } = input ?? {}
  if (!subject || !idPattern.test(subject.userId) || !idPattern.test(subject.selfId) || !['private', 'group'].includes(subject.conversationType)) throw new Error('Invalid subject')
  if (subject.conversationType === 'group' && !idPattern.test(subject.groupId)) throw new Error('Invalid group')
  if (typeof command !== 'string' || !command.trim() || command.length > 8000) throw new Error('Invalid command')
  if (!['auto', 'personal', 'group'].includes(scope) || (scope === 'group' && subject.conversationType !== 'group')) throw new Error('Invalid scope')
  if (typeof cwd !== 'string' || cwd.length > 240 || path.isAbsolute(cwd) || cwd.includes('\\') || cwd.split('/').some(p => p === '..') || cwd.includes('\0')) throw new Error('Invalid cwd')
  const bounded = (name, fallback, min, max) => {
    const value = limits[name] ?? fallback
    if (!Number.isFinite(value) || value < min || value > max) throw new Error('Invalid resource limit')
    return value
  }
  return { subject, command, cwd, scope: scope === 'auto' ? (subject.conversationType === 'group' ? 'group' : 'personal') : scope,
    cpu: bounded('workerCpuCores', 2, 0.5, 8), memory: bounded('workerMemoryMb', 2048, 256, 8192),
    pids: bounded('workerPidsLimit', 256, 32, 1024), maxMb: bounded('workerMaxDownloadMb', 1024, 50, 1024),
    threads: bounded('workerThreadCount', 4, 1, 16), bubbleMb: bounded('workerBubbleVideoMaxMb', 200, 20, 500) }
}
async function safeDirectory(root, relative) {
  let current = path.resolve(root)
  for (const part of relative.split('/').filter(p => p && p !== '.')) {
    current = path.join(current, part)
    await fs.mkdir(current, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e })
    const st = await fs.lstat(current)
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe directory')
  }
  return current
}
export function createWorkerController(options) {
  let active = false
  return http.createServer(async (req, res) => {
    const streaming = req.headers.accept === 'application/x-ndjson'
    const respond = (status, data) => { if (!res.destroyed) {
      if (!res.headersSent) res.writeHead(status, { 'content-type': streaming ? 'application/x-ndjson' : 'application/json' })
      res.end(streaming ? JSON.stringify({ type: 'result', data }) + '\n' : JSON.stringify(data))
    } }
    if (req.method === 'GET' && req.url === '/health') return respond(200, { ok: true, active })
    if (req.method !== 'POST' || req.url !== '/exec') return respond(404, { error: 'Not found' })
    if (active) return respond(409, { error: 'Worker busy; retry only after current task ends' })
    let task
    try {
      let text = ''
      for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 32768) throw new Error('Request too large') }
      task = validateTask(JSON.parse(text))
    } catch { return respond(400, { error: 'Invalid worker request' }) }
    if (active) return respond(409, { error: 'Worker busy' })
    active = true
    const name = `cherynyxus-qq-task-${randomUUID()}`
    const startedAt = Date.now()
    let child, cancelled = false
    const stop = () => {
      if (res.writableEnded) return
      cancelled = true
      void exec('docker', ['rm', '-f', name]).catch(() => {})
    }
    res.once('close', stop)
    try {
      const relative = task.scope === 'group' ? `groups/${task.subject.groupId}` : task.subject.userId
      const workspace = await safeDirectory(options.fileRoot, relative)
      await safeDirectory(workspace, task.cwd)
      const mediaScope = task.subject.conversationType === 'group' ? `group-${task.subject.groupId}` : `user-${task.subject.userId}`
      const media = await safeDirectory(options.mediaRoot, `scoped/${mediaScope}`)
      const args = ['run', '--rm', '--name', name, '--label', 'org.cherynyxus.qq-task=true', '--init',
        '--user', `${process.getuid()}:${process.getgid()}`, '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--read-only', '--cpus', String(task.cpu), '--memory', `${task.memory}m`, '--memory-swap', `${task.memory}m`,
        '--pids-limit', String(task.pids), '--network', options.network || 'bridge',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777',
        '--tmpfs', '/workspace/files/apps:rw,nosuid,nodev,noexec,size=1m,mode=000', '--workdir', `/workspace/files/${task.cwd}`,
        '--mount', `type=bind,src=${workspace},dst=/workspace/files`,
        '--mount', `type=bind,src=${media},dst=/workspace/media`,
        '--mount', `type=bind,src=${options.skillsRoot},dst=/opt/qq-skills,readonly`,
        '--env', 'HTTP_PROXY=', '--env', 'HTTPS_PROXY=', '--env', 'ALL_PROXY=',
        '--env', 'http_proxy=', '--env', 'https_proxy=', '--env', 'all_proxy=',
        '--env', 'TERM=dumb', '--env', 'COLUMNS=120', '--env', 'LINES=40', '--env', 'HOME=/tmp', '--env', 'CHERY_MEDIA_DIR=/workspace/media',
        '--env', `QQ_MAX_DOWNLOAD_MB=${task.maxMb}`, '--env', `QQ_MAX_DOWNLOAD_BYTES=${task.maxMb * 1024 * 1024}`,
        '--env', `QQ_WORKER_THREADS=${task.threads}`, '--env', `QQ_BUBBLE_VIDEO_MAX_MB=${task.bubbleMb}`,
        '--env', 'QQ_SKILLS_SCRIPTS_DIR=/opt/qq-skills/video-download/scripts',
        '--entrypoint', '/usr/bin/bash', options.image, '-c', task.command]
      if (cancelled) throw new Error('Cancelled')
      child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = '', bytes = 0, truncated = false
      const append = (key, chunk) => {
        const remaining = Math.max(0, 131072 - bytes)
        const text = chunk.subarray(0, remaining).toString('utf8'); bytes += chunk.length
        truncated ||= chunk.length > remaining
        if (key === 'out') stdout += text; else stderr += text
      }
      let progressBuffer = ''
      child.stdout.on('data', c => append('out', c))
      child.stderr.on('data', c => {
        progressBuffer += c.toString('utf8')
        let end
        while ((end = progressBuffer.indexOf('\n')) >= 0) {
          const line = progressBuffer.slice(0, end); progressBuffer = progressBuffer.slice(end + 1)
          if (line.startsWith('QQ_PROGRESS:')) {
            try {
              const data = JSON.parse(line.slice(12))
              if (streaming && !res.destroyed && !res.writableNeedDrain && ['preparing', 'downloading', 'processing'].includes(data.phase) && Number.isFinite(data.bytes) && data.bytes >= 0) {
                if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/x-ndjson' })
                res.write(JSON.stringify({ type: 'progress', data: { phase: data.phase, bytes: data.bytes, ...(Number.isFinite(data.totalBytes) && data.totalBytes > 0 ? { totalBytes: data.totalBytes } : {}), elapsedMs: Date.now() - startedAt } }) + '\n')
              }
            } catch {}
          } else append('err', Buffer.from(line + '\n'))
        }
        if (progressBuffer.length > 16384) { append('err', Buffer.from(progressBuffer)); progressBuffer = '' }
      })
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
      if (progressBuffer) append('err', Buffer.from(progressBuffer))
      respond(200, { ok: code === 0, exitCode: code, stdout, stderr, truncated, durationMs: Date.now() - startedAt,
        mediaScope, appliedLimits: { cpuCores: task.cpu, memoryMb: task.memory, pidsLimit: task.pids } })
    } catch { respond(500, { ok: false, error: 'Worker execution failed' }) }
    finally {
      res.removeListener('close', stop)
      await exec('docker', ['rm', '-f', name]).catch(() => {})
      active = false
    }
  })
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const socket = process.env.QQ_WORKER_SOCKET
  if (!socket) throw new Error('QQ_WORKER_SOCKET required')
  const options = { fileRoot: process.env.QQ_WORKER_FILES_ROOT, mediaRoot: process.env.QQ_WORKER_MEDIA_ROOT,
    skillsRoot: process.env.QQ_WORKER_SKILLS_ROOT, image: process.env.QQ_WORKER_IMAGE, network: process.env.QQ_WORKER_NETWORK }
  for (const key of ['fileRoot', 'mediaRoot', 'skillsRoot', 'image']) if (!options[key]) throw new Error(`Missing ${key}`)
  await fs.mkdir(path.dirname(socket), { recursive: true, mode: 0o700 })
  await fs.unlink(socket).catch(e => { if (e.code !== 'ENOENT') throw e })
  const server = createWorkerController(options)
  server.listen(socket, async () => { await fs.chmod(socket, 0o600); console.log('QQ worker controller ready') })
}
