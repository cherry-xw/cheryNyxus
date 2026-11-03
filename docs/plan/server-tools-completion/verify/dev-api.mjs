// Only local development authentication and read-only RPCs; never calls a model or saves config.
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

const WebSocket = createRequire(`${process.cwd()}/package.json`)('ws')
const methods = new Set(['config.get', 'brain.list', 'utils.modelRecommendation'])

async function check(origin) {
  let cookie = ''
  async function http(path, body, csrf) {
    const result = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin, Cookie: cookie,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    })
    const cookies = result.headers.getSetCookie()
    if (cookies.length) cookie = cookies.map(value => value.split(';')[0]).join('; ')
    if (!result.ok) throw new Error(`${path}: HTTP ${result.status}`)
    return result.json()
  }
  const capability = await http('/api/auth/capabilities')
  const session = await http('/api/browser-session/local', {}, capability.csrfToken)
  const discovery = await http('/api/config')
  const ticket = await http('/api/browser-session/ws-ticket', { expectedRevision: session.revision }, session.csrfToken)
  const url = new URL(discovery.wsUrl)
  if (url.port !== '8182' || !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Refusing non-development WebSocket')
  url.pathname = ticket.wsPath
  for (const [key, value] of Object.entries({
    ticket: ticket.ticket, bootstrapVersion: 1, protocolVersion: 1,
    instanceId: discovery.bootstrap.instanceId, capabilityRevision: discovery.bootstrap.revision,
  })) url.searchParams.set(key, String(value))
  const ws = new WebSocket(url, { origin, headers: { Cookie: cookie }, handshakeTimeout: 5000 })
  const pending = new Map()
  ws.on('message', buffer => {
    if (buffer[0] !== 123) return
    const frame = JSON.parse(buffer.toString())
    const waiter = frame.kind === 'response' ? pending.get(frame.requestId) : undefined
    if (!waiter) return
    clearTimeout(waiter.timeout)
    pending.delete(frame.requestId)
    if (frame.success) waiter.resolve(frame.data)
    else waiter.reject(new Error(`${waiter.method}: ${frame.error?.code ?? 'unknown'}`))
  })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  function rpc(method, params) {
    if (!methods.has(method)) throw new Error('Read-only RPC allowlist rejected method')
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`RPC timeout: ${method}`))
      }, 10000)
      pending.set(id, { resolve, reject, timeout, method })
      ws.send(JSON.stringify({ kind: 'request', id, method, params }))
    })
  }
  try {
    const before = await rpc('config.get', {})
    const brains = await rpc('brain.list', {})
    const capabilities = []
    for (const input of [
      { provider: 'custom', protocol: 'anthropic-messages', model: 'co-glm-5.3' },
      { provider: 'openai', protocol: 'openai-responses', model: 'gpt-6.1-sol' },
    ]) {
      const result = await rpc('utils.modelRecommendation', {
        ...input, connection: { url: 'https://ai.xcherry.top/v1', key: '$API_KEY' },
      })
      const state = result.serviceCapabilities
      if (!state) throw new Error('Missing serviceCapabilities')
      capabilities.push({
        ...input, nativeInput: state.nativeInput, serverTools: state.serverTools,
        connectionIdentified: state.connectionIdentified, verification: state.verification,
        catalogComplete: state.catalogComplete, observationError: Boolean(state.observationError),
        knownTools: state.knownTools.map(tool => ({
          name: tool.name, sources: tool.sources,
          observationStatus: tool.observation?.status, verificationStatus: tool.verification?.status,
        })),
      })
    }
    const after = await rpc('config.get', {})
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const configUnchanged = digest(before) === digest(after)
    if (!configUnchanged) throw new Error('Configuration changed during read-only verification')
    return {
      origin, httpLogin: 'passed', websocket: 'passed', configUnchanged,
      configuredBrains: (brains.brains ?? []).map(brain => ({ name: brain.name, model: brain.model, protocol: brain.protocol })),
      capabilities,
    }
  } finally { ws.close() }
}

try {
  const result = { checkedAt: new Date().toISOString(), modelRequests: 0, configWrites: 0, origins: [] }
  for (const origin of ['http://localhost:8183', 'http://localhost:5173']) result.origins.push(await check(origin))
  await writeFile('/tmp/opencode/server-tools-dev-api.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
