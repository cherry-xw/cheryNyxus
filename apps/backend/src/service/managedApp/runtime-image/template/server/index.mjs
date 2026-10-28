import { WebSocketServer } from 'ws'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import Busboy from 'busboy'
import Papa from 'papaparse'
import { z } from 'zod'
import { getDb, runMigrations } from './db.mjs'
import { clearActivationToken, ensureActivationToken, validActivationToken } from './activation.mjs'

const PORT = Number(process.env.PORT || 3000)
const APP_ID = process.env.APP_ID || 'local-app'
const APP_OWNER_ID = process.env.APP_OWNER_ID || '0'
const APP_VISIBILITY = process.env.APP_VISIBILITY === 'public_read' ? 'public_read' : 'private'
const APP_BASE = (process.env.APP_BASE || `/qq/${APP_OWNER_ID}/apps/${APP_ID}/`).replace(
  /\/?$/,
  '/',
)
const DATA_DIR = process.env.DATA_DIR || '/data'
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')
const DIST_DIR = path.resolve(process.cwd(), 'dist')
const SESSION_COOKIE_NAME = `chery_app_sid_${APP_ID.replace(/[^a-z0-9]/gi, '_')}`

fs.mkdirSync(UPLOADS_DIR, { recursive: true })
const db = getDb()
runMigrations(db)

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex')
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const derived = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${derived}`
}

function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored).split(':')
  if (!salt || !expectedHex) return false
  const derived = crypto.scryptSync(password, salt, 64)
  const expected = Buffer.from(expectedHex, 'hex')
  if (derived.length !== expected.length) return false
  return crypto.timingSafeEqual(derived, expected)
}

function sanitizeCsvCell(val) {
  const str = val === null || val === undefined ? '' : String(val)
  if (/^[=+\-@]/.test(str)) {
    return `'${str}`
  }
  return str
}

ensureActivationToken(db)

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
)
app.use(cookieParser())
app.use(express.json({ limit: '1mb' }))
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: true,
  legacyHeaders: false,
})
app.use('/api', apiLimiter)

