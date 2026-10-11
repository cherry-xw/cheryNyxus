#!/usr/bin/env node
/**
 * Plan Viewer 构建：将 public/ Web 源码压缩(gzip+base64)注入 server.mjs 占位符，
 * 生成可直接 node 启动的单文件产物 plan-viewer.mjs（可拷贝到任意位置独立使用）。
 *
 * 用法：node build.mjs [--if-missing]   （或 pnpm --dir tools/plan-viewer build）
 *
 * --if-missing：产物齐全时跳过（无写入），任一产物缺失时全量重建；
 *               仅显式构建使用；日常命令直接运行源码。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
  ['__PLAN_VIEWER_ASSET_FILTERS__', 'filters.js'],
];

function bundleSource(file) {
  let source = readFileSync(file, 'utf8');
  const shared = readFileSync(path.join(PUBLIC_DIR, 'markdown.js'), 'utf8').replace(/^export /gm, '');
  const mdPattern = /^import \{ ([^}]+) \} from '\.\/public\/markdown\.js';$/m;
  source = source.replace(mdPattern, (_match, names) => `const { ${names} } = (() => {\n${shared}\nreturn { ${names} };\n})();`);
  if (source.includes("import { auditPlans } from './audit.mjs';")) {
    let audit = readFileSync(path.join(__dirname, 'audit.mjs'), 'utf8');
    audit = audit.replace(/^import .*$/gm, '').replace(/^export /gm, '');
    const inline = `import * as auditFs from 'node:fs';\nimport auditPath from 'node:path';\nconst { auditPlans } = (() => {\n${shared}\n${audit}\nreturn { auditPlans };\n})();`;
    source = source.replace("import { auditPlans } from './audit.mjs';", inline);
  }
  return source;
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
outputs.push([path.join(PORTABLE_DIR, 'plan-viewer.mjs'), out], [path.join(PORTABLE_DIR, 'lint.mjs'), lint]);
const check = process.argv.includes('--check');
if (!check) mkdirSync(PORTABLE_DIR, { recursive: true });
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
