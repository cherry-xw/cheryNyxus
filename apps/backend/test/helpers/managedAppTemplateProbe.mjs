// Run only against a temporary copy of the template in a network-disabled runtime container.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const project = process.cwd()
const root = await mkdtemp(path.join(os.tmpdir(), 'managed-template-probe-'))
const data = path.join(root, 'data')
const appId = 'offline-probe'
const base = `/qq/649207438/apps/${appId}/`
const endpoint = 'http://127.0.0.1:3000'
const { WebSocket } = createRequire(path.join(project, 'package.json'))('ws')
let child
let serverOutput = ''
let checks = 0

async function request(url, status = 200, options = {}) {
  const response = await fetch(`${endpoint}${url}`, { ...options, signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, status, `${options.method || 'GET'} ${url}`)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = options.method === 'HEAD' ? null : response.headers.get('content-type')?.includes('application/json')
    ? await response.json() : await response.text()
  checks++
  return { response, body }
}

function post(body, headers = {}) {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }
}

function session(response, body) {
  const cookie = response.headers.getSetCookie()[0]
  assert.ok(cookie?.startsWith(`chery_app_sid_${appId.replaceAll('-', '_')}=`))
  assert.match(cookie, /HttpOnly/i)
  assert.match(cookie, /Secure/i)
  assert.match(cookie, /SameSite=Lax/i)
  assert.ok(cookie.includes(`Path=${base}`))
  return { cookie: cookie.split(';')[0], 'x-csrf-token': body.csrfToken }
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const process = child
  const exited = once(process, 'exit')
  const timeout = setTimeout(() => process.kill('SIGKILL'), 5000)
  try { process.kill('SIGTERM'); await exited } finally { clearTimeout(timeout) }
}