// 鉴权与会话解析中间件
app.use((req, _res, next) => {
  req.authUser = null
  req.csrfToken = null
  const rawSid = req.cookies?.[SESSION_COOKIE_NAME]
  if (!rawSid) return next()

  const row = db
    .prepare(
      `SELECT s.token_hash, s.csrf_token, s.expires_at, u.id as user_id, u.username, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(hashToken(rawSid))

  if (!row || Number(row.expires_at) < Date.now()) {
    return next()
  }

  req.authUser = {
    id: Number(row.user_id),
    username: String(row.username),
    role: String(row.role),
  }
  req.csrfToken = String(row.csrf_token)
  next()
})

function requireAuth(minRoles = ['owner', 'admin', 'member', 'viewer']) {
  return (req, res, next) => {
    if (!req.authUser) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: '请先登录或激活管理员账户' },
      })
    }
    if (!minRoles.includes(req.authUser.role)) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: '当前角色权限不足' },
      })
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const clientCsrf = req.get('x-csrf-token')
      if (!clientCsrf || clientCsrf !== req.csrfToken) {
        return res.status(403).json({
          error: { code: 'CSRF_MISMATCH', message: 'CSRF 校验失败，请刷新页面重试' },
        })
      }
    }
    next()
  }
}

function issueSessionCookie(res, userId) {
  const rawSid = crypto.randomBytes(32).toString('base64url')
  const csrfToken = crypto.randomBytes(24).toString('base64url')
  const now = Date.now()
  const expiresAt = now + 7 * 24 * 60 * 60 * 1000
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(hashToken(rawSid), userId, csrfToken, expiresAt, now)

  res.cookie(SESSION_COOKIE_NAME, rawSid, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_INSECURE === '1' ? false : true,
    path: APP_BASE,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
  return csrfToken
}

const requireAppLogin = requireAuth()
function requireReadAccess(req, res, next) {
  return APP_VISIBILITY === 'public_read' ? next() : requireAppLogin(req, res, next)
}

// 1. 网关与控制器固定健康检查入口
app.get('/__app_health', (_req, res) => {
  const userCount = Number(
    db.prepare('SELECT COUNT(*) as cnt FROM users').get()?.cnt || 0,
  )
  const pendingToken = userCount === 0 ? ensureActivationToken(db) : null

  res.json({
    ok: true,
    appId: APP_ID,
    ownerId: APP_OWNER_ID,
    appBase: APP_BASE,
    activated: userCount > 0,
    activationToken: pendingToken,
  })
})

// 2. 鉴权状态、一次性激活、登录、注销
app.get('/api/auth/me', (req, res) => {
  const userCount = Number(
    db.prepare('SELECT COUNT(*) as cnt FROM users').get()?.cnt || 0,
  )
  res.json({
    activated: userCount > 0,
    user: req.authUser,
    csrfToken: req.csrfToken,
    appId: APP_ID,
    appBase: APP_BASE,
    visibility: APP_VISIBILITY,
  })
})

const activateSchema = z.object({
  activationToken: z.string().min(8),
  username: z.string().min(2).max(32),
  password: z.string().min(6).max(128),
})

app.post('/api/auth/activate', (req, res) => {
  const parsed = activateSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: parsed.error.message } })
  }

  const userCount = Number(
    db.prepare('SELECT COUNT(*) as cnt FROM users').get()?.cnt || 0,
  )
  if (userCount > 0) {
    return res.status(409).json({
      error: { code: 'ALREADY_ACTIVATED', message: '管理员已激活，请直接登录' },
    })
  }

  if (!validActivationToken(db, parsed.data.activationToken)) {
    return res.status(403).json({
      error: { code: 'INVALID_ACTIVATION_TOKEN', message: '一次性激活令牌无效或已过期' },
    })
  }

  const now = Date.now()
  let info
  db.exec('BEGIN IMMEDIATE;')
  try {
    info = db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(parsed.data.username, hashPassword(parsed.data.password), 'owner', now)
    clearActivationToken(db)
    db.exec('COMMIT;')
  } catch (error) {
    db.exec('ROLLBACK;')
    throw error
  }

  const csrfToken = issueSessionCookie(res, Number(info.lastInsertRowid))
  res.json({
    ok: true,
    user: {
      id: Number(info.lastInsertRowid),
      username: parsed.data.username,
      role: 'owner',
    },
    csrfToken,
  })
})

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

app.post('/api/auth/login', (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: '请输入用户名和密码' } })
  }
  const user = db
    .prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?')
    .get(parsed.data.username)

  if (!user || !verifyPassword(parsed.data.password, user.password_hash)) {
    return res.status(401).json({
      error: { code: 'INVALID_CREDENTIALS', message: '用户名或密码错误' },
    })
  }

  const csrfToken = issueSessionCookie(res, Number(user.id))
  res.json({
    ok: true,
    user: {
      id: Number(user.id),
      username: String(user.username),
      role: String(user.role),
    },
    csrfToken,
  })
})

app.post('/api/auth/logout', requireAuth(), (req, res) => {
  const rawSid = req.cookies?.[SESSION_COOKIE_NAME]
  if (rawSid) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(rawSid))
  }
  res.clearCookie(SESSION_COOKIE_NAME, { path: APP_BASE })
  res.json({ ok: true })
})

// 3. 业务记录 CRUD + ECharts 聚合统计
app.get('/api/records', requireReadAccess, (req, res) => {
  const category = req.query.category ? String(req.query.category) : null
  const q = req.query.q ? `%${String(req.query.q)}%` : null

  let sql = 'SELECT * FROM records WHERE 1=1'
  const params = []
  if (category) {
    sql += ' AND category = ?'
    params.push(category)
  }
  if (q) {
    sql += ' AND (title LIKE ? OR note_md LIKE ?)'
    params.push(q, q)
  }
  sql += ' ORDER BY id DESC LIMIT 200'

  const items = db.prepare(sql).all(...params)
  const stats = db
    .prepare(
      'SELECT category, COUNT(*) as count, COALESCE(SUM(amount), 0) as totalAmount FROM records GROUP BY category ORDER BY totalAmount DESC',
    )
    .all()

  res.json({ items, stats })
})

const recordInputSchema = z.object({
  title: z.string().min(1).max(120),
  category: z.string().min(1).max(40).default('默认'),
  amount: z.number().finite().default(0),
  status: z.enum(['active', 'done', 'archived']).default('active'),
  note_md: z.string().max(10_000).default(''),
})

app.post('/api/records', requireAuth(['owner', 'admin', 'member']), (req, res) => {
  const parsed = recordInputSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: parsed.error.message } })
  }
  const now = Date.now()
  const info = db
    .prepare(
      `INSERT INTO records (title, category, amount, status, note_md, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      parsed.data.title,
      parsed.data.category,
      parsed.data.amount,
      parsed.data.status,
      parsed.data.note_md,
      req.authUser.username,
      now,
      now,
    )

  const created = db
    .prepare('SELECT * FROM records WHERE id = ?')
    .get(Number(info.lastInsertRowid))
  res.status(201).json({ item: created })
})

app.delete('/api/records/:id', requireAuth(['owner', 'admin']), (req, res) => {
  db.prepare('DELETE FROM records WHERE id = ?').run(Number(req.params.id))
  res.json({ ok: true })
})

// 4. CSV 导入与安全导出（自动转义 =,+,-,@ 防公式注入）
app.get('/api/records/export.csv', requireReadAccess, (req, res) => {
  const rows = db.prepare('SELECT id, title, category, amount, status, note_md, created_at FROM records ORDER BY id ASC').all()
  const safeRows = rows.map(r => ({
    id: r.id,
    title: sanitizeCsvCell(r.title),
    category: sanitizeCsvCell(r.category),
    amount: r.amount,
    status: sanitizeCsvCell(r.status),
    note_md: sanitizeCsvCell(r.note_md),
    created_at: r.created_at,
  }))
  const csv = Papa.unparse(safeRows)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="records-export.csv"')
  res.send(csv)
})

app.post('/api/records/import-csv', requireAuth(['owner', 'admin', 'member']), (req, res) => {
  const csvText = typeof req.body?.csv === 'string' ? req.body.csv : ''
  if (!csvText.trim()) {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'CSV 内容为空' } })
  }
  const parsed = Papa.parse(csvText.trim(), { header: true, skipEmptyLines: true })
  const insertStmt = db.prepare(
    `INSERT INTO records (title, category, amount, status, note_md, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const now = Date.now()
  let imported = 0
  db.exec('BEGIN IMMEDIATE;')
  try {
    for (const row of parsed.data.slice(0, 500)) {
      const title = String(row.title || row.标题 || '').trim()
      if (!title) continue
      const category = String(row.category || row.分类 || '导入').trim()
      const amount = Number(row.amount ?? row.金额 ?? 0) || 0
      const note = String(row.note_md ?? row.备注 ?? '')
      insertStmt.run(title, category, amount, 'active', note, req.authUser.username, now, now)
      imported++
    }
    db.exec('COMMIT;')
  } catch (err) {
    db.exec('ROLLBACK;')
    throw err
  }
  res.json({ ok: true, imported })
})

// 5. 受控附件上传与安全下载（强制 Content-Disposition: attachment）
const ALLOWED_EXTS = new Set(['.txt', '.csv', '.json', '.md', '.png', '.jpg', '.jpeg', '.pdf'])

app.post('/api/attachments', requireAuth(['owner', 'admin', 'member']), (req, res) => {
  const bb = Busboy({
    headers: req.headers,
    limits: { files: 1, fileSize: 10 * 1024 * 1024 },
  })

  let savedAttachment = null
  let errorMsg = null
  const pendingWrites = []

  bb.on('file', (_name, file, info) => {
    const ext = path.extname(info.filename || '').toLowerCase()
    if (!ALLOWED_EXTS.has(ext)) {
      errorMsg = `不支持的文件后缀: ${ext}`
      file.resume()
      return
    }
    const id = crypto.randomUUID()
    const storedName = `${id}${ext}`
    const targetPath = path.join(UPLOADS_DIR, storedName)
    let sizeBytes = 0
    const out = fs.createWriteStream(targetPath, { mode: 0o600 })

    file.on('data', chunk => {
      sizeBytes += chunk.length
    })
    file.pipe(out)
    pendingWrites.push(
      new Promise(resolve => {
        out.on('close', () => {
          if (file.truncated) {
            fs.unlinkSync(targetPath)
            errorMsg = '文件超过 10 MiB 限制'
            return resolve()
          }
          const now = Date.now()
          db.prepare(
            'INSERT INTO attachments (id, original_name, stored_name, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(
            id,
            info.filename,
            storedName,
            info.mimeType || 'application/octet-stream',
            sizeBytes,
            now,
          )
          savedAttachment = {
            id,
            originalName: info.filename,
            sizeBytes,
            createdAt: now,
          }
          resolve()
        })
      }),
    )
  })

  bb.on('finish', async () => {
    await Promise.all(pendingWrites)
    if (errorMsg) {
      return res
        .status(400)
        .json({ error: { code: 'UPLOAD_REJECTED', message: errorMsg } })
    }
    if (!savedAttachment) {
      return res
        .status(400)
        .json({ error: { code: 'NO_FILE', message: '未收到上传文件' } })
    }
    res.status(201).json({ attachment: savedAttachment })
  })

  req.pipe(bb)
})

app.get('/api/attachments/:id', requireReadAccess, (req, res) => {
  const row = db
    .prepare('SELECT * FROM attachments WHERE id = ?')
    .get(String(req.params.id))
  if (!row) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '附件不存在' } })
  }
  const filePath = path.join(UPLOADS_DIR, String(row.stored_name))
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '附件文件缺失' } })
  }
  res.setHeader('Content-Type', String(row.mime_type))
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(String(row.original_name))}"`,
  )
  res.setHeader('X-Content-Type-Options', 'nosniff')
  fs.createReadStream(filePath).pipe(res)
})

