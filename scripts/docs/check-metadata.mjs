#!/usr/bin/env node

/** Checks optional Markdown front matter and source ownership declarations. */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { docsConfig } from './config.mjs';
import { walkMarkdown } from './check-links.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');

function stripQuoted(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseFrontMatter(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { fields: null, errors: [] };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return { fields: null, errors: ['front matter 缺少结束标记 ---'] };

  const fields = {};
  const errors = [];
  let listKey = null;
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const listItem = line.match(/^\s+-\s+(.+)$/u);
    if (listItem && listKey) {
      if (!Array.isArray(fields[listKey])) fields[listKey] = [];
      fields[listKey].push(stripQuoted(listItem[1]));
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/u);
    if (!match) {
      errors.push(`无法解析 front matter 行：${line}`);
      listKey = null;
      continue;
    }
    const key = match[1];
    const value = match[2] ?? '';
    if (value.trim() === '') {
      fields[key] = [];
      listKey = key;
    } else if (/^(?:true|false)$/iu.test(value.trim())) {
      fields[key] = value.trim().toLowerCase() === 'true';
      listKey = null;
    } else {
      fields[key] = stripQuoted(value);
      listKey = null;
    }
  }
  return { fields, errors };
}

function validateFields(fields, policy) {
  const errors = [];
  const allowed = new Set(policy.metadata.fields);
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) errors.push(`未允许的 front matter 字段：${key}`);
  }
  for (const key of ['title', 'summary', 'source']) {
    if (key in fields && typeof fields[key] !== 'string') errors.push(`${key} 必须是字符串`);
  }
  if ('read_when' in fields && (!Array.isArray(fields.read_when) || fields.read_when.some((item) => typeof item !== 'string'))) {
    errors.push('read_when 必须是字符串列表');
  }
  if ('generated' in fields && typeof fields.generated !== 'boolean') errors.push('generated 必须是 true 或 false');
  return errors;
}

export async function checkMetadata({ repoRoot = DEFAULT_REPO_ROOT, config = docsConfig } = {}) {
  const issues = [];
  const policy = config.sourcePolicy;
  for (const root of config.managedRoots) {
    const files = await walkMarkdown(path.resolve(repoRoot, root.path));
    for (const file of files) {
      const markdown = await readFile(file, 'utf8');
      const parsed = parseFrontMatter(markdown);
      const relative = path.relative(repoRoot, file).replace(/\\/g, '/');
      for (const error of parsed.errors) issues.push({ code: 'M1', path: relative, message: error });
      if (!parsed.fields) continue;
      if (!policy.metadata.enabled) {
        issues.push({ code: 'M2', path: relative, message: '项目未启用 front matter，不能在未登记时添加页面元信息' });
        continue;
      }
      for (const error of validateFields(parsed.fields, policy)) {
        issues.push({ code: 'M3', path: relative, message: error });
      }
      if (parsed.fields.generated === true && policy.generated.length === 0) {
        issues.push({ code: 'M4', path: relative, message: '文档声明为生成内容，但项目没有登记生成来源和输出目录' });
      }
      if (parsed.fields.source && policy.externalMirrors.length === 0 && parsed.fields.generated !== true) {
        issues.push({ code: 'M5', path: relative, message: '文档声明了外部来源，但项目没有登记外部镜像边界' });
      }
    }
  }
  return { issues };
}

function parseArgs(argv) {
  const options = { repoRoot: DEFAULT_REPO_ROOT, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--repo-root' || arg.startsWith('--repo-root=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--repo-root 需要路径参数');
      options.repoRoot = path.resolve(value);
    } else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await checkMetadata(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (result.issues.length === 0) console.log('Docs metadata 通过：未发现未登记的来源或页面元信息');
  else {
    for (const issue of result.issues) console.error(`✗ ${issue.code} ${issue.path}：${issue.message}`);
    console.error(`Docs metadata 失败：${result.issues.length} 处问题`);
  }
  if (result.issues.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
