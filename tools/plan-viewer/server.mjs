#!/usr/bin/env node
/**
 * Plan Viewer — 独立开发工具（与主项目代码、依赖、构建体系零关联）
 *
 * 读取 docs/plan 下的计划文档，提供：
 *   GET /                页面（产物模式：内嵌压缩资源；源码模式：public/ 目录）
 *   GET /api/plan        结构化计划数据（每次请求实时读盘，刷新即最新）
 *   GET /api/file?p=     读取 docs/plan 下单个 Markdown 文件原文
 *
 * 用法：
 *   node server.mjs [--port=4173] [--plan-dir=<docs/plan 目录>]
 *
 * docs/plan 定位优先级：--plan-dir 参数 > 环境变量 PLAN_DIR > 从脚本位置向上逐级查找。
 *
 * 依赖：仅 Node 内置模块，node >= 20，无需安装任何包。
 */

import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { findTables, extractLinks, stripMd, collectReferences, metadataValue, withoutFencedCode } from './public/markdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_READ_BYTES = 2 * 1024 * 1024;

/* ---------------- 内嵌 Web 资源 ----------------
 * 构建时由 build.mjs 将 public/ 压缩(gzip+base64)注入下方占位符，生成单文件产物 plan-viewer.mjs；
 * 占位符未替换（源码开发模式）时自动回退从 public/ 目录读取。 */

const EMBEDDED_WEB = {
  '/': { type: 'text/html; charset=utf-8', data: '__PLAN_VIEWER_ASSET_INDEX__' },
  '/app.js': { type: 'text/javascript; charset=utf-8', data: '__PLAN_VIEWER_ASSET_APP__' },
  '/style.css': { type: 'text/css; charset=utf-8', data: '__PLAN_VIEWER_ASSET_STYLE__' },
  '/markdown.js': { type: 'text/javascript; charset=utf-8', data: '__PLAN_VIEWER_ASSET_MARKDOWN__' },
  '/navigation.js': { type: 'text/javascript; charset=utf-8', data: '__PLAN_VIEWER_ASSET_NAVIGATION__' },
};

const EMBEDDED = !Object.values(EMBEDDED_WEB).some((a) => a.data.includes('__PLAN_VIEWER_ASSET_'));

const decodedCache = new Map();
function embeddedAsset(route) {
  if (!decodedCache.has(route)) {
    decodedCache.set(route, gunzipSync(Buffer.from(EMBEDDED_WEB[route].data, 'base64')));
  }
  return decodedCache.get(route);
}

/* ---------------- 命令行参数与目录定位 ---------------- */

const args = process.argv.slice(2);

function optValue(name) {
  const prefix = `${name}=`;
  const inline = args.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Plan Viewer — docs/plan 计划追踪页面（仅开发环境使用）

用法:
  node ${path.basename(process.argv[1] || 'server.mjs')} [选项]

选项:
  --port=<n>          服务端口（默认 4173，或环境变量 PLAN_VIEWER_PORT）
  --plan-dir=<dir>    docs/plan 数据目录
  -h, --help          显示本帮助

docs/plan 定位优先级: --plan-dir > 环境变量 PLAN_DIR > 从脚本位置向上逐级查找

环境依赖: Node.js >= 20（仅内置模块，无需 npm install），跨平台，仅访问 localhost

页面: 启动后访问 http://127.0.0.1:<port>；刷新页面即读取最新文档。`);
  process.exit(0);
}

/** 通用定位 docs/plan：参数 > 环境变量 > 向上逐级查找 */
function resolvePlanDir() {
  const explicit = optValue('--plan-dir') || process.env.PLAN_DIR || '';
  if (explicit) {
    const abs = path.resolve(explicit);
    if (!existsSync(abs)) {
      console.error(`指定的数据目录不存在：${abs}`);
      process.exit(1);
    }
    return abs;
  }
  let dir = __dirname;
  for (;;) {
    const candidate = path.join(dir, 'docs', 'plan');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  console.error('未找到 docs/plan 数据目录。请用 --plan-dir=<dir> 或环境变量 PLAN_DIR 指定。');
  process.exit(1);
}

const PLAN_DIR = resolvePlanDir();

const PORT = Number(optValue('--port') ?? process.env.PLAN_VIEWER_PORT ?? 4173);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error('端口必须是 0 至 65535 的整数');
  process.exit(1);
}

/* ---------------- 路径工具 ---------------- */

