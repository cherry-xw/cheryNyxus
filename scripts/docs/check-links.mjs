#!/usr/bin/env node

/**
 * Checks local Markdown links and anchors.
 *
 * Usage:
 *   node scripts/docs/check-links.mjs
 *   node scripts/docs/check-links.mjs --root docs --root .chery/docs
 *   node scripts/docs/check-links.mjs --json
 */

import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  collectAnchors,
  extractLinks,
  isExternalHref,
  splitHref,
} from './markdown.mjs';
import { docsConfig } from './config.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');

function configuredLinkRoots() {
  return docsConfig.managedRoots.filter((root) => root.linkCheck !== false).map((root) => root.path);
}

function parseArgs(argv) {
  const options = {
    repoRoot: DEFAULT_REPO_ROOT,
    roots: configuredLinkRoots(),
    json: false,
  };
  let hasExplicitRoot = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--repo-root' || arg === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要路径参数`);
      if (arg === '--repo-root') options.repoRoot = path.resolve(value);
      else {
        if (!hasExplicitRoot) options.roots = [];
        hasExplicitRoot = true;
        options.roots.push(value);
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--repo-root=') || arg.startsWith('--root=')) {
      const [name, ...parts] = arg.split('=');
      const value = parts.join('=');
      if (!value) throw new Error(`${name} 需要路径参数`);
      if (name === '--repo-root') options.repoRoot = path.resolve(value);
      else {
        if (!hasExplicitRoot) options.roots = [];
        hasExplicitRoot = true;
        options.roots.push(value);
      }
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return options;
}

export async function walkMarkdown(entry) {
  const result = [];
  const absolute = path.resolve(entry);
  if (!existsSync(absolute)) return result;
  const info = statSync(absolute);
  if (info.isFile()) {
    if (/\.mdx?$/iu.test(absolute)) result.push(absolute);
    return result;
  }

  for (const item of await readdir(absolute, { withFileTypes: true })) {
    if (item.name === 'node_modules' || item.name === '.git' || item.name === 'out') continue;
    const child = path.join(absolute, item.name);
    if (item.isDirectory()) result.push(...(await walkMarkdown(child)));
    else if (item.isFile() && /\.mdx?$/iu.test(item.name)) result.push(child);
  }
  return result;
}

function displayPath(file, repoRoot) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

function decodeHref(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function resolveTarget(sourceFile, href, repoRoot) {
  const decoded = decodeHref(href);
  if (decoded === null) return { error: `链接编码无效：${href}` };
  const { path: pathPart, fragment } = splitHref(decoded);
  if (!pathPart) return { file: sourceFile, fragment };
  if (pathPart.startsWith('/')) {
    return { skipped: true };
  }

  const candidate = path.resolve(path.dirname(sourceFile), pathPart);
  const candidates = [candidate];
  if (!path.extname(candidate)) {
    candidates.push(`${candidate}.md`, `${candidate}.mdx`, path.join(candidate, 'README.md'));
  }
  const file = candidates.find((item) => existsSync(item));
  if (file) return { file, fragment };

  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    return { file: candidate, fragment };
  }

  return {
    error: `本地目标不存在：${href}`,
    repoRoot,
  };
}

async function checkFile(file, repoRoot) {
  const markdown = await readFile(file, 'utf8');
  const issues = [];
  for (const link of extractLinks(markdown)) {
    if (!link.href || isExternalHref(link.href)) continue;
    const target = resolveTarget(file, link.href, repoRoot);
    if (target.skipped) continue;
    if (target.error) {
      issues.push({
        file: displayPath(file, repoRoot),
        message: target.error,
        link: link.href,
      });
      continue;
    }
    if (!target.fragment) continue;

    let anchorFile = target.file;
    if (existsSync(anchorFile) && statSync(anchorFile).isDirectory()) {
      anchorFile = path.join(anchorFile, 'README.md');
    }
    if (!existsSync(anchorFile) || !/\.mdx?$/iu.test(anchorFile)) continue;
    const anchorMarkdown = anchorFile === file ? markdown : await readFile(anchorFile, 'utf8');
    const anchors = collectAnchors(anchorMarkdown);
    const fragmentKey = target.fragment.toLowerCase();
    const normalizedAnchors = new Set([...anchors].map((anchor) => anchor.toLowerCase()));
    if (!normalizedAnchors.has(fragmentKey)) {
      issues.push({
        file: displayPath(file, repoRoot),
        message: `锚点不存在：${target.fragment}`,
        link: link.href,
        target: displayPath(anchorFile, repoRoot),
      });
    }
  }
  return issues;
}

export async function checkLinks({
  repoRoot = DEFAULT_REPO_ROOT,
  roots = configuredLinkRoots(),
} = {}) {
  const files = [];
  for (const root of roots) files.push(...(await walkMarkdown(path.resolve(repoRoot, root))));
  files.sort();
  const issues = [];
  for (const file of files) issues.push(...(await checkFile(file, repoRoot)));
  return { files, issues };
}

function printResult(result, options) {
  if (options.json) {
    console.log(JSON.stringify({
      files: result.files.map((file) => displayPath(file, options.repoRoot)),
      issues: result.issues,
    }, null, 2));
    return;
  }
  for (const issue of result.issues) {
    const suffix = issue.target ? ` → ${issue.target}` : '';
    console.error(`✗ ${issue.file}: ${issue.message}${suffix}（${issue.link}）`);
  }
  if (result.issues.length === 0) {
    console.log(`Docs links 通过：检查 ${result.files.length} 个 Markdown 文件，本地链接和锚点无错误`);
  } else {
    console.error(`Docs links 失败：${result.issues.length} 处错误，检查 ${result.files.length} 个 Markdown 文件`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await checkLinks(options);
  printResult(result, options);
  if (result.issues.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
