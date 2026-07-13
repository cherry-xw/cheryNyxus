#!/usr/bin/env node
// cheryClaw Electron 桌面应用统一打包脚本
//
// 流程（Doc-First，对应 docs/web/electron-pack-progress.md §6.1-6.3、docs/web/deployment.md#native-addon-abi模式-2）：
//   1. 检测 host 平台 → 选 Node 22 LTS 资源名（win-x64 / darwin-{x64,arm64} / linux-x64）
//   2. 下载 Node 22 LTS 二进制到 build/node/ 并解压出 node[.exe]
//   3. 用该 node 执行 `npx prebuild-install --target=<NODE_VERSION> -r node`
//      → 从 better-sqlite3 官方 release 拉 Node 22 ABI 的 better_sqlite3.node
//      → 覆盖 node_modules/better-sqlite3/build/Release/
//   4. 调 pnpm 触发 build:all + web dist（electron-builder）
//
// 与 docs/web/electron.md / docs/web/deployment.md 中方案章节保持一致。
// 修改 NODE_VERSION 时同步更新 docs/web/deployment.md 提到的 ABI 版本号说明。

import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import https from "node:https";

// ===== 单一事实源：升级 Node 时改这两处 + electron-builder.yml 中 Node 路径 =====
// 当前为 Node 22 进入 LTS 的首个版本（2024-10-29，v22.11.0 LTS 'Jod'，ABI=127）
const NODE_VERSION = "22.11.0";
const NODE_MAJOR = 22;

