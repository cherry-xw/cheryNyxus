#!/usr/bin/env node
/**
 * Plan Lint — docs/plan 文档最低规则校验（独立开发工具，仅 Node 内置模块）。
 *
 * 规则刻意保持最少（降低误报，对所有 AI / 工具友好）：
 *   R1  总入口 README 表格中每个任务链接指向的文件必须存在
 *   R2  各计划目录的 README 必须有「状态：」行
 *
 * 用法：node lint.mjs [--plan-dir=<docs/plan 目录>]
 * docs/plan 定位优先级：--plan-dir > 环境变量 PLAN_DIR > 从脚本位置向上逐级查找。
 * 有违规时退出码 1，可挂 pre-commit / CI / agent hook。
 */

import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { findTables, extractLinks, stripMd, collectReferences, metadataValue } from './public/markdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function optValue(name) {
  const args = process.argv.slice(2);
  const prefix = `${name}=`;
  const inline = args.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
}

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
const problems = [];

/* ---- 极简 markdown 表格识别（仅用于提取总入口表格的任务列链接） ---- */

/** 找含「任务」列表格的行（每行返回任务列 cells） */
function taskRows(md) {
  const rows = [];
  let found = false;
  for (const table of findTables(md)) {
    const taskCol = table.columns.findIndex((c) => stripMd(c) === '任务');
    if (taskCol < 0) continue;
    found = true;
    rows.push(...table.rows.map((cells) => cells[taskCol] || ''));
  }
  return found ? rows : null;
}

/* ---- R1: 总入口表格链接存在性 ---- */

const indexPath = path.join(PLAN_DIR, 'README.md');
if (!existsSync(indexPath)) {
  console.error(`✗ 总入口不存在：${indexPath}`);
  process.exit(1);
}
const indexMd = await readFile(indexPath, 'utf8');
const taskCells = taskRows(indexMd);
if (taskCells === null) {
  console.error('✗ 总入口 README 未找到含「任务」列的表格');
  process.exit(1);
}

const planDirs = [];
const refs = collectReferences(indexMd);
for (const cell of taskCells) {
  const links = extractLinks(cell, refs);
  if (!links.length) problems.push(`R1 任务条目缺少可解析的 README 链接：${cell || '（空条目）'}`);
  for (const link of links) {
    if (!link.href) {
      problems.push(`R1 任务引用未定义：${link.text}`);
      continue;
    }
    let target;
    try { target = decodeURIComponent(link.href.split('#')[0]); }
    catch { problems.push(`R1 无效的链接编码：${link.href}`); continue; }
    const abs = path.resolve(PLAN_DIR, target);
    const inside = abs === PLAN_DIR || abs.startsWith(PLAN_DIR + path.sep);
    if (inside && existsSync(abs) && statSync(abs).isFile() && path.basename(abs) === 'README.md' && path.dirname(abs) !== PLAN_DIR) {
      planDirs.push(path.dirname(path.relative(PLAN_DIR, abs)));
    } else {
      problems.push(`R1 链接必须指向计划根内实际存在的任务 README 文件：${link.href}（${link.text}）`);
    }
  }
}

/* ---- R2: 计划 README 状态行 ---- */

for (const dir of [...new Set(planDirs)]) {
  const readmePath = path.join(PLAN_DIR, dir, 'README.md');
  if (!existsSync(readmePath)) {
    problems.push(`R2 计划 README 不存在：${dir}/README.md`);
    continue;
  }
  const md = await readFile(readmePath, 'utf8');
  if (!metadataValue(md, '状态')) {
    problems.push(`R2 计划 README 缺少「状态：」行：${dir}/README.md`);
  }
}

/* ---- 输出 ---- */

if (problems.length) {
  console.error(`Plan Lint：${problems.length} 处违规`);
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log(`Plan Lint 通过：总入口 ${taskCells.length} 项、计划目录 ${new Set(planDirs).size} 个（规则 R1 链接存在、R2 状态行）`);
