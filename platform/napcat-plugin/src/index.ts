import fs from 'node:fs'
import path from 'node:path'
import { Adapter } from './adapter.js'
import { BackendWire } from './wire.js'

const PLUGIN_VERSION = '0.2.15'
type Settings = { backendUrl?: string; backendToken?: string }
const instances = new WeakMap<object, Adapter>()
const operations = new WeakMap<object, Promise<void>>()
const stopped = new WeakSet<object>()

function readConfig(ctx: any): Settings {
  if (!ctx?.configPath || !fs.existsSync(ctx.configPath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(ctx.configPath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
function writeConfig(ctx: any, settings: Settings): void {
  fs.mkdirSync(path.dirname(ctx.configPath), { recursive: true, mode: 0o700 })
  const temp = `${ctx.configPath}.${Date.now()}.next`
  fs.writeFileSync(temp, JSON.stringify(settings, null, 2), { mode: 0o600 })
  fs.renameSync(temp, ctx.configPath)
}
function valid(settings: Settings): boolean {
  if (typeof settings.backendUrl !== 'string' || typeof settings.backendToken !== 'string' || !settings.backendToken || settings.backendToken.length > 4096) return false
  try {
    const url = new URL(settings.backendUrl)
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}
function publicConfig(ctx: any): Record<string, unknown> {
  const settings = readConfig(ctx)
  return { backendUrl: settings.backendUrl ?? '', backendTokenConfigured: Boolean(settings.backendToken) }
}
function get(ctx: any): Adapter | undefined { return instances.get(ctx) }
function serialize(ctx: any, action: () => Promise<void>): Promise<void> {
  const next = (operations.get(ctx) ?? Promise.resolve()).catch(() => {}).then(action)
  operations.set(ctx, next)
  return next
}
function publicStatus(ctx: any): Record<string, unknown> {
  const status = get(ctx)?.status()
  return {
    version: PLUGIN_VERSION,
    configured: valid(readConfig(ctx)),
    state: status?.state ?? 'unconfigured',
    ready: status?.ready ?? false,
    blockedTargets: status?.blockedTargets ?? 0,
    identity: status?.identity ?? { state: 'unavailable', sourceType: 'none', validation: 'rejected', diagnostic: 'source-missing' },
  }
}
async function startWithConfig(ctx: any): Promise<void> {
  get(ctx)?.close()
  instances.delete(ctx)
  if (stopped.has(ctx)) return
  const settings = readConfig(ctx)
  if (!valid(settings)) {
    ctx.logger?.warn?.('QQ plugin transport is not configured')
    return
  }
  const adapter = new Adapter(ctx, new BackendWire(settings.backendUrl!, settings.backendToken!))
  instances.set(ctx, adapter)
  await adapter.start()
}

const pageHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NapCat Plugin Chery Nyxus</title><style>body{font:14px system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 20px;color:#222}h1{font-size:22px}label{display:block;margin:18px 0 6px;font-weight:600}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #bbb;border-radius:4px}button{margin:20px 10px 0 0;padding:10px 16px;border:0;border-radius:4px;background:#1677ff;color:white;cursor:pointer}button.secondary{background:#666}#status{margin-top:24px;padding:14px;background:#f5f5f5;border-radius:4px;white-space:pre-wrap}.error{color:#b42318}small{color:#666}</style></head><body><h1>NapCat Plugin Chery Nyxus 设置</h1><p>配置 NapCatQQ 到 cheryNyxus Backend 的连接。Token 只用于连接认证，不会在状态中显示。</p><label>Backend 地址</label><input id="url" placeholder="ws://backend:8282"><label>平台 Token</label><input id="token" type="password" autocomplete="off" placeholder="从 Manager 复制的平台 Token"><small>保存后会立即关闭旧连接并重新执行 hello、身份绑定和恢复。</small><div><button id="save">保存并连接</button><button id="refresh" class="secondary">刷新状态</button></div><div id="status">正在读取状态...</div><script>const base='/api/Plugin/ext/napcat-plugin-cherynyxus';const $=id=>document.getElementById(id);function show(x){$('status').textContent=JSON.stringify(x,null,2);$('status').className=x.error?'error':''}async function load(){const r=await fetch(base+'/config');const x=await r.json();$('url').value=x.backendUrl||'';show(await (await fetch(base+'/status')).json())}async function save(){show({state:'connecting'});const r=await fetch(base+'/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backendUrl:$('url').value,backendToken:$('token').value})});const x=await r.json();$('token').value='';show(x)}$('save').onclick=save;$('refresh').onclick=load;load();setInterval(async()=>{try{show(await(await fetch(base+'/status')).json())}catch(e){show({error:'无法读取插件状态'})}},3000)</script></body></html>`

function registerWebUi(ctx: any): void {
  ctx.router?.get?.('/config', (_req: any, res: any) => {
    res.setHeader?.('Cache-Control', 'no-store')
    res.json(publicConfig(ctx))
  })
  ctx.router?.get?.('/status', (_req: any, res: any) => {
    res.setHeader?.('Cache-Control', 'no-store')
    res.json(publicStatus(ctx))
  })
  ctx.router?.post?.('/config', async (req: any, res: any) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      await plugin_set_config(ctx, { backendUrl: body.backendUrl, backendToken: body.backendToken })
      res.json(publicStatus(ctx))
    } catch { res.status(400).json({ error: '配置无效或保存失败，请检查地址、Token 和文件权限' }) }
  })
  ctx.router?.post?.('/reconnect', async (_req: any, res: any) => {
    try { await serialize(ctx, () => startWithConfig(ctx)); res.json(publicStatus(ctx)) }
    catch { res.status(400).json({ error: '重新连接失败，请查看状态和 NapCat 日志' }) }
  })
  ctx.router?.page?.({ path: 'settings', title: 'NapCat Plugin Chery Nyxus 设置', icon: '🔌', htmlFile: 'webui.html', description: '连接配置、握手状态与重新连接' })
}

export const plugin_config_schema = [
  { key: 'backendUrl', type: 'string', label: 'Backend 地址', description: '请从完整 QQ 插件设置页面配置 Backend 地址。', placeholder: '打开下方自定义页面' },
  { key: 'backendToken', type: 'string', label: '平台 Token', description: '请从完整 QQ 插件设置页面配置 Token。', placeholder: '打开下方自定义页面' },
] as const
export const plugin_config_ui = plugin_config_schema
export function plugin_get_config(ctx: any): Settings { return readConfig(ctx) }
export async function plugin_set_config(ctx: any, settings: Settings): Promise<void> {
  await serialize(ctx, async () => {
    if (!valid(settings)) throw new Error('Backend 地址或平台 Token 无效')
    writeConfig(ctx, { backendUrl: settings.backendUrl, backendToken: settings.backendToken })
    await startWithConfig(ctx)
  })
}
export async function plugin_init(ctx: any): Promise<void> {
  void pageHtml
  stopped.delete(ctx)
  registerWebUi(ctx)
  try { await serialize(ctx, () => startWithConfig(ctx)) } catch { ctx.logger?.warn?.('QQ plugin initialization blocked') }
}
export async function plugin_onmessage(ctx: any, event: unknown): Promise<void> { await get(ctx)?.receive(event) }
export async function plugin_cleanup(ctx: any): Promise<void> {
  stopped.add(ctx)
  get(ctx)?.close()
  await operations.get(ctx)?.catch(() => {})
  get(ctx)?.close()
  instances.delete(ctx)
}
export function plugin_status(ctx: any): unknown { return publicStatus(ctx) }
export { Adapter, BackendWire }
