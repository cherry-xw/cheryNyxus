import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { createWebServer } from '../../apps/web/deploy/docker/web-server.mjs'

test('independent Web serves SPA and proxies HTTP/WS to only the configured backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nyxus-web-'))
  await writeFile(join(root, 'index.html'), '<html>synthetic web</html>')
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        path: req.url,
        origin: req.headers.origin,
        host: req.headers.host,
        forwarded: req.headers['x-forwarded-host'] ?? null,
      }),
    )
  })
  const wss = new WebSocketServer({ server: upstream })
  wss.on('connection', (socket) => socket.on('message', (data) => socket.send(data)))
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const target = `http://127.0.0.1:${upstream.address().port}`
  const server = createWebServer({ root, backendHttp: target, backendWs: target })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal(await (await fetch(base + '/nested/chat')).text(), '<html>synthetic web</html>')
    assert.equal((await fetch(base + '/missing.js')).status, 404)
    assert.equal((await fetch(base + '/%2e%2e%2foutside')).status, 403)
    assert.equal(await (await fetch(base + '/healthz')).text(), 'ok')
    const response = await fetch(base + '/api/config?probe=1', {
      headers: { Origin: base, 'X-Forwarded-Host': 'untrusted' },
    })
    assert.deepEqual(await response.json(), {
      path: '/api/config?probe=1',
      origin: base,
      host: new URL(base).host,
      forwarded: null,
    })
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin: base })
    await once(socket, 'open')
    socket.send('synthetic-wire')
    const [message] = await once(socket, 'message')
    assert.equal(message.toString(), 'synthetic-wire')
    socket.close()
    await once(socket, 'close')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => wss.close(resolve))
    await new Promise((resolve) => upstream.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
test('deployment has one backend, paused ingress, explicit installs and independent management', async () => {
  const compose = await readFile(new URL('../../deployment/compose.yaml', import.meta.url), 'utf8')
  assert.match(compose, /name: cherynyxus/)
  assert.doesNotMatch(compose, /internal: true|docker.sock|  relay:/)
  assert.match(compose, /CHERY_MANAGER_BACKEND_MODE: external/)
  assert.match(compose, /QQ_INGRESS_PAUSED: \$\{QQ_INGRESS_PAUSED:-1\}/)
  assert.match(compose, /WEB_PORT: "8283"/)
  const entry = await readFile(
    new URL('../../apps/backend/deploy/docker/backend-entrypoint.sh', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(entry, /ingress enable|ingress install/)
  assert.match(entry, /CHERY_CHANNEL_AUTH=/)
  assert.match(entry, /readyNotification:"qq.connection.ready"/)
  assert.match(entry, /CHERY_PLUGIN_RUNTIME_OPTIONS=/)
  assert.match(compose, /CHERY_INGRESS_INSTALL_ROOT: \/app\/opt/)
  const dockerfile = await readFile(new URL('../../apps/backend/deploy/docker/Dockerfile', import.meta.url), 'utf8')
  assert.match(dockerfile, /plugins\/settings\/dist/)
})
