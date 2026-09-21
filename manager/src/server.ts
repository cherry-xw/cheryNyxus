import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { ProcessController } from './processController.js'
import { CredentialStore } from './credentials.js'

export interface ManagerOptions {
  host?: string
  port?: number
  backendCommand?: string
  backendArgs?: string[]
  ratholeCommand?: string
  ratholeArgs?: string[]
  controlToken?: string
  relayStatusFile?: string
  backendStatusFile?: string
  configFile?: string
  credentialsFile?: string
}

export function createManager(options: ManagerOptions = {}) {
  const controller = new ProcessController()
  // 管理控制密钥：显式配置优先；未配置时启动自动生成随机密钥。
  // 密钥随启动日志的可点击 URL（?token=）一并提供，内网访问点击即可直达。
  const controlToken = options.controlToken || randomBytes(24).toString('base64url')
  const backendCommand = options.backendCommand ?? process.execPath
  const backendArgs = options.backendArgs ?? ['dist/index.js']
  const ratholeCommand = options.ratholeCommand ?? 'rathole'
  const ratholeArgs = options.ratholeArgs ?? ['--config', 'rathole-client.toml']
  const cheryDir = process.env.CHERY_DIR ?? process.cwd()
  const credentialStore = new CredentialStore({
    configFile: options.configFile ?? `${cheryDir}/.chery/config.yaml`,
    credentialsFile: options.credentialsFile ?? `${cheryDir}/.chery/manager-credentials.json`,
  })
  const server = createServer(async (req, res) => {
    // 内网（非本机）访问一律要求有效管理密钥：页面与全部 /api/* 都需携带
    //（URL ?token= 查询参数或 X-Chery-Manager-Token 请求头）。本机回环保持原行为：
    // 只读接口免密钥、控制接口仍需密钥（Electron 本地发现依赖此豁免）。
    if (!isLoopbackAddress(req.socket.remoteAddress) && readControlToken(req) !== controlToken) {
      res.writeHead(401, { 'Cache-Control': 'no-store' })
      res.end('Unauthorized')
      return
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/api/status' && req.method === 'GET') {
      json(res, 200, {
        manager: 'running',
        processes: controller.state(),
        backend: await readBackendStatus(options.backendStatusFile),
        relay: await readRelayStatus(options.relayStatusFile),
      })
      return
    }
    const match = /^\/api\/(backend|rathole)\/(start|stop|restart)$/.exec(path)
    if (match && (req.method === 'POST' || req.method === 'PUT')) {
      if (!hasControlToken(req, controlToken)) {
        res.writeHead(401, { 'Cache-Control': 'no-store' })
        res.end('Unauthorized')
        return
      }
      const name = match[1] as 'backend' | 'rathole'
      const action = match[2]
      const result =
        action === 'stop'
          ? await controller.stop(name)
          : action === 'restart'
            ? await controller.restart(
                name,
                name === 'backend' ? backendCommand : ratholeCommand,
                name === 'backend' ? backendArgs : ratholeArgs,
              )
            : controller.start(
                name,
                name === 'backend' ? backendCommand : ratholeCommand,
                name === 'backend' ? backendArgs : ratholeArgs,
              )
      json(res, 200, result)
      return
    }
    if (path === '/api/connection' && req.method === 'GET') {
      json(res, 200, {
        processes: controller.state(),
        backend: controller.state().find((process) => process.name === 'backend') ?? {
          status: 'unknown',
        },
        backendListener: await readBackendStatus(options.backendStatusFile),
        tunnel: await readRelayStatus(options.relayStatusFile),
      })
      return
    }
    if (path === '/api/credentials' && req.method === 'GET') {
      if (!hasControlToken(req, controlToken)) {
        unauthorized(res)
        return
      }
      json(res, 200, await credentialStore.status())
      return
    }
    if (path === '/api/credentials/rotate' && (req.method === 'POST' || req.method === 'PUT')) {
      if (!hasControlToken(req, controlToken)) {
        unauthorized(res)
        return
      }
      const body = await readJsonBody(req)
      const credentials = await credentialStore.rotate({
        username: typeof body.username === 'string' ? body.username : undefined,
        password: typeof body.password === 'string' ? body.password : undefined,
      })
      const backend = await controller.restart('backend', backendCommand, backendArgs)
      json(res, 200, { credentials, backend })
      return
    }
    if (path === '/' || path === '/index.html') {
      writeManagerPage(res)
      return
    }
    res.writeHead(404)
    res.end('Not Found')
  })
  return {
    controller,
    token: controlToken,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port ?? 39980, options.host ?? '127.0.0.1', () => resolve())
      }),
    address: () => server.address() as AddressInfo | null,
    close: async () => {
      await controller.stopAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** 回环地址判定：127.0.0.1 / ::1 / IPv4 映射回环。 */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1' ||
    remoteAddress === '::ffff:127.0.0.1%0'
  )
}

