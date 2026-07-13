#!/usr/bin/env node
/**
 * scripts/pack-config.mjs
 * 打包配置单一事实源：读取 package.json 的 packConfig 字段，环境变量可覆盖。
 *
 * 导出：
 *   - resolvePackConfig()  → { nodeVersion, httpProxy, electronMirror, builderBinariesMirror }
 *   - applyProxyEnv(config) → 将 config 写入 process.env（供子进程继承）
 *   - NODE_VERSION / NODE_MAJOR / PLATFORM_ASSET（从 electron-pack.mjs 搬出）
 *
 * 覆盖规则（优先级：env > package.json）：
 *   packConfig.httpProxy              ← ELECTRON_PACK_PROXY
 *   packConfig.electronMirror        ← ELECTRON_MIRROR
 *   packConfig.builderBinariesMirror ← ELECTRON_BUILDER_BINARIES_MIRROR
 *
 * env 设为空字符串时走空值（禁用镜像/代理），与原脚本 ?? 语义一致。
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ===== 读取 package.json 的 packConfig =====
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
const packConfigDefaults = pkg.packConfig ?? {};

// ===== 环境变量 → 解析后配置 =====

/**
 * 读取 package.json packConfig 字段，用环境变量覆盖对应项。
 * @returns {{ nodeVersion: string, httpProxy: string, electronMirror: string, builderBinariesMirror: string }}
 */
export function resolvePackConfig() {
  return {
    nodeVersion: packConfigDefaults.nodeVersion ?? "22.11.0",
    httpProxy: process.env.ELECTRON_PACK_PROXY ?? packConfigDefaults.httpProxy ?? "",
    electronMirror:
      process.env.ELECTRON_MIRROR ?? packConfigDefaults.electronMirror ?? "",
    builderBinariesMirror:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??
      packConfigDefaults.builderBinariesMirror ??
      "",
  };
}

/**
 * 将 resolved config 注入 process.env，供 electron-builder / curl 等子进程继承。
 *
 * - httpProxy → HTTPS_PROXY / HTTP_PROXY / https_proxy / http_proxy
 * - electronMirror → ELECTRON_MIRROR（末尾补斜杠，@electron/get 要求）
 * - builderBinariesMirror → ELECTRON_BUILDER_BINARIES_MIRROR
 */
export function applyProxyEnv(config) {
  const { httpProxy, electronMirror, builderBinariesMirror } = config;

  // HTTP 代理（Node fetch / undici / curl 均读这些 env）
  if (httpProxy) {
    process.env.HTTPS_PROXY ??= httpProxy;
    process.env.HTTP_PROXY ??= httpProxy;
    process.env.https_proxy ??= httpProxy;
    process.env.http_proxy ??= httpProxy;
  }

  // Electron 辅助二进制镜像（winCodeSign / Squirrel.Windows / 7z-extract 等）
  if (builderBinariesMirror !== undefined) {
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= builderBinariesMirror;
  }

  // Electron 本体镜像（末尾必须带斜杠，@electron/get 直接拼接）
  if (electronMirror !== undefined) {
    const mirror = electronMirror.endsWith("/")
      ? electronMirror
      : `${electronMirror}/`;
    process.env.ELECTRON_MIRROR ??= mirror;
  }
}

// ===== Node 22 LTS 常量（原 electron-pack.mjs 顶部，升级时改此处 + electron-builder.yml 路径） =====
export const NODE_VERSION = packConfigDefaults.nodeVersion ?? "22.11.0";
export const NODE_MAJOR = Number(NODE_VERSION.split(".")[0]);

/** 当前 host 平台 → nodejs.org 资源文件片段 */
export const PLATFORM_ASSET = {
  "win32-x64": {
    archive: "zip",
    url: () => `node-v${NODE_VERSION}-win-x64.zip`,
    binary: "node.exe",
  },
  "darwin-x64": {
    archive: "tar",
    url: () => `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    binary: "bin/node",
  },
  "darwin-arm64": {
    archive: "tar",
    url: () => `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    binary: "bin/node",
  },
  "linux-x64": {
    archive: "tar",
    url: () => `node-v${NODE_VERSION}-linux-x64.tar.xz`,
    binary: "bin/node",
  },
};