/** 当前 host 平台 → nodejs.org 资源文件片段 */
const PLATFORM_ASSET = {
  "win32-x64":   { archive: "zip",  url: () => `node-v${NODE_VERSION}-win-x64.zip`,                   binary: "node.exe" },
  "darwin-x64":  { archive: "tar",  url: () => `node-v${NODE_VERSION}-darwin-x64.tar.gz`,             binary: "bin/node" },
  "darwin-arm64":{ archive: "tar",  url: () => `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,           binary: "bin/node" },
  "linux-x64":   { archive: "tar",  url: () => `node-v${NODE_VERSION}-linux-x64.tar.xz`,             binary: "bin/node" },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const buildNodeDir = join(repoRoot, "build", "node");
const nodeBinaryPath = join(buildNodeDir, process.platform === "win32" ? "node.exe" : "node");

// 本地 HTTP 代理（绕过 GitHub release-assets 反爬；可经 ELECTRON_PACK_PROXY env 覆盖）
const HTTP_PROXY = process.env.ELECTRON_PACK_PROXY ?? "http://127.0.0.1:1234";
// Node 22 fetch / undici 读 HTTPS_PROXY 走代理；curl 也读；PowerShell 不读，需显式 -Proxy
process.env.HTTPS_PROXY ??= HTTP_PROXY;
process.env.HTTP_PROXY ??= HTTP_PROXY;
process.env.https_proxy ??= HTTP_PROXY;
process.env.http_proxy ??= HTTP_PROXY;

// electron-builder 阶段两类下载都依赖 GitHub，国内 DNS 落到 20.205.243.166 频繁 ETIMEDOUT，
// 默认全部走 npmmirror。env 同名可覆盖；置空字符串则显式禁用（回退到 GitHub 官方源）。
// 这两个 env 同步被 web/scripts/dist-electron.mjs 写入，保证
// `pnpm --filter web dist` 与本脚本行为一致。

// 1) electron-builder 辅助二进制（winCodeSign / Squirrel.Windows / 7z-extract 等）
const BUILDER_BINARIES_MIRROR = process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? "https://npmmirror.com/mirrors/electron-builder-binaries/";
if (BUILDER_BINARIES_MIRROR) {
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR = BUILDER_BINARIES_MIRROR;
}

// 2) Electron 本体（如 electron-v43.0.0-win32-x64.zip），被 @electron/get 读 ELECTRON_MIRROR。
// 路径末尾必须带斜杠——@electron/get 直接字符串拼接，缺斜杠会 404。
const ELECTRON_MIRROR = process.env.ELECTRON_MIRROR ?? "https://npmmirror.com/mirrors/electron/";
if (ELECTRON_MIRROR) {
  process.env.ELECTRON_MIRROR = ELECTRON_MIRROR;
}

// ESM 下用 createRequire 调 CommonJS resolve（prebuild-install / better-sqlite3 等）
const require = createRequire(import.meta.url);

/** 当前 host 平台键；非目标平台直接退出（与 electron-builder.yml targets 一致） */
function getPlatformKey() {
  const arch = process.arch === "x64" ? "x64"
             : process.arch === "arm64" ? "arm64"
             : null;
  if (!arch) {
    throw new Error(`不支持的 CPU 架构: ${process.arch}`);
  }
  const os = process.platform === "win32" ? "win32"
           : process.platform === "darwin" ? "darwin"
           : process.platform === "linux" ? "linux"
           : null;
  if (!os) {
    throw new Error(`不支持的操作系统: ${process.platform}`);
  }
  // linux 仅打 x64 AppImage；如未来要 arm64 在这里补
  if (os === "linux" && arch !== "arm64") {
    // 接受 x64 与 arm64 都作为 linux 打包目标
  }
  return `${os}-${arch}`;
}

/** 平台键 → nodejs.org 资源文件名片段（注意：win32 → win，linux 保留 linux；arm64 在 linux 下 → linux-arm64） */
function nodejsArchFragment(key) {
  // key 形如 "win32-x64" / "darwin-arm64" / "linux-x64"
  const [os, arch] = key.split("-");
  const nodeOs = os === "win32" ? "win" : os; // win32 → win
  // linux 下 x64 与 arm64 都用 linux-x64 / linux-arm64 命名
  if (os === "linux") return `${nodeOs}-${arch}`;
  return `${nodeOs}-${arch}`;
}

/** 主流程日志 */
function log(step, msg) {
  console.log(`[electron-pack] [${step}] ${msg}`);
}

/** 同步运行命令；失败抛错 */
function runSync(cmd, args, opts = {}) {
  log("exec", `${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: repoRoot,
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(`命令失败 (exit ${result.status}): ${cmd} ${args.join(" ")}`);
  }
}

/** 异步运行命令；失败抛错 */
function runAsync(cmd, args, opts = {}) {
  log("exec", `${cmd} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      cwd: repoRoot,
      ...opts,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`命令失败 (exit ${code}): ${cmd} ${args.join(" ")}`));
    });
    child.on("error", reject);
  });
}

// ===== Step 1+2: 下载并解压 Node 22 二进制 =====
async function downloadAndExtractNode() {
  const key = getPlatformKey();
  const asset = PLATFORM_ASSET[key];

  mkdirSync(buildNodeDir, { recursive: true });

  if (existsSync(nodeBinaryPath)) {
    const stat = statSync(nodeBinaryPath);
    if (stat.size > 1024 * 1024) { // > 1MB 视为有效
      log("node", `已存在 ${nodeBinaryPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)，跳过下载`);
      return;
    }
    log("node", `${nodeBinaryPath} 存在但体积异常小，删除重下`);
    rmSync(nodeBinaryPath, { force: true });
  }

  const url = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${nodejsArchFragment(key)}.${asset.archive}`;
  log("node", `下载 ${url}`);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`下载失败: HTTP ${res.status} ${res.statusText}`);
  }

  // 写入临时压缩包（命名遵循 nodejs.org 实际目录名，即 node-v22.11.0-win-x64）
  const archivePath = join(buildNodeDir, `node-v${NODE_VERSION}-${nodejsArchFragment(key)}.${asset.archive}`);
  const fileStream = createWriteStream(archivePath);
  await pipeline(Readable.fromWeb(res.body), fileStream);
  log("node", `已下载到 ${archivePath} (${(statSync(archivePath).size / 1024 / 1024).toFixed(1)} MB)`);

  // 解压
  if (asset.archive === "zip") {
    await extractZip(archivePath, buildNodeDir);
  } else {
    // tar.gz / tar.xz：Linux/macOS 自带 tar 命令（bsdtar/gnu tar），免引入 npm 依赖
    const flag = url.endsWith(".tar.xz") ? "-xJf" : "-xzf";
    await runAsync("tar", [flag, archivePath, "-C", outDirCompat()]);
  }

  // 解压产物目录形如 build/node/node-v22.11.0-win-x64/node.exe
  // 我们把它重整为 build/node/node[.exe]（electron-builder.yml 期望的路径）
  const innerDirName = `node-v${NODE_VERSION}-${nodejsArchFragment(key)}`;
  const innerBinaryPath = join(buildNodeDir, innerDirName, asset.binary);
  if (!existsSync(innerBinaryPath)) {
    throw new Error(`解压后未找到预期二进制: ${innerBinaryPath}`);
  }
  rmSync(nodeBinaryPath, { force: true });
  renameSync(innerBinaryPath, nodeBinaryPath);
  // 清理解压残留目录
  rmSync(join(buildNodeDir, innerDirName), { recursive: true, force: true });
  rmSync(archivePath, { force: true });

  log("node", `Node ${NODE_VERSION} 二进制就绪: ${nodeBinaryPath}`);
}

