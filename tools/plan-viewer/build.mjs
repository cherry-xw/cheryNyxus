#!/usr/bin/env node
/**
 * Plan Viewer 构建：将 public/ Web 源码压缩(gzip+base64)注入 server.mjs 占位符，
 * 生成可直接 node 启动的单文件产物 plan-viewer.mjs（可拷贝到任意位置独立使用）。
 *
 * 用法：node build.mjs [--if-missing]   （或 pnpm --dir tools/plan-viewer build）
 *
 * --if-missing：产物齐全时跳过（无写入），任一产物缺失时全量重建；
 *               根目录 `pnpm plan` / `pnpm plan:lint` 借此在产物缺失时自愈。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SRC_FILE = path.join(__dirname, 'server.mjs');
const OUT_FILE = path.join(__dirname, 'plan-viewer.mjs');
const PORTABLE_DIR = path.resolve(__dirname, '../../docs/standards/documentation/tools');

const ASSETS = [
  ['__PLAN_VIEWER_ASSET_INDEX__', 'index.html'],
  ['__PLAN_VIEWER_ASSET_APP__', 'app.js'],
  ['__PLAN_VIEWER_ASSET_STYLE__', 'style.css'],
  ['__PLAN_VIEWER_ASSET_MARKDOWN__', 'markdown.js'],
  ['__PLAN_VIEWER_ASSET_NAVIGATION__', 'navigation.js'],
];

function bundleSource(file) {
  const source = readFileSync(file, 'utf8');
  const shared = readFileSync(path.join(PUBLIC_DIR, 'markdown.js'), 'utf8').replace(/^export /gm, '');
  const pattern = /^import \{ ([^}]+) \} from '\.\/public\/markdown\.js';$/m;
  if (!pattern.test(source)) throw new Error(`缺少共享解析器导入：${file}`);
  return source.replace(pattern, (_match, names) => `const { ${names} } = (() => {\n${shared}\nreturn { ${names} };\n})();`);
}

let out = bundleSource(SRC_FILE);
for (const [placeholder, file] of ASSETS) {
  const gz = gzipSync(readFileSync(path.join(PUBLIC_DIR, file)), { level: 9 }).toString('base64');
  out = out.replace(placeholder, gz);
}

// 仅检查三个完整占位符（server.mjs 中 EMBEDDED 检测代码本身包含短前缀字样，不能作为残留依据）
const leftovers = ASSETS.map(([placeholder]) => placeholder).filter((p) => out.includes(p));
if (leftovers.length) {
  console.error(`构建失败：产物中残留未替换占位符: ${leftovers.join(', ')}`);
  process.exit(1);
}

const lint = bundleSource(path.join(__dirname, 'lint-source.mjs'));
const outputs = [[OUT_FILE, out], [path.join(__dirname, 'lint.mjs'), lint]];
if (existsSync(PORTABLE_DIR)) {
  outputs.push([path.join(PORTABLE_DIR, 'plan-viewer.mjs'), out], [path.join(PORTABLE_DIR, 'lint.mjs'), lint]);
}
const check = process.argv.includes('--check');
const ifMissing = process.argv.includes('--if-missing');
if (check && ifMissing) throw new Error('--if-missing 不能与 --check 同用');
if (ifMissing && outputs.every(([file]) => existsSync(file))) {
  console.log(`产物已存在，跳过构建: ${outputs.length} 个文件`);
  process.exit(0);
}
for (const [file, content] of outputs) {
  if (check) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== content) throw new Error(`产物未同步：${file}`);
  } else writeFileSync(file, content);
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`${check ? '产物一致性检查通过' : '构建完成'}: ${outputs.length} 个文件`);
console.log(`  server.mjs ${kb(readFileSync(SRC_FILE).length)} + Web 压缩注入 → plan-viewer.mjs ${kb(out.length)}`);
console.log('运行: node plan-viewer.mjs [--port=4173] [--plan-dir=<docs/plan 目录>]');
