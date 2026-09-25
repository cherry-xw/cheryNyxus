#!/usr/bin/env node

/** Checks the CheryClaw plan directory without duplicating plan-viewer rules. */

import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const PLAN_STATUSES = new Set(['规划中', '执行中', '阻塞', '待综合验证', '待用户审批']);

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

function readStatus(markdown) {
  const match = markdown.match(/^\s*(?:>\s*)?\*\*状态：\*\*\s*(.+?)\s*$/mu);
  return match?.[1] ?? null;
}

function runPlanLint(repoRoot) {
  const script = repoPath(repoRoot, 'tools/plan-viewer/lint-source.mjs');
  if (!existsSync(script)) {
    return { code: 'P0', message: '现有 plan:lint 入口不存在', output: '' };
  }
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status === 0) return null;
  return {
    code: 'P0',
    message: '现有 plan:lint 失败，统一检查不替代其规则',
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

export async function checkPlan({
  repoRoot = DEFAULT_REPO_ROOT,
  planDir = 'docs/plan',
  runExistingLint = true,
  checkGitIgnore = true,
} = {}) {
  const issues = [];
  const planRoot = repoPath(repoRoot, planDir);
  const indexPath = path.join(planRoot, 'README.md');

  if (!existsSync(planRoot) || !statSync(planRoot).isDirectory()) {
    return { issues: [{ code: 'P1', path: planDir, message: '计划根目录不存在' }] };
  }
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    issues.push({ code: 'P1', path: `${planDir}/README.md`, message: '计划总入口不存在' });
  }

  for (const entry of await readdir(planRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name !== 'README.md') {
      issues.push({ code: 'P2', path: `${planDir}/${entry.name}`, message: '计划根目录不得散放任务文档或产物' });
    }
    if (!entry.isDirectory()) continue;

    const taskDir = path.join(planRoot, entry.name);
    const taskReadme = path.join(taskDir, 'README.md');
    const taskPath = `${planDir}/${entry.name}/README.md`;
    if (!existsSync(taskReadme) || !statSync(taskReadme).isFile()) {
      issues.push({ code: 'P3', path: taskPath, message: '总任务 README 不存在' });
      continue;
    }
    const status = readStatus(await readFile(taskReadme, 'utf8'));
    if (!status) {
      issues.push({ code: 'P4', path: taskPath, message: '总任务 README 缺少状态行' });
    } else if (!PLAN_STATUSES.has(status)) {
      issues.push({ code: 'P4', path: taskPath, message: `计划状态不在允许集合内：${status}` });
    }

    const outDir = path.join(taskDir, 'verify', 'out');
    if (existsSync(outDir) && !statSync(outDir).isDirectory()) {
      issues.push({ code: 'P5', path: `${planDir}/${entry.name}/verify/out`, message: '验证产物路径不是目录' });
    }
  }

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

  if (runExistingLint) {
    const lintIssue = runPlanLint(repoRoot);
    if (lintIssue) issues.push(lintIssue);
  }

  return { issues };
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