/** tar -C 期望目录存在；统一在此 ensure */
function outDirCompat() {
  mkdirSync(buildNodeDir, { recursive: true });
  return buildNodeDir;
}

/** 解压 .zip —— Node 内置无 zip API，调系统命令（统一走 HTTP_PROXY 避免超时） */
async function extractZip(archivePath, outDir) {
  if (process.platform === "win32") {
    // PowerShell Expand-Archive（Windows 内置）；-Proxy 参数需传完整 URL
    await runAsync("powershell", [
      "-NoProfile",
      "-Command",
      `$proxy = [System.Net.WebProxy]::new('${HTTP_PROXY.replace(/\/$/, "")}'); ` +
      `Expand-Archive -LiteralPath "${archivePath}" -DestinationPath "${outDir}" -Force`,
    ]);
  } else {
    // unzip / ditto（macOS）
    const cmd = process.platform === "darwin" ? "ditto" : "unzip";
    const args = process.platform === "darwin"
      ? ["-x", "-k", archivePath, outDir]
      : ["-o", archivePath, "-d", outDir];
    await runAsync(cmd, args);
  }
}

// ===== 简易 .tar.gz 流式解析器（避免 Windows bsdtar / GNU tar 路径冲突；约 40 行） =====
/**
 * 解析 tar 文件头：
 * - 0-100: 文件名（ASCII，NUL 结尾）
 * - 124-135: 八进制文件大小
 * - 返回 { name, size } 或 null（结束块）
 */
function parseTarHeader(buf) {
  // 检查是否为空块（512 字节全 0 = tar 结束标记）
  let allZero = true;
  for (let i = 0; i < 512; i++) {
    if (buf[i] !== 0) { allZero = false; break; }
  }
  if (allZero) return null;

  const name = buf.toString("ascii", 0, 100).replace(/\0+$/, "");
  const sizeOct = buf.toString("ascii", 124, 135).replace(/\0+$/, "").trim();
  const size = parseInt(sizeOct, 8) || 0;
  // 验证 checksum（148-156 是 checksum itself，计算的时不包含）
  // 简化：跳过完整校验，仅解析 name + size
  return { name, size };
}

/**
 * 从磁盘 .tar.gz 文件解压到 outDir。
 * @param {string} tarGzPath  .tar.gz 文件路径
 * @param {string} outDir     输出目录（必须存在）
 * @param {number} stripComponents  跳过路径前缀层数
 */
