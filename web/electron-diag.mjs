// 临时诊断脚本（用后即删）：复刻 createManagedWindow 参数开受管窗，
// 捕获页面 console / did-fail-load / render-process-gone，5s 后截图存盘。
import { app, BrowserWindow, ipcMain } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const PRELOAD = join(here, 'dist-electron', 'preload.mjs')
const BASE = 'http://localhost:5173/'

function log(m) { console.log(`[diag] ${m}`) }

app.whenReady().then(async () => {
  // preload sendSync 依赖的兜底 handler（复刻 main.ts 默认值路径）
  ipcMain.on('get-backend-config', (event) => {
    event.returnValue = { wsPort: 8182, webPort: 8183, transport: 'binary' }
  })

  const surfaces = [
    { name: 'settings', q: 'surface=settings' },
    { name: 'workbench', q: 'surface=workbench&presetId=diag-test' },
  ]

  for (const s of surfaces) {
    const win = new BrowserWindow({
      width: 900,
      height: 650,
      show: false,
      backgroundColor: '#16181d',
      frame: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: PRELOAD,
      },
    })
    win.webContents.on('console-message', (_e, level, msg) => {
      if (level >= 2) log(`[${s.name}] page-console(L${level}): ${msg}`)
    })
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      log(`[${s.name}] DID-FAIL-LOAD ${code} ${desc} ${url}`)
    })
    win.webContents.on('render-process-gone', (_e, d) => {
      log(`[${s.name}] RENDER-PROCESS-GONE ${d.reason} ${d.exitCode}`)
    })
    win.webContents.on('did-finish-load', () => log(`[${s.name}] did-finish-load`))
    win.webContents.on('did-fail-provisional-load', (_e, code, desc, url) => {
      log(`[${s.name}] DID-FAIL-PROVISIONAL-LOAD ${code} ${desc} ${url}`)
    })
    win.once('ready-to-show', () => {
      win.show()
      log(`[${s.name}] ready-to-show`)
    })
    log(`[${s.name}] loading ${BASE}?${s.q}`)
    try {
      await win.loadURL(`${BASE}?${s.q}`)
    } catch (e) {
      log(`[${s.name}] loadURL rejected: ${e.message}`)
    }
    await new Promise((r) => setTimeout(r, 6000))
    try {
      const img = await win.webContents.capturePage()
      writeFileSync(join(here, `diag-${s.name}.png`), img.toPNG())
      log(`[${s.name}] screenshot saved (${img.getSize().width}x${img.getSize().height})`)
    } catch (e) {
      log(`[${s.name}] capture failed: ${e.message}`)
    }
    win.destroy()
  }
  app.quit()
})
