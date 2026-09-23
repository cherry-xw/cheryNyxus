import { createServer } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { freemem, loadavg, totalmem, uptime } from 'node:os'
import yaml from 'js-yaml'
import { ProcessController } from './processController.js'
import { CredentialStore } from './credentials.js'
import { isTokenValid, loadOrCreateToken } from './tokenStore.js'
import { verifyLogin } from './verifyLogin.js'
import { writeManagerPage as writeRetroManagerPage } from './page.js'

export interface ManagerOptions {
  host?: string
  port?: number
  backendCommand?: string
  backendArgs?: string[]
  ratholeCommand?: string
  ratholeArgs?: string[]
  controlToken?: string
  tokenFile?: string
  relayStatusFile?: string
  backendStatusFile?: string
  configFile?: string
  credentialsFile?: string
}

export function createManager(options: ManagerOptions = {}) {
  const controller = new ProcessController()
  const cheryDir = process.env.CHERY_DIR ?? process.cwd()
  // 管理控制密钥：显式配置（CHERY_MANAGER_TOKEN）优先；否则持久化到 .chery/manager-token.json，
  // 重启后保持稳定，超过轮换周期（7 天）在启动时自动轮换，旧密钥 24 小时内仍可用（读取/续期）。
  const tokenState = loadOrCreateToken(
    options.tokenFile ?? `${cheryDir}/.chery/manager-token.json`,
    options.controlToken,
  )
  const controlToken = tokenState.token
  const backendCommand = options.backendCommand ?? process.execPath
  const backendArgs = options.backendArgs ?? ['dist/index.js']
  const ratholeCommand = options.ratholeCommand ?? 'rathole'
  const ratholeArgs = options.ratholeArgs ?? ['--config', 'rathole-client.toml']
  const credentialStore = new CredentialStore({
    configFile: options.configFile ?? `${cheryDir}/.chery/config.yaml`,
    credentialsFile: options.credentialsFile ?? `${cheryDir}/.chery/manager-credentials.json`,
  })
  const server = createServer(async (req, res) => {
    const presented = readPresentedToken(req)
    const tokenAuthorized = isTokenValid(tokenState, presented)
    // 已认证（当前或宽限期旧密钥）的请求：下发续期密钥响应头与可读 Cookie，
    // 供页面记忆新密钥、刷新后无需再带 URL 密钥即可重新进入。
    if (tokenAuthorized) {
      res.setHeader('X-Chery-Manager-Token', controlToken)
      res.setHeader(
        'Set-Cookie',
        `chery-manager-token=${controlToken}; Path=/; Max-Age=7776000; SameSite=Strict`,
      )
    }
    // 内网（非本机）访问一律要求有效管理密钥：页面与全部 /api/* 都需携带
    //（URL ?token= 查询参数 / X-Chery-Manager-Token 请求头 / 密钥 Cookie）。
    // 本机回环保持原行为：只读接口免密钥、控制接口仍需当前密钥（Electron 本地发现依赖此豁免）。
    if (!isLoopbackAddress(req.socket.remoteAddress) && !tokenAuthorized) {
      res.writeHead(401, { 'Cache-Control': 'no-store' })
      res.end('Unauthorized')
      return
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/api/status' && req.method === 'GET') {
      json(res, 200, {
        manager: 'running',
        processes: controller.state(),
        backend: await detectBackendStatus(options.backendStatusFile, options.configFile),
        relay: await readRelayStatus(options.relayStatusFile),
        system: readSystemMetrics(),
      })
      return
    }
    const match = /^\/api\/(backend|rathole)\/(start|stop|restart)$/.exec(path)
    if (match && (req.method === 'POST' || req.method === 'PUT')) {
      if (presented !== controlToken) {
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
      if (presented !== controlToken) {
        unauthorized(res)
        return
      }
      json(res, 200, await credentialStore.status())
      return
    }
    if (path === '/api/credentials/rotate' && (req.method === 'POST' || req.method === 'PUT')) {
      if (presented !== controlToken) {
        unauthorized(res)
        return
      }
      const body = await readJsonBody(req)
      const credentials = await credentialStore.rotate({
        username: typeof body.username === 'string' ? body.username : undefined,
        password: typeof body.password === 'string' ? body.password : undefined,
      })
      // 后端是管理器子进程 → 真正重启；否则（外部启动，如 dev / nodemon / systemd）不拉起
      // 会因端口占用而立刻崩溃的副本，交由后端自身的配置监听器自动重载新凭据（通常 1 秒内）。
      const managed = controller.isManaged('backend')
      const backendState = managed
        ? await controller.restart('backend', backendCommand, backendArgs)
        : { name: 'backend' as const, managed: false }
      const backend = { ...backendState, managed }
      // 用新凭据对后端做登录自检，确认已生效才提示成功，避免「以为生效了其实没有」。
      const network = await readBackendNetworkFromConfig(options.configFile)
      const verification = await verifyLogin(
        `http://127.0.0.1:${network.webPort}`,
        credentials.username,
        credentials.password ?? '',
      )
      json(res, 200, { credentials, backend, verification })
      return
    }
    if (path === '/' || path === '/index.html') {
       writeRetroManagerPage(res, !isLoopbackHost(options.host))
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

/**
 * 读取本地管理器在 config.yaml 中的监听地址（manager.host）。
 * 防御性解析：文件缺失 / 格式非法 / 类型不符一律返回 undefined，由调用方兜底默认 127.0.0.1。
 * 优先级：CHERY_MANAGER_HOST 环境变量 > 本字段 > 默认。
 */
export async function readManagerHostFromConfig(configFile: string): Promise<string | undefined> {
  try {
    const parsed = yaml.load(await readFile(configFile, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const manager = (parsed as Record<string, unknown>).manager
    if (typeof manager !== 'object' || manager === null || Array.isArray(manager)) return undefined
    const host = (manager as Record<string, unknown>).host
    return typeof host === 'string' && host ? host : undefined
  } catch {
    return undefined
  }
}

/** 完整取密钥来源：请求头 / URL 查询参数 / 密钥 Cookie（顺序取第一个非空）。 */
function readPresentedToken(req: import('node:http').IncomingMessage): string {
  const header = readControlToken(req)
  if (header) return header
  return readCookie(req, 'chery-manager-token')
}

function readCookie(req: import('node:http').IncomingMessage, name: string): string {
  const header = req.headers.cookie
  if (!header) return ''
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim()
      try {
        return decodeURIComponent(value)
      } catch {
        return value
      }
    }
  }
  return ''
}

/** 监听地址是否仅限本机回环（缺省 / localhost / 回环 IP 视为仅本机，非回环即开放内网访问）。 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true
  const h = host.toLowerCase()
  return h === '127.0.0.1' || h === '::1' || h === '::ffff:127.0.0.1' || h === 'localhost'
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

export function writeLegacyManagerPage(res: import('node:http').ServerResponse, host?: string): void {
  const lanAccess = !isLoopbackHost(host)
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CheryNyxus 本地管理器</title>
<style>body{max-width:1120px;margin:0 auto;padding:28px;background:#0d1118;color:#edf2f7;font:14px/1.55 system-ui,sans-serif}*{box-sizing:border-box}main{display:grid;gap:16px}header{display:flex;align-items:end;justify-content:space-between;gap:16px;margin-bottom:4px}h1{margin:0;font-size:24px;font-weight:600}h2{font-size:16px;margin:0;font-weight:600}.eyebrow{margin:0 0 5px;color:#91a0b2;font-size:12px;letter-spacing:.08em;text-transform:uppercase}.muted{color:#91a0b2}.ok{color:#76d69b}.warn{color:#f0c674}.error{color:#f28b8b}.toolbar,.monitor-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.toolbar{justify-content:flex-end}button,input{font:inherit;padding:8px 10px;border:1px solid #2b3745;background:#1b2430;color:inherit}button{cursor:pointer}button:hover{border-color:#67d6c0}button:focus-visible,input:focus-visible{outline:2px solid #67d6c0;outline-offset:2px}.panel{border:1px solid #2b3745;background:#151b24;padding:16px}.overview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.summary{min-height:112px;display:flex;flex-direction:column;justify-content:space-between}.summary-top{display:flex;justify-content:space-between;gap:12px}.summary-value{font-size:20px;font-weight:600}.summary-detail{margin:0;color:#91a0b2;font-size:13px}.status-dot{width:9px;height:9px;margin-top:6px;border-radius:50%;background:#91a0b2}.status-dot.ok{background:#76d69b}.status-dot.warn{background:#f0c674}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:14px}.metric{padding:12px;background:#1b2430;border:1px solid #2b3745}.metric-label,.metric-note{display:block;color:#91a0b2;font-size:12px}.metric-value{display:block;margin-top:4px;font-size:20px}.metric-note{margin-top:2px}.backend-meta{display:flex;flex-wrap:wrap;gap:8px 16px;margin:14px 0 0;color:#91a0b2;font-size:12px}.backend-meta strong{color:#edf2f7;font-weight:400}.processes{display:flex;flex-wrap:wrap;gap:6px 14px;margin:14px 0 0;padding:0;list-style:none}.processes li{color:#91a0b2}.processes li.ok{color:#76d69b}.processes li.warn{color:#f0c674}.credentials-grid{display:grid;grid-template-columns:minmax(180px,.7fr) minmax(0,1.3fr);gap:18px;align-items:start}.credential-state{min-height:76px}.credential-state pre{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.form-grid{display:grid;grid-template-columns:1fr 1.4fr;gap:10px}.field{display:flex;flex-direction:column;gap:4px}.field label{color:#91a0b2;font-size:12px}.password-row{display:flex;gap:8px}.password-row input{min-width:0;flex:1}.form-actions{display:flex;justify-content:flex-end;margin-top:10px}.primary{background:#67d6c0;border-color:#67d6c0;color:#09241f;font-weight:600}.message{min-height:22px;margin:10px 0 0}.lan-warning{padding:12px 14px;border:1px solid #735b2e;background:#2a2417;line-height:1.6}.lan-warning strong{color:#f0c674}@media(max-width:720px){body{padding:18px}.overview,.credentials-grid,.form-grid{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}header{align-items:start;flex-direction:column}.toolbar{width:100%;justify-content:space-between}}@media(max-width:420px){.metrics{grid-template-columns:1fr}.password-row{flex-wrap:wrap}.password-row input{flex:1 1 100%}.form-actions{justify-content:stretch}.form-actions button{flex:1}}</style>
<style>.credential-state{display:none}.credentials-grid{grid-template-columns:1fr}</style>
<main><header><div><p class="eyebrow">Local observability</p><h1>CheryNyxus 本地管理器</h1></div><div class="toolbar"><span id="last-updated" class="muted">等待状态…</span><button id="refresh" type="button">刷新状态</button></div></header>
${lanAccess ? `<div class="lan-warning" role="alert"><strong><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 2 1 21h22L12 2zm1 13h-2v2h2v-2zm0-6h-2v4h2V9z"/></svg>安全警告：局域网访问已开启</strong>当前管理页面可被同网段的任意设备访问，唯一的保护是启动日志里的管理密钥（?token=）。密钥一旦泄露，攻击者可查看 / 修改后端登录凭据、启停后端与中转。请仅在受信任网络使用；使用后建议改回仅本机访问（把 .chery/config.yaml 的 manager.host 改为 127.0.0.1）。</div>` : ''}
<section class="overview"><article class="panel summary"><div class="summary-top"><div><p class="eyebrow">运行状态</p><div id="availability" class="summary-value muted">读取中…</div></div><span id="availability-dot" class="status-dot" aria-hidden="true"></span></div><p id="availability-detail" class="summary-detail">正在读取后端可用性</p></article><article class="panel summary"><div class="summary-top"><div><p class="eyebrow">本地登录凭据</p><div id="credential-summary" class="summary-value muted">读取中…</div></div><span id="credential-dot" class="status-dot" aria-hidden="true"></span></div><p id="credentials" class="summary-detail">正在读取凭据状态</p></article></section>
<section class="panel"><div class="monitor-head"><div><p class="eyebrow">Backend monitor</p><h2>后端运行状态与数据统计</h2></div><span class="muted">只读监视</span></div><div class="metrics"><div class="metric"><span class="metric-label">运行中任务</span><strong id="running-chats" class="metric-value">—</strong><span class="metric-note">当前正在执行的会话</span></div><div class="metric"><span class="metric-label">当前活跃调用</span><strong id="active-runs" class="metric-value">—</strong><span class="metric-note">当前进行中的调用</span></div><div class="metric"><span class="metric-label">已初始化会话</span><strong id="initialized-chats" class="metric-value">—</strong><span class="metric-note">后端内存中的会话</span></div><div class="metric"><span class="metric-label">内存使用</span><strong id="memory" class="metric-value">—</strong><span class="metric-note">管理器所在主机</span></div><div class="metric"><span class="metric-label">系统负载</span><strong id="load" class="metric-value">—</strong><span class="metric-note">1 分钟平均值</span></div><div class="metric"><span class="metric-label">后端进程</span><strong id="backend-process" class="metric-value">—</strong><span id="backend-process-note" class="metric-note">等待状态</span></div></div><div class="backend-meta"><span>状态更新时间：<strong id="backend-updated">—</strong></span><span>后端地址：<strong id="backend-address">—</strong></span></div><ul id="processes" class="processes" aria-label="相关进程状态"></ul></section>
<section class="panel"><div class="monitor-head"><div><p class="eyebrow">Credentials</p><h2>本地登录凭据</h2></div><span class="muted">保存后自动校验</span></div><div class="credentials-grid"><div class="credential-state"><div id="credential-detail" class="muted">正在读取…</div><pre id="credential-value" class="muted"></pre></div><form id="rotate"><div class="form-grid"><div class="field"><label for="username">用户名（必填）</label><input id="username" autocomplete="username" placeholder="如 admin"></div><div class="field"><label for="password">新密码（留空自动生成）</label><div class="password-row"><input id="password" type="password" autocomplete="new-password" placeholder="留空自动生成"><button id="toggle-password" type="button">显示</button><button id="random-password" type="button">随机生成</button></div></div></div><div class="form-actions"><button type="submit" class="primary">保存凭据并生效</button></div><p id="message" class="message" role="status" aria-live="polite"></p></form></div></section></main>
<script>
const TOKEN_KEY='chery-manager-token';const $=id=>document.getElementById(id);const show=(id,text,cls='')=>{$(id).textContent=text;$(id).className=cls};
const urlToken=new URLSearchParams(location.search).get('token')||'';
if(urlToken){localStorage.setItem(TOKEN_KEY,urlToken);const u=new URL(location.href);u.searchParams.delete('token');history.replaceState(null,'',u.pathname+u.search+u.hash)}
const tk=()=>{const v=localStorage.getItem(TOKEN_KEY);if(v)return v;const m=document.cookie.match(new RegExp('(?:^|; )'+TOKEN_KEY+'=([^;]+)'));return m?decodeURIComponent(m[1]):''};
const renew=r=>{const next=r.headers.get('X-Chery-Manager-Token');if(next&&next!==tk()){localStorage.setItem(TOKEN_KEY,next);show('message','管理密钥已自动更新。','ok')}};
let loading=false;async function load(){if(loading)return;loading=true;try{const r=await fetch('/api/status',{headers:{'X-Chery-Manager-Token':tk()}});if(!r.ok)throw new Error('HTTP '+r.status);renew(r);const s=await r.json();const procs=s.processes||[];const procLine=(name,on)=>{const li=document.createElement('li');li.textContent=name+'：'+(on?'运行中':'未运行');li.className=on?'ok':'warn';return li};const ul=$('processes');ul.textContent='';ul.append(procLine('后端',(s.backend||{}).status==='running'));ul.append(procLine('中转 (rathole)',procs.find(p=>p.name==='rathole')?.running));ul.append(procLine('中继 (relay)',(s.relay||{}).status==='running'));const b=s.backend||{};const avail=$('availability');if(b.status==='running'){const wp=b.addresses&&b.addresses.local?b.addresses.local.httpPort:8183;const u='http://'+location.hostname+':'+wp+'/';avail.innerHTML='后端可用：<a href="'+u+'">'+u+'</a>';avail.className='ok'}else{avail.textContent='后端未运行';avail.className='warn'}const c=await fetch('/api/credentials',{headers:{'X-Chery-Manager-Token':tk()}});if(c.ok){renew(c);const cred=await c.json();if(cred.password){show('credentials','用户名：'+cred.username+'\\n密码：'+cred.password+'\\n状态：'+(cred.consistent?'一致':'不一致'),cred.consistent?'ok':'warn')}else if(!cred.username){show('credentials','用户名：未设置\\n后端 Web 登录尚未配置：请填写下方用户名与密码并提交。','muted')}else{show('credentials','用户名：'+cred.username+'\\n状态：'+(cred.consistent?'一致':'需要生成或同步'),cred.consistent?'ok':'warn')}}else show('credentials','需要管理密钥：请从启动日志中的 URL 打开本页。','muted')}catch(e){show('message','读取失败：'+e.message,'error')}finally{loading=false}}
function formatTime(value){return value?new Date(value).toLocaleTimeString():'未知'}
function formatPercent(value){return typeof value==='number'?Math.round(value*100)+'%':'不可用'}
function formatLoad(value){return typeof value==='number'&&value>0?value.toFixed(2):'不可用'}
async function syncCredentialsToInputs(){try{const r=await fetch('/api/credentials',{headers:{'X-Chery-Manager-Token':tk()}});if(!r.ok)return;renew(r);const cred=await r.json();$('username').value=cred.username||'';$('password').value=cred.password||''}catch{}}
async function loadDashboard(){if(loading)return;loading=true;show('message','');try{const r=await fetch('/api/status',{headers:{'X-Chery-Manager-Token':tk()}});if(!r.ok)throw new Error('HTTP '+r.status);renew(r);const s=await r.json();const b=s.backend||{};const a=b.agents||{};const system=s.system||{};const procs=s.processes||[];const procLine=(name,on)=>{const li=document.createElement('li');li.textContent=name+'：'+(on?'运行中':'未运行');li.className=on?'ok':'warn';return li};const ul=$('processes');ul.textContent='';ul.append(procLine('后端',b.status==='running'));ul.append(procLine('中转 (rathole)',procs.find(p=>p.name==='rathole')?.running));ul.append(procLine('中继 (relay)',(s.relay||{}).status==='running'));const running=b.status==='running';show('availability',running?'后端在线':'后端未运行',running?'ok':'warn');$('availability-dot').className='status-dot '+(running?'ok':'warn');$('availability-detail').textContent=running?'可通过本机地址访问':'请确认后端进程和监听端口';$('running-chats').textContent=typeof a.runningChats==='number'?a.runningChats:'—';$('active-runs').textContent=typeof a.activeRuns==='number'?a.activeRuns:'—';$('initialized-chats').textContent=typeof a.initializedChats==='number'?a.initializedChats:'—';$('memory').textContent=formatPercent(system.memoryUsedRatio);$('load').textContent=formatLoad(system.load1);$('backend-process').textContent=running?'运行中':'未运行';$('backend-process-note').textContent=b.pid?'PID '+b.pid:'由外部进程管理';$('backend-updated').textContent=formatTime(b.updatedAt);const wp=b.addresses&&b.addresses.local?b.addresses.local.httpPort:8183;$('backend-address').textContent=running?'http://'+location.hostname+':'+wp:'不可用';$('last-updated').textContent='刷新于 '+new Date().toLocaleTimeString();const c=await fetch('/api/credentials',{headers:{'X-Chery-Manager-Token':tk()}});if(c.ok){renew(c);const cred=await c.json();const consistent=Boolean(cred.consistent);show('credential-summary',consistent?'已配置':'需要配置',consistent?'ok':'warn');$('credential-dot').className='status-dot '+(consistent?'ok':'warn');$('credentials').textContent=cred.username?'用户名：'+cred.username:'尚未设置用户名';$('credential-detail').textContent=cred.username?'当前凭据':'后端 Web 登录尚未配置';$('credential-value').textContent=cred.password?'密码：'+cred.password:''}else{show('credential-summary','需要密钥','warn');$('credential-dot').className='status-dot warn';$('credentials').textContent='请从启动日志中的管理 URL 打开本页';$('credential-detail').textContent='无法读取凭据';$('credential-value').textContent=''}}catch(e){show('message','读取失败：'+e.message,'error');$('last-updated').textContent='刷新失败'}finally{loading=false}}
function randomPassword(){const b=new Uint8Array(12);crypto.getRandomValues(b);let s='';for(let i=0;i<12;i++)s+=String.fromCharCode(b[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_')}
$('random-password').onclick=()=>{$('password').value=randomPassword();show('message','已生成 16 位随机密码，点击「显示」可查看原文。','ok')};
$('toggle-password').onclick=()=>{const p=$('password');const show=p.type==='password';p.type=show?'text':'password';$('toggle-password').textContent=show?'隐藏':'显示'};
$('rotate').onsubmit=async e=>{e.preventDefault();const username=$('username').value.trim();let password=$('password').value.trim();if(!username){show('message','用户名必填','error');return}if(!password){password=randomPassword();$('password').value=password;show('message','密码留空，已自动生成随机密码。','ok')}const btn=$('rotate').querySelector('button[type=submit]');const btnLabel=btn.textContent;btn.disabled=true;btn.textContent='处理中…';try{const r=await fetch('/api/credentials/rotate',{method:'POST',headers:{'Content-Type':'application/json','X-Chery-Manager-Token':tk()},body:JSON.stringify({username,password})});if(!r.ok)throw new Error('HTTP '+r.status);renew(r);const data=await r.json();const v=data.verification||{};if(v.status==='verified'){show('message','凭据已更新，新密码已确认生效。请用新用户名/密码重新登录；若前端记住了旧密码，请更新后再登录。','ok')}else if(v.status==='unreachable'){show('message','凭据已更新，但后端不可达，未能确认新密码已生效；请确认后端已启动后重试登录。','warn')}else{show('message','凭据已更新，但后端尚未确认新密码（可能未自动重载）。若登录仍失败，请手动重启后端。','warn')}await loadDashboard()}catch(err){show('message','更新失败：'+err.message,'error')}finally{btn.disabled=false;btn.textContent=btnLabel}};
const rotateHandler=$('rotate').onsubmit;$('rotate').onsubmit=async event=>{await rotateHandler(event);await syncCredentialsToInputs()};
$('refresh').onclick=()=>{loadDashboard();syncCredentialsToInputs()};loadDashboard();syncCredentialsToInputs();setInterval(()=>{loadDashboard();syncCredentialsToInputs()},10000);document.addEventListener('visibilitychange',()=>{if(!document.hidden){loadDashboard();syncCredentialsToInputs()}});
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

/** 后端状态文件（CHERY_BACKEND_STATUS_FILE）的解析结果。 */
interface BackendStatusData {
  status: string
  addresses?: unknown
  agents?: unknown
  updatedAt?: string
}

async function readBackendStatus(file: string | undefined): Promise<BackendStatusData> {
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

/** Manager 所在主机的只读压力快照；load average 在 Windows 上通常不可用。 */
function readSystemMetrics(): {
  memoryUsedRatio: number
  load1: number | undefined
  uptimeSeconds: number
} {
  const total = totalmem()
  return {
    memoryUsedRatio: total > 0 ? (total - freemem()) / total : 0,
    load1: loadavg()[0] || undefined,
    uptimeSeconds: uptime(),
  }
}

/**
 * 读取 config.yaml 里后端的监听信息：server.port（WS）与 server.webPort（HTTP）。
 * 防御性解析：缺失 / 格式非法一律回退默认 8182 / 8183。
 */
export async function readBackendNetworkFromConfig(
  configFile: string | undefined,
): Promise<{ host: string; wsPort: number; webPort: number }> {
  if (!configFile) return { host: '127.0.0.1', wsPort: 8182, webPort: 8183 }
  try {
    const parsed = yaml.load(await readFile(configFile, 'utf8'))
    const server =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).server
        : undefined
    const s =
      typeof server === 'object' && server !== null && !Array.isArray(server)
        ? (server as Record<string, unknown>)
        : {}
    return {
      host: typeof s.host === 'string' && s.host ? s.host : '127.0.0.1',
      wsPort: typeof s.port === 'number' ? s.port : 8182,
      webPort: typeof s.webPort === 'number' ? s.webPort : 8183,
    }
  } catch {
    return { host: '127.0.0.1', wsPort: 8182, webPort: 8183 }
  }
}

/** 探测 host:port 是否可连接（后端存活性检查）。 */
export function isPortOpen(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(false))
  })
}

/**
 * 后端运行状态：状态文件优先（含 agents 统计），缺失时探测 config.yaml 的 server.port。
 * 地址回退到 config.yaml 的 server.webPort / server.port，供页面构造后端访问 URL。
 */
async function detectBackendStatus(
  statusFile: string | undefined,
  configFile: string | undefined,
): Promise<unknown> {
  const network = await readBackendNetworkFromConfig(configFile)
  const probeHost = network.host === '0.0.0.0' || network.host === '::' ? '127.0.0.1' : network.host
  const fileData = await readBackendStatus(statusFile)
  const listening = await isPortOpen(probeHost, network.wsPort)
  const fallbackAddresses = {
    local: { httpPort: network.webPort, websocketPort: network.wsPort },
  }
  if (listening || fileData.status === 'running') {
    return {
      status: 'running',
      addresses: fileData.addresses ?? fallbackAddresses,
      ...(fileData.agents ? { agents: fileData.agents } : {}),
      ...(typeof fileData.updatedAt === 'string' ? { updatedAt: fileData.updatedAt } : {}),
    }
  }
  return { status: 'stopped', addresses: fallbackAddresses }
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}