async function extractTarGzFile(tarGzPath, outDir, stripComponents = 0) {
  const fileHandle = await open(tarGzPath, "r");
  try {
    const fileStream = fileHandle.createReadStream();
    const gunzip = fileStream.pipe(createGunzip());

    /** 从异步 iterator 累积取 n 字节 */
    const iter = gunzip[Symbol.asyncIterator]();
    let buf = Buffer.alloc(0);
    const takeN = async (n) => {
      while (buf.length < n) {
        const { value, done } = await iter.next();
        if (done) throw new Error(`tar 流提前结束（需要 ${n} 字节，仅有 ${buf.length}）`);
        buf = Buffer.concat([buf, value]);
      }
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    };

    const MAX_ENTRIES = 1000;
    for (let i = 0; i < MAX_ENTRIES; i++) {
      const header = await takeN(512);
      const parsed = parseTarHeader(header);
      if (parsed === null) break;

      const padded = Math.ceil(parsed.size / 512) * 512;
      const data = await takeN(padded);

      const parts = parsed.name.split("/").filter(Boolean);
      if (parts.length <= stripComponents) continue;
      const relPath = parts.slice(stripComponents).join("/");
      const targetPath = join(outDir, relPath);

      if (parsed.name.endsWith("/")) {
        mkdirSync(targetPath, { recursive: true });
      } else {
        mkdirSync(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, data.subarray(0, parsed.size));
      }
    }
  } finally {
    await fileHandle.close();
  }
}
// ===== Step 3: 用下载的 Node 22 拉 better-sqlite3 预编译 =====
async function rebuildBetterSqlite3() {
  log("sqlite", `用 ${nodeBinaryPath} 拉 Node ${NODE_VERSION} ABI 的 better-sqlite3 预编译`);

  // 1. 读取 better-sqlite3 版本 + ABI
  const betterSqlitePkgPath = require.resolve("better-sqlite3/package.json");
  const betterSqlitePkg = JSON.parse(await readFile(betterSqlitePkgPath, "utf-8"));
  const version = betterSqlitePkg.version;
  log("sqlite", `better-sqlite3 版本: ${version}`);

  // 用下载的 Node 取 ABI（process.versions.modules）
  const abi = runSyncCapture(nodeBinaryPath, ["-p", "process.versions.modules"]).trim();
  log("sqlite", `目标 ABI: ${abi}`);

  // 2. GitHub release URL 直下（不依赖 prebuild-install 的 GitHub API 查找）
  //    文件命名: better-sqlite3-v<version>-node-v<abi>-<platform>-<arch>.tar.gz
  //    better-sqlite3 仅发 node-v127 (Node 22 LTS) / node-v137 (Node 24) 等少数 ABI；
  //    ABI 不匹配则 fallback 到 node-gyp 重编。
  const platform = process.platform; // win32 / darwin / linux
  const arch = process.arch === "x64" ? "x64" : "arm64";
  const filename = `better-sqlite3-v${version}-node-v${abi}-${platform}-${arch}.tar.gz`;
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${filename}`;
  log("sqlite", `下载 ${url}`);

  const targetDir = join(repoRoot, "node_modules", "better-sqlite3", "build", "Release");
  mkdirSync(targetDir, { recursive: true });

  let downloaded = false;
  try {
    // 用 curl 下载：Node https.request 在某些 Windows 环境下对 GitHub release-assets 偶发 ECONNRESET；
    // curl（Git Bash 自带）行为更稳。下载到 buildNodeDir 后流式解压。
    // 加 -x 走本地代理（绕过 GitHub release-assets 反爬）
    const tmpTar = join(buildNodeDir, `better-sqlite3-${version}-node-v${abi}.tar.gz`);
    log("sqlite", `下载到 ${tmpTar}`);
    const curlCmd = process.platform === "win32" ? "curl.exe" : "curl";
    const curlResult = spawnSync(curlCmd, [
      "-L", "-sS", "-A", "cheryClaw-electron-pack/1.0",
      "-x", HTTP_PROXY,
      "-o", tmpTar,
      url,
    ], { stdio: "inherit" });
    if (curlResult.status !== 0) throw new Error(`curl exit ${curlResult.status}`);
    log("sqlite", `已下载 (${(statSync(tmpTar).size / 1024 / 1024).toFixed(2)} MB)`);

    // 解压（自实现 tar parser，避免 Windows tar 路径冲突）
    await extractTarGzFile(tmpTar, targetDir, 2);
    log("sqlite", `已解压到 ${targetDir}`);
    downloaded = true;
    rmSync(tmpTar, { force: true });
  } catch (err) {
    log("sqlite", `下载/解压失败: ${err.message}`);
  }

  if (!downloaded) {
    log("sqlite", "fallback 到 node-gyp 源码编译（需要本机 Python + VS Build Tools / Xcode）");
    const nodeGypBin = require.resolve("node-gyp/bin/node-gyp.js");
    await runAsync(nodeBinaryPath, [
      nodeGypBin,
      "rebuild",
      "--release",
      `--target=${NODE_VERSION}`,
      `--target_arch=${arch}`,
      `--directory=${join(repoRoot, "node_modules", "better-sqlite3")}`,
    ], {
      env: { ...process.env, npm_config_target: NODE_VERSION, npm_config_runtime: "node", npm_config_arch: arch },
    });
    log("sqlite", "node-gyp 编译完成");
  }

  log("sqlite", "better-sqlite3 预编译已就绪（位于 node_modules/better-sqlite3/build/Release/）");
}

/** 同步捕获子进程 stdout（不带继承，适合小输出） */
function runSyncCapture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf-8", ...opts });
  if (result.status !== 0) {
    throw new Error(`命令失败 (exit ${result.status}): ${cmd} ${args.join(" ")}\n${result.stderr}`);
  }
  return result.stdout;
}

/**
 * 用 node:https 下载 URL 到 web stream。
 * - 自动 follow redirect（GitHub release-assets 走 302）
 * - 错误信息含 HTTP status + 重定向历史，便于排查
 */
async function downloadHttpsStream(urlStr, headers = {}) {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const opts = {
      method: "GET",
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { ...headers },
    };
    const req = https.request(opts, (res) => {
      // follow redirect (3xx)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // 丢弃当前响应体
        log("sqlite", `→ ${res.statusCode} ${res.headers.location}`);
        resolve(downloadHttpsStream(res.headers.location, headers));
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage ?? ""}`));
        return;
      }
      // 返回 web stream（Readable.fromWeb 友好）
      resolve(Readable.toWeb(res));
    });
    req.on("error", reject);
    req.end();
  });
}