/** rel（posix 相对路径）解析后是否仍位于 PLAN_DIR 内 */
function isInsidePlan(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  const abs = path.resolve(PLAN_DIR, rel);
  return abs === PLAN_DIR || abs.startsWith(PLAN_DIR + path.sep);
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/* ---------------- Markdown 解析 ---------------- */

/** 台账状态词 → 归一化分组 */
const TASK_STATUS = { 已完成: 'done', 进行中: 'doing', 未开始: 'todo', 待开始: 'todo' };

function normalizeTaskStatus(raw) {
  return TASK_STATUS[stripMd(raw || '')] || 'other';
}

function isRelMd(href) {
  return typeof href === 'string' && /\.md($|#)/i.test(href) && !/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('#') && !href.startsWith('/');
}

/* ---------------- 各类文档解析 ---------------- */

/** 解析总入口 README：任务 / 状态 / 范围 表格 */
function parseRootIndex(md) {
  const refs = collectReferences(md);
  const entries = [];
  for (const table of findTables(md)) {
    const header = table.columns.map(stripMd);
    const taskCol = header.indexOf('任务');
    const statusCol = header.findIndex((c) => c.includes('状态'));
    const scopeCol = header.findIndex((c) => c.includes('范围'));
    if (taskCol < 0) continue;
    entries.push(...table.rows.map((cells) => {
        const cell = cells[taskCol] || '';
        const links = extractLinks(cell, refs).filter((l) => isRelMd(l.href));
        const name = links.length ? links[0].text : stripMd(cell);
        // href 形如 dir/README.md，去掉 README.md 得到任务目录
        let dir = '';
        if (links.length) {
          try {
            const file = decodeURIComponent(links[0].href.split('#')[0]);
            if (isInsidePlan(file) && /^README\.md$/i.test(path.basename(file))) {
              dir = toPosix(path.relative(PLAN_DIR, path.dirname(path.resolve(PLAN_DIR, file))));
            }
          } catch { /* Malformed encoded paths remain missing entries. */ }
        }
        return {
          name,
          dir,
          status: stripMd(cells[statusCol] || ''),
          scope: scopeCol >= 0 ? (cells[scopeCol] || '').trim() : '',
        };
      }));
  }
  return { entries };
}

/** 提取指定章节标题后的第一段非空文本（用于卡片摘要） */
function extractSectionIntro(md, title) {
  const lines = md.split(/\r?\n/);
  const re = new RegExp(`^#{1,6}\\s+.*${title}`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  const buf = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') {
      if (buf.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line) || line.startsWith('|') || /^\s*```/.test(line)) break;
    buf.push(stripMd(line));
  }
  if (!buf.length) return null;
  const text = buf.join(' ');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** 收集 README 中引用的相对 .md 文件（去重，保留首次出现顺序） */
function collectMdLinks(md, dir, refs) {
  const lines = withoutFencedCode(md).split('\n');
  const seen = new Map();
  for (const line of lines) {
    for (const link of extractLinks(line, refs)) {
      if (!isRelMd(link.href)) continue;
      let file;
      try { file = toPosix(decodeURIComponent(link.href.split('#')[0])); }
      catch { continue; }
      if (!file || seen.has(file)) continue;
      seen.set(file, { name: link.text, file, inside: isInsidePlan(path.join(dir, file)) });
    }
  }
  return [...seen.values()];
}

/** 解析单个计划 README：状态行 / 进度行 / 台账表 / checkbox / 文件引用 */
function parsePlanReadme(md, dir) {
  const refs = collectReferences(md);
  const readmeStatus = metadataValue(md, '状态')?.split(/[。;；,，]/)[0].trim() || null;
  const progressMatch = metadataValue(md, '进度')?.match(/^(\d+)\s*\/\s*(\d+)/);

  // 台账：第一个含「状态」列且至少有 1 行数据的表格
  let ledger = null;
  for (const table of findTables(md)) {
    const statusCol = table.columns.findIndex((c) => stripMd(c).includes('状态'));
    if (statusCol < 0 || table.rows.length === 0) continue;
    const rows = table.rows.map((cells) => {
      const links = extractLinks(cells.join(' '), refs).filter((l) => isRelMd(l.href));
      const statusCell = stripMd(cells[statusCol] || '');
      const nameCell = cells.find((c, i) => i !== statusCol && stripMd(c)) || '';
      return {
        name: stripMd(nameCell),
        status: statusCell,
        group: normalizeTaskStatus(statusCell),
        cells,
        files: links.map((l) => ({ text: l.text, file: toPosix(l.href).split('#')[0] })),
      };
    });
    ledger = { columns: table.columns.map(stripMd), statusCol, rows };
    break;
  }

  const prose = withoutFencedCode(md);
  const cbDone = (prose.match(/^\s*[-*] \[[xX]\]/gm) || []).length;
  const cbTotal = (prose.match(/^\s*[-*] \[[xX ]\]/gm) || []).length;

  // 进度口径优先级：声明进度行 > 台账统计 > checkbox 统计
  let progress = null;
  if (progressMatch && Number.isSafeInteger(Number(progressMatch[2])) && Number(progressMatch[1]) <= Number(progressMatch[2])) {
    progress = { done: Number(progressMatch[1]), total: Number(progressMatch[2]), source: '声明进度' };
  } else if (ledger) {
    const counts = { done: 0, doing: 0, todo: 0, other: 0 };
    for (const row of ledger.rows) counts[row.group] += 1;
    const todo = ledger.rows.length - counts.done - counts.doing - counts.other;
    progress = {
      done: counts.done,
      doing: counts.doing,
      todo: Math.max(0, todo),
      other: counts.other,
      total: ledger.rows.length,
      source: '台账统计',
    };
  } else if (cbTotal > 0) {
    progress = { done: cbDone, todo: cbTotal - cbDone, total: cbTotal, source: '清单勾选' };
  }

  return {
    readmeStatus,
    progress,
    ledger,
    goal: extractSectionIntro(md, '目标'),
    files: collectMdLinks(md, dir, refs),
    checklist: { done: cbDone, total: cbTotal },
  };
}

/* ---------------- API 数据构建 ---------------- */

async function readPlanFile(rel) {
  if (!isInsidePlan(rel)) return null;
  try {
    const content = await readFile(path.resolve(PLAN_DIR, rel), 'utf8');
    return content.length <= MAX_READ_BYTES ? content : content.slice(0, MAX_READ_BYTES);
  } catch {
    return null;
  }
}

async function buildPlanData() {
  const rootMd = await readPlanFile('README.md');
  const index = rootMd ? parseRootIndex(rootMd) : { entries: [] };
  const plans = [];
  for (const entry of index.entries) {
    if (!entry.dir) {
      plans.push({ ...entry, exists: false });
      continue;
    }
    const md = await readPlanFile(`${entry.dir}/README.md`);
    if (md == null) {
      plans.push({ ...entry, exists: false });
      continue;
    }
    plans.push({ ...entry, exists: true, ...parsePlanReadme(md, entry.dir), markdown: md });
  }
  const summary = {};
  for (const plan of plans) {
    const key = plan.exists ? plan.status || '未知' : '目录缺失';
    summary[key] = (summary[key] || 0) + 1;
  }
  return { generatedAt: new Date().toISOString(), planDir: toPosix(PLAN_DIR), summary, plans };
}

/* ---------------- HTTP 服务 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function sendError(res, code, message) {
  sendJson(res, code, { error: message });
}

async function serveStatic(res, urlPath) {
  // 产物模式：内嵌压缩资源
  if (EMBEDDED) {
    let route = urlPath === '/' ? '/' : `/${urlPath.replace(/^\/+/, '')}`;
    if (route === '/index.html') route = '/';
    const asset = EMBEDDED_WEB[route];
    if (!asset) return sendError(res, 404, 'Not Found');
    res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' });
    return res.end(embeddedAsset(route));
  }
  // 源码开发模式：从 public/ 目录读取
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.resolve(PUBLIC_DIR, rel);
  if (!(abs === PUBLIC_DIR || abs.startsWith(PUBLIC_DIR + path.sep))) {
    return sendError(res, 403, 'Forbidden');
  }
  try {
    const info = await stat(abs);
    if (!info.isFile()) return sendError(res, 404, 'Not Found');
  } catch {
    return sendError(res, 404, 'Not Found');
  }
  const content = await readFile(abs);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/api/plan') {
      return sendJson(res, 200, await buildPlanData());
    }
    if (url.pathname === '/api/file') {
      // searchParams.get 已做 URL 解码，无需再次 decodeURIComponent
      const p = toPosix(url.searchParams.get('p') || '');
      if (!isInsidePlan(p) || !/\.md$/i.test(p)) {
        return sendError(res, 400, '仅支持读取 docs/plan 内的 .md 文件');
      }
      const md = await readPlanFile(p);
      if (md == null) return sendError(res, 404, `文件不存在：${p}`);
      return sendJson(res, 200, { path: p, markdown: md });
    }
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }
    return await serveStatic(res, url.pathname);
  } catch (err) {
    return sendError(res, 500, String((err && err.message) || err));
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`启动失败：端口 ${PORT} 已被占用（可能有残留的 Plan Viewer 进程）。`);
    console.error(`  可先执行 pnpm kill:ports，或换端口启动：pnpm plan -- --port=${PORT + 1}`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Plan Viewer 已启动（仅开发环境使用）');
  console.log(`  模式:   ${EMBEDDED ? '单文件产物（内嵌压缩页面）' : '源码模式（读取 public/）'}`);
  console.log(`  地址:   http://127.0.0.1:${server.address().port}`);
  console.log(`  数据源: ${PLAN_DIR}`);
  console.log('  说明:   刷新页面即读取最新文档；Ctrl+C 停止');
});
