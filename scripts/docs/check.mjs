#!/usr/bin/env node

/** Runs every repository documentation check and returns one aggregate result. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLinks } from './check-links.mjs';
import { checkStructure } from './check-structure.mjs';
import { checkPlan } from './check-plan.mjs';
import { checkMetadata } from './check-metadata.mjs';
import { docsConfig } from './config.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');

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

export async function runDocumentationChecks({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const roots = docsConfig.managedRoots
    .filter((root) => root.linkCheck !== false)
    .map((root) => root.path);
  const links = await checkLinks({ repoRoot, roots });
  const structure = await checkStructure({ repoRoot });
  const plan = await checkPlan({ repoRoot });
  const metadata = await checkMetadata({ repoRoot });
  return { links, structure, plan, metadata };
}

function issueCount(result) {
  return result.issues?.length ?? 0;
}

function printHuman(result) {
  const rows = [
    ['links', result.links.issues.length, result.links.files.length],
    ['structure', result.structure.issues.length, result.structure.details.entries.length],
    ['plan', result.plan.issues.length, null],
    ['metadata', result.metadata.issues.length, null],
  ];
  for (const [name, issues, count] of rows) {
    const suffix = count === null ? '' : `，对象 ${count}`;
    console.log(`Docs ${name}：${issues === 0 ? '通过' : `${issues} 处问题`}${suffix}`);
  }
  const total = rows.reduce((sum, [, issues]) => sum + issues, 0);
  console.log(total === 0 ? 'Docs check 通过：全部文档检查通过' : `Docs check 失败：共 ${total} 处问题`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runDocumentationChecks(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  if (Object.values(result).some((value) => issueCount(value) > 0)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