// ===== Step 4: 触发前后端 build + electron-builder 打包 =====
async function runElectronBuilder() {
  log("pack", "执行 pnpm build:all（type-check + 后端 SSR + 前端）");
  await runAsync("pnpm", ["build:all"]);

  log("pack", "执行 pnpm --filter web dist（electron-builder 打包安装包）");
  await runAsync("pnpm", ["--filter", "web", "dist"]);
}

// ===== 入口 =====
async function main() {
  const arg = process.argv[2];
  log("start", `Node ${process.version} on ${process.platform}-${process.arch}`);
  log("start", `目标 Node 版本: ${NODE_VERSION} (ABI: ${NODE_MAJOR})`);

  switch (arg) {
    case "node":
      await downloadAndExtractNode();
      break;
    case "sqlite":
      await downloadAndExtractNode(); // sqlite 子任务依赖 node 二进制存在
      await rebuildBetterSqlite3();
      break;
    case "pack":
      await runElectronBuilder();
      break;
    case undefined:
    case "all":
      await downloadAndExtractNode();
      await rebuildBetterSqlite3();
      await runElectronBuilder();
      break;
    default:
      console.error(`未知子命令: ${arg}\n用法: electron-pack.mjs [all|node|sqlite|pack]`);
      process.exit(1);
  }

  log("done", "✓ electron-pack 完成");
}

main().catch((err) => {
  console.error("[electron-pack] ✗ 失败:", err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});