async function start(visibility) {
  serverOutput = ''
  const env = { ...process.env, PORT: '3000', DATA_DIR: data, APP_ID: appId, APP_OWNER_ID: '649207438', APP_BASE: base }
  delete env.APP_VISIBILITY
  if (visibility !== undefined) env.APP_VISIBILITY = visibility
  child = spawn(process.execPath, ['server/index.mjs'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-8192) })
  child.stderr.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-8192) })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Template startup failed: ${serverOutput}`)
    try {
      const response = await fetch(`${endpoint}/api/auth/me`, { signal: AbortSignal.timeout(200) })
      if (response.ok) { await response.arrayBuffer(); return }
      await response.arrayBuffer()
    } catch { /* The server may not have bound its port yet. */ }
    await delay(50)
  }
  throw new Error(`Template startup timed out: ${serverOutput}`)
}

async function websocket(headers, allowed) {
  const socket = new WebSocket(`${endpoint.replace('http:', 'ws:')}/ws`, { headers, handshakeTimeout: 3000 })
  const timeout = setTimeout(() => socket.terminate(), 4000)
  try {
    if (!allowed) {
      await new Promise((resolve, reject) => {
        socket.once('open', () => reject(new Error('Unexpected WebSocket access')))
        socket.once('error', resolve)
        socket.once('close', resolve)
      })
    } else {
      await once(socket, 'open')
      const reply = once(socket, 'message')
      socket.send('offline-echo')
      assert.equal(String((await reply)[0]), 'offline-echo')
    }
    checks++
  } finally { clearTimeout(timeout); socket.terminate() }
}

try {
  await start()
  const me = await request('/api/auth/me')
  assert.equal(me.body.visibility, 'private')
  assert.equal(me.body.activated, false)
  assert.equal(me.body.user, null)
  assert.ok(!JSON.stringify(me.body).includes('activationToken'))
  const page = await request('/')
  assert.match(page.response.headers.get('content-type'), /text\/html/)
  await request('/nested/frontend/route')
  for (const url of ['/api/records', '/api/records/export.csv', '/api/attachments/missing', '/events']) {
    await request(url, 401)
    await request(url, 401, { method: 'HEAD' })
  }
  await request('/api/records', 401, post({ title: 'forbidden' }))
  await request('/api/tasks/demo', 401, post({}))
  await request('/api/auth/activate', 403, post({ activationToken: 'wrong-token', username: 'admin', password: 'test-password-only' }))

  const health = await request('/__app_health')
  const oldToken = health.body.activationToken
  assert.equal(typeof oldToken, 'string')
  const db = new DatabaseSync(path.join(data, 'app.sqlite'))
  try {
    db.prepare("UPDATE app_kv SET updated_at = ? WHERE key LIKE 'activation_token_%'").run(Date.now() - 30 * 60 * 1000)
    await request('/api/auth/activate', 403, post({ activationToken: oldToken, username: 'admin', password: 'test-password-only' }))
    assert.equal(db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt, 0)
    const before = db.prepare("SELECT updated_at FROM app_kv WHERE key = 'activation_token_plain'").get().updated_at
    await request('/api/auth/me')
    assert.equal(db.prepare("SELECT updated_at FROM app_kv WHERE key = 'activation_token_plain'").get().updated_at, before)
  } finally { db.close() }
  const renewed = await request('/__app_health')
  assert.notEqual(renewed.body.activationToken, oldToken)
  const credentials = { username: 'admin', password: 'test-password-only' }
  const activated = await request('/api/auth/activate', 200, post({ ...credentials, activationToken: renewed.body.activationToken }))
  const auth = session(activated.response, activated.body)
  assert.equal(activated.body.user.role, 'owner')
  await request('/api/auth/activate', 409, post({ ...credentials, activationToken: renewed.body.activationToken }))
  const activeHealth = await request('/__app_health')
  assert.equal(activeHealth.body.activationToken, null)
  const consumed = new DatabaseSync(path.join(data, 'app.sqlite'))
  try { assert.equal(consumed.prepare("SELECT COUNT(*) as cnt FROM app_kv WHERE key LIKE 'activation_token_%'").get().cnt, 0) }
  finally { consumed.close() }

  await request('/api/records', 403, post({ title: 'no-csrf' }, { cookie: auth.cookie }))
  const created = await request('/api/records', 201, post({ title: '=SUM(1,1)', category: 'offline', amount: 42 }, auth))
  assert.equal(created.body.item.amount, 42)
  const records = await request('/api/records', 200, { headers: auth })
  assert.equal(records.body.items.length, 1)
  assert.equal(records.body.stats[0].totalAmount, 42)
  const exported = await request('/api/records/export.csv', 200, { headers: auth })
  assert.ok(exported.body.includes("'=SUM(1,1)"))
  assert.match(exported.response.headers.get('content-disposition'), /attachment/)
  const imported = await request('/api/records/import-csv', 200, post({ csv: 'title,category,amount\nimported,offline,8' }, auth))
  assert.equal(imported.body.imported, 1)

  const upload = new FormData()
  upload.append('file', new Blob(['offline-attachment'], { type: 'text/plain' }), 'probe.txt')
  const uploaded = await request('/api/attachments', 201, { method: 'POST', headers: auth, body: upload })
  const attachmentUrl = `/api/attachments/${uploaded.body.attachment.id}`
  await request(attachmentUrl, 401)
  const downloaded = await request(attachmentUrl, 200, { headers: auth })
  assert.equal(downloaded.body, 'offline-attachment')
  assert.match(downloaded.response.headers.get('content-disposition'), /attachment/)

  const streamAbort = new AbortController()
  const stream = await fetch(`${endpoint}/events`, { headers: auth, signal: streamAbort.signal })
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get('content-type'), /text\/event-stream/)
  const reader = stream.body.getReader()
  const timeout = setTimeout(() => streamAbort.abort(), 5000)
  try {
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: connected/)
    await request('/api/tasks/demo', 202, post({}, auth))
    let progress = ''
    while (!progress.includes('completed')) {
      const next = await reader.read()
      assert.equal(next.done, false)
      progress += new TextDecoder().decode(next.value)
    }
    assert.match(progress, /task_progress/)
    checks++
  } finally { clearTimeout(timeout); await reader.cancel(); streamAbort.abort() }
  const wsHeaders = { origin: 'https://mini.xcherry.top', cookie: auth.cookie }
  await websocket(wsHeaders, true)
  await websocket({ origin: 'https://mini.xcherry.top' }, false)
  await websocket({ ...wsHeaders, origin: 'https://not-the-app.invalid' }, false)

  await request('/api/auth/logout', 200, post({}, auth))
  await request('/api/records', 401, { headers: auth })
  await request('/api/auth/login', 401, post({ ...credentials, password: 'wrong-password' }))
  const login = await request('/api/auth/login', 200, post(credentials))
  const restoredAuth = session(login.response, login.body)
  await stop()
  await start('private')
  const persisted = await request('/api/records', 200, { headers: restoredAuth })
  assert.equal(persisted.body.items.length, 2)
  assert.equal(persisted.body.stats[0].totalAmount, 50)
  assert.equal((await request(attachmentUrl, 200, { headers: restoredAuth })).body, 'offline-attachment')
  assert.equal((await request('/api/auth/me', 200, { headers: restoredAuth })).body.user.username, 'admin')
  await stop()

  await start('public_read')
  assert.equal((await request('/api/auth/me')).body.visibility, 'public_read')
  assert.equal((await request('/api/records')).body.items.length, 2)
  await request('/api/records/export.csv')
  assert.equal((await request(attachmentUrl)).body, 'offline-attachment')
  const publicStreamAbort = new AbortController()
  const publicStream = await fetch(`${endpoint}/events`, { signal: publicStreamAbort.signal })
  assert.equal(publicStream.status, 200)
  await publicStream.body.cancel(); publicStreamAbort.abort(); checks++
  await request('/api/records', 401, post({ title: 'forbidden' }))
  await request('/api/records/import-csv', 401, post({ csv: 'title\nforbidden' }))
  await request('/api/tasks/demo', 401, post({}))
  await websocket({ origin: 'https://mini.xcherry.top' }, false)
  const roles = new DatabaseSync(path.join(data, 'app.sqlite'))
  try { roles.prepare("UPDATE users SET role = 'viewer' WHERE username = 'admin'").run() }
  finally { roles.close() }
  await request('/api/records', 200, { headers: restoredAuth })
  await request('/api/records', 403, post({ title: 'viewer-cannot-write' }, restoredAuth))
  await request(`/api/records/${created.body.item.id}`, 403, { method: 'DELETE', headers: restoredAuth })
  await stop()

  await start('invalid')
  assert.equal((await request('/api/auth/me')).body.visibility, 'private')
  await request('/api/records', 401)
  console.log(JSON.stringify({ ok: true, checks, scenarios: ['private-read-auth', 'public-read-only', 'activation-expiry-and-consumption', 'cookie-csrf-roles', 'sqlite-csv-attachment', 'sse-websocket', 'restart-preserves-data'] }))
} finally {
  await stop()
  await rm(root, { recursive: true, force: true })
}
