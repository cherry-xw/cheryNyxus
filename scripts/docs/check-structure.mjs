#!/usr/bin/env node

/** Checks document roots, navigation READMEs, and orphan Markdown files. */

import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extractLinks, isExternalHref } from './markdown.mjs';
import { docsConfig, isExcluded, normalizeRepoPath } from './config.mjs';
import { resolveTarget, walkMarkdown } from './check-links.mjs';

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

function relative(repoRoot, file) {
  return normalizeRepoPath(path.relative(repoRoot, file));
}

function excludedFor(relativePath, list) {
  return isExcluded(relativePath, list);
}

async function directMarkdownFiles(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.mdx?$/iu.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

async function directoriesWithMarkdown(root) {
  const result = [];
  async function visit(directory) {
    const files = await directMarkdownFiles(directory);
    if (files.length > 0) result.push({ directory, files });
    if (!existsSync(directory) || !statSync(directory).isDirectory()) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue;
      await visit(path.join(directory, entry.name));
    }
  }
  await visit(root);
  return result;
}

function markdownTarget(sourceFile, href, repoRoot) {
  const target = resolveTarget(sourceFile, href, repoRoot);
  if (target.skipped || target.error || !target.file) return null;
  if (existsSync(target.file) && statSync(target.file).isDirectory()) {
    const readme = path.join(target.file, 'README.md');
    return existsSync(readme) ? readme : null;
  }
  return /\.mdx?$/iu.test(target.file) ? target.file : null;
}

async function reachableFrom(entry, repoRoot) {
  const reachable = new Set();
  const pending = [path.resolve(repoRoot, entry)];
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || reachable.has(file) || !existsSync(file) || !statSync(file).isFile()) continue;
    reachable.add(file);
    const markdown = await readFile(file, 'utf8');
    for (const link of extractLinks(markdown)) {
      if (!link.href || isExternalHref(link.href)) continue;
      const target = markdownTarget(file, link.href, repoRoot);
      if (target && !reachable.has(target)) pending.push(target);
    }
  }
  return reachable;
}

export async function checkStructure({ repoRoot = DEFAULT_REPO_ROOT, config = docsConfig } = {}) {
  const issues = [];
  const details = { entries: [], missingReadmes: [], orphans: [], unclassified: [] };

  for (const entry of config.rootEntries) {
    if (!existsSync(path.resolve(repoRoot, entry))) {
      issues.push({ code: 'S1', path: entry, message: '统一入口不存在' });
    }
  }

  for (const rootConfig of config.managedRoots) {
    const root = path.resolve(repoRoot, rootConfig.path);
    const entry = path.resolve(repoRoot, rootConfig.entry);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      issues.push({ code: 'S1', path: rootConfig.path, message: '受管文档根不存在' });
      continue;
    }
    if (!existsSync(entry) || !statSync(entry).isFile()) {
      issues.push({ code: 'S1', path: rootConfig.entry, message: '文档入口 README 不存在' });
      continue;
    }
    details.entries.push(rootConfig.entry);

    if (rootConfig.navigation === 'indexed') {
      const reachable = await reachableFrom(rootConfig.entry, repoRoot);
      const files = await walkMarkdown(root);
      for (const file of files) {
        const repoPath = relative(repoRoot, file);
        if (excludedFor(repoPath, config.orphanExclusions)) continue;
        if (!reachable.has(file)) {
          const issue = { code: 'S3', path: repoPath, message: '未能从对应文档入口到达' };
          issues.push(issue);
          details.orphans.push(repoPath);
        }
      }
    }

    const directoryEntries = await directoriesWithMarkdown(root);
    for (const { directory, files } of directoryEntries) {
      const repoPath = relative(repoRoot, directory);
      if (excludedFor(repoPath, config.readmeExclusions)) continue;
      if (files.some((file) => path.basename(file).toLowerCase() === 'readme.md')) continue;
      if (rootConfig.navigation === 'standalone' && directory === root) continue;
      const issue = { code: 'S2', path: repoPath, message: '包含 Markdown 的目录缺少 README.md' };
      issues.push(issue);
      details.missingReadmes.push(repoPath);
    }
  }

  return { issues, details };
}

function printResult(result, options) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const issue of result.issues) console.error(`✗ ${issue.code} ${issue.path}：${issue.message}`);
  if (result.issues.length === 0) {
    console.log(`Docs structure 通过：检查 ${result.details.entries.length} 个文档入口，无孤儿文档和缺失 README`);
  } else {
    console.error(`Docs structure 失败：${result.issues.length} 处问题`);
    console.error(`入口 ${result.details.entries.length} 个，缺失 README ${result.details.missingReadmes.length} 个，孤儿文档 ${result.details.orphans.length} 个`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await checkStructure(options);
  printResult(result, options);
  if (result.issues.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
