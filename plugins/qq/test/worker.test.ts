import { describe, it, expect } from 'vitest'
import { validateTask } from '../src/workerController.mjs'
import { executeQQWorker } from '../src/workerClient.js'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const subject = { selfId: '123456', userId: '649207438', groupId: '805107001', conversationType: 'group' }
describe('QQ isolated worker', () => {
  it('validates trusted identity, relative directories and actual Docker resource ranges', () => {
    const task = validateTask({ subject, command: 'true', limits: { workerCpuCores: 0.5, workerMemoryMb: 256 } })
    expect(task.scope).toBe('group'); expect(task.cpu).toBe(0.5); expect(task.memory).toBe(256)
    for (const change of [{ subject: { ...subject, userId: '../x' } }, { cwd: '../../etc' }, { limits: { workerCpuCores: NaN } }, { limits: { workerMaxDownloadMb: 1025 } }]) {
      expect(() => validateTask({ subject, command: 'true', ...change })).toThrow()
    }
    expect(() => validateTask({ subject: { ...subject, conversationType: 'private' }, scope: 'group', command: 'true' })).toThrow()
  })
  it('parses split progress frames without exposing them as command output', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-worker-stream-'))
    const socket = path.join(dir, 'control.sock')
    const server = createServer(async (req, res) => {
      for await (const _ of req) { /* consume */ }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      const frame = JSON.stringify({ type: 'progress', data: { phase: 'downloading', bytes: 1024, elapsedMs: 50 } }) + '\n'
      res.write(frame.slice(0, 10))
      setTimeout(() => res.end(frame.slice(10) + JSON.stringify({ type: 'result', data: { ok: true, exitCode: 0 } }) + '\n'), 10)
    })
    await new Promise<void>(resolve => server.listen(socket, resolve))
    const events: unknown[] = []
    try {
      expect(await executeQQWorker(socket, {}, undefined, p => events.push(p))).toEqual({ ok: true, exitCode: 0 })
      expect(events).toEqual([{ phase: 'downloading', bytes: 1024, elapsedMs: 50 }])
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }) }
  })
  it('uses a protected Unix socket and does not cancel when the request body ends', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-worker-client-'))
    const socket = path.join(dir, 'control.sock')
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk
      expect(JSON.parse(body).command).toBe('true')
      setTimeout(() => res.end(JSON.stringify({ ok: true, exitCode: 0 })), 30)
    })
    await new Promise<void>(resolve => server.listen(socket, resolve))
    try { expect(await executeQQWorker(socket, { command: 'true' })).toEqual({ ok: true, exitCode: 0 }) }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }) }
  })
})