// 6. 实时 SSE 事件流与受控后台任务进度演示
const sseClients = new Set()

function broadcastEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of sseClients) {
    client.write(payload)
  }
}

app.get('/events', requireReadAccess, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  res.write(`event: connected\ndata: ${JSON.stringify({ appId: APP_ID, ts: Date.now() })}\n\n`)
  sseClients.add(res)

  const hb = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`)
  }, 15_000)

  req.on('close', () => {
    clearInterval(hb)
    sseClients.delete(res)
  })
})

let activeBgTasks = 0
app.post('/api/tasks/demo', requireAuth(['owner', 'admin', 'member']), (_req, res) => {
  if (activeBgTasks >= 2) {
    return res.status(429).json({
      error: { code: 'TASK_LIMIT', message: '后台并发任务已达上限 (2)' },
    })
  }
  activeBgTasks++
  const jobId = `job_${Date.now()}`
  let progress = 0
  const timer = setInterval(() => {
    progress += 50
    broadcastEvent('task_progress', {
      jobId,
      progress,
      status: progress >= 100 ? 'completed' : 'running',
    })
    if (progress >= 100) {
      clearInterval(timer)
      activeBgTasks--
    }
  }, 150)

  res.status(202).json({ ok: true, jobId })
})

// 7. 静态资源与 SPA 路由回退（同时兼容 strip 前缀后的 /assets/* 与带 APP_BASE 前缀的访问）
if (fs.existsSync(DIST_DIR)) {
  const staticMiddleware = express.static(DIST_DIR, { index: false })
  app.use(staticMiddleware)
  if (APP_BASE !== '/') {
    app.use(APP_BASE.replace(/\/$/, ''), staticMiddleware)
  }
  app.get('*', (req, res, next) => {
    if (
      req.path.startsWith('/api/') ||
      req.path === '/__app_health' ||
      req.path === '/events'
    ) {
      return next()
    }
    const indexHtml = path.join(DIST_DIR, 'index.html')
    if (fs.existsSync(indexHtml)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      return res.sendFile(indexHtml)
    }
    next()
  })
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[chery-app:${APP_ID}] listening on 0.0.0.0:${PORT} (base=${APP_BASE})`)
})

const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 })
server.on('upgrade', (req, socket, head) => {
  if (req.url?.split('?')[0] !== '/ws' || req.headers.origin !== 'https://mini.xcherry.top') { socket.destroy(); return }
  const cookie = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${SESSION_COOKIE_NAME}=`))?.slice(SESSION_COOKIE_NAME.length + 1)
  const session = cookie && db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(hashToken(cookie), Date.now())
  if (!session) { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.on('message', (data, binary) => ws.send(data, { binary }))
    ws.on('error', () => ws.close())
  })
})

const shutdown = () => {
  for (const client of wss.clients) client.terminate()
  wss.close()
  for (const c of sseClients) {
    c.end()
  }
  server.close(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
