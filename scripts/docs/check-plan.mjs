#!/usr/bin/env node

/** Checks the cheryNyxus plan directory without duplicating plan-viewer rules. */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { auditPlans } from '../../tools/plan-viewer/audit.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');

function parseArgs(argv) {
  const options = { repoRoot: DEFAULT_REPO_ROOT, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--repo-root' || arg.startsWith('--repo-root=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--repo-root 需要路径参数');
      options.repoRoot = path.resolve(value);
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function repoPath(repoRoot, value) {
  return path.resolve(repoRoot, value);
}

export async function checkPlan({
  repoRoot = DEFAULT_REPO_ROOT,
  planDir = 'docs/plan',
  checkGitIgnore = true,
} = {}) {
  const report = auditPlans({ planDir: repoPath(repoRoot, planDir), repoRoot });
  const issues = report.issues.filter((i) => i.severity === 'error').map((i) => ({ ...i, path: `${planDir}/${i.path}` }));
  if (checkGitIgnore) {
    const gitignore = repoPath(repoRoot, '.gitignore');
    if (!existsSync(gitignore)) {
      issues.push({ code: 'P6', path: '.gitignore', message: '缺少计划产物忽略配置' });
    } else {
      const content = await readFile(gitignore, 'utf8');
      if (!/docs\/plan\/\*\/verify\/out\//u.test(content)) {
        issues.push({ code: 'P6', path: '.gitignore', message: '未声明 docs/plan/*/verify/out/ 忽略边界' });
      }
    }

    const tracked = spawnSync('git', ['-C', repoRoot, 'ls-files', '--', planDir], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (tracked.status === 0) {
      for (const line of tracked.stdout.split(/\r?\n/)) {
        const normalized = line.replace(/\\/g, '/');
        if (normalized.includes('/verify/out/')) {
          issues.push({ code: 'P7', path: normalized, message: 'verify/out 运行产物被 Git 跟踪' });
        }
      }
    }
  }

  return { issues, warnings: report.issues.filter((i) => i.severity === 'warning'), summary: report.summary };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await checkPlan(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const issue of result.issues) {
      console.error(`✗ ${issue.code} ${issue.path || ''}：${issue.message}`);
      if (issue.output) console.error(issue.output);
    }
    for (const issue of result.warnings || []) console.warn(`待核对 ${issue.code} ${issue.path}:${issue.line}：${issue.message}`);
    if (result.issues.length === 0) console.log('Docs plan 通过：计划入口、状态、目录边界和验证产物规则均通过');
    else console.error(`Docs plan 失败：${result.issues.length} 处问题`);
  }
  if (result.issues.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