/** 请求携带的管理密钥：优先 X-Chery-Manager-Token 请求头，其次 URL ?token= 查询参数。 */
export function readControlToken(req: import('node:http').IncomingMessage): string {
  const header = req.headers['x-chery-manager-token']
  if (typeof header === 'string' && header) return header
  return new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? ''
}

function hasControlToken(req: import('node:http').IncomingMessage, token: string | undefined): boolean {
  return Boolean(token && readControlToken(req) === token)
}

function unauthorized(res: import('node:http').ServerResponse): void {
  res.writeHead(401, { 'Cache-Control': 'no-store' })
  res.end('Unauthorized')
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 16 * 1024) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
}

function writeManagerPage(res: import('node:http').ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CheryNyxus 本地管理器</title>
<style>body{max-width:920px;margin:0 auto;padding:32px;background:#11151b;color:#eef2f7;font:15px system-ui,sans-serif}main{display:grid;gap:16px}section{border:1px solid #34404e;padding:20px;background:#171d25}h1{margin-top:0}h2{font-size:18px;margin:0 0 12px}pre{white-space:pre-wrap;overflow-wrap:anywhere}button,input{font:inherit;padding:8px 10px;border:1px solid #59687b;background:#202a36;color:inherit}button{cursor:pointer}button:focus-visible{outline:2px solid #77c7ff;outline-offset:2px}form{display:flex;gap:8px;flex-wrap:wrap}.ok{color:#7ee2a8}.warn{color:#ffd27d}.error{color:#ff8f9b}.muted{color:#9eabbc}</style>
<main><h1>CheryNyxus 本地管理器</h1>
<section><h2>运行状态</h2><p id="availability" class="muted">等待后端状态…</p><pre id="status" class="muted">正在读取…</pre><button id="refresh" type="button">刷新状态</button></section>
<section><h2>本地登录凭据</h2><p class="muted">凭据只保存在本机受保护文件，不会发送到中转。</p><pre id="credentials" class="muted">正在读取…</pre>
<form id="rotate"><input id="manager-token" type="password" autocomplete="off" placeholder="管理控制密钥"><input id="username" autocomplete="username" placeholder="用户名（可选）"><input id="password" type="password" autocomplete="new-password" placeholder="新密码（留空自动生成）"><button type="submit">修改 / 重新生成</button></form></section>
<p id="message" role="status" aria-live="polite"></p></main>
<script>
const $=id=>document.getElementById(id);const show=(id,text,cls='')=>{$(id).textContent=text;$(id).className=cls};
const urlToken=new URLSearchParams(location.search).get('token')||'';
if(urlToken)$('manager-token').value=urlToken;
async function load(){try{const r=await fetch('/api/status');if(!r.ok)throw new Error('HTTP '+r.status);const status=await r.json();show('status',JSON.stringify(status,null,2));const b=status.backend||{};const avail=$('availability');if(b.status==='running'){const wp=b.addresses&&b.addresses.local?b.addresses.local.httpPort:8183;const u='http://'+location.hostname+':'+wp+'/';avail.innerHTML='后端可用：<a href="'+u+'">'+u+'</a>';avail.className='ok'}else{avail.textContent='后端未运行';avail.className='warn'}const c=await fetch('/api/credentials',{headers:{'X-Chery-Manager-Token':$('manager-token').value}});if(c.ok){const cred=await c.json();show('credentials',cred.password?'用户名：'+cred.username+'\\n密码：'+cred.password+'\\n状态：'+(cred.consistent?'一致':'不一致'):'用户名：'+(cred.username||'未设置')+'\\n状态：'+(cred.consistent?'一致':'需要生成或同步'),cred.consistent?'ok':'warn')}else show('credentials','请输入管理控制密钥后查看','muted')}catch(e){show('message','读取失败：'+e.message,'error')}}
$('refresh').onclick=load;$('rotate').onsubmit=async e=>{e.preventDefault();try{const r=await fetch('/api/credentials/rotate',{method:'POST',headers:{'Content-Type':'application/json','X-Chery-Manager-Token':$('manager-token').value},body:JSON.stringify({username:$('username').value,password:$('password').value})});if(!r.ok)throw new Error('HTTP '+r.status);show('message','凭据已更新，请重启后端使新密码生效。','ok');await load()}catch(err){show('message','更新失败：'+err.message,'error')}};load();
</script>`)
}

async function readRelayStatus(file: string | undefined): Promise<unknown> {
  if (!file) return { status: 'unknown' }
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    return {
      status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
      ...(typeof parsed.backendId === 'string' ? { backendId: parsed.backendId } : {}),
      ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
      ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
    }
  } catch {
    return { status: 'unknown' }
  }
}

async function readBackendStatus(file: string | undefined): Promise<unknown> {
  if (!file) return { status: 'unknown' }
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    return {
      status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
      ...(parsed.addresses && typeof parsed.addresses === 'object'
        ? { addresses: parsed.addresses }
        : {}),
      ...(parsed.agents && typeof parsed.agents === 'object' ? { agents: parsed.agents } : {}),
      ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
    }
  } catch {
    return { status: 'unknown' }
  }
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}
