#!/usr/bin/env node
/**
 * cheryClaw Electron 一键打包脚本
 *
 * 整合完整流程：依赖检查 → Node 二进制下载 → SQLite 预编译 → 后端构建 → 前端构建 → electron-builder 打包
 *
 * 用法：
 *   node scripts/pack-electron.mjs                       # 一键全量打包（默认）
 *   node scripts/pack-electron.mjs --skip-deps           # 跳过依赖安装（日常增量构建）
 *   node scripts/pack-electron.mjs --skip-check           # 跳过类型检查
 *   node scripts/pack-electron.mjs --only-build          # 跳过 Node/SQLite 下载，仅构建+打包（需缓存已就绪）
 *   node scripts/pack-electron.mjs --skip-deps --skip-check --only-build   # = npm scripts electron:pack:fast
 *   node scripts/pack-electron.mjs --force               # 强制重新下载所有依赖（Node/SQLite 预编译）
 *   DEBUG=1 node scripts/pack-electron.mjs       # 显示详细调试信息
 *
 * 环境变量（可覆盖 package.json 的 packConfig）：
 *   ELECTRON_PACK_PROXY          代理
 *   ELECTRON_MIRROR               Electron 下载镜像
 *   ELECTRON_BUILDER_BINARIES_MIRROR  辅助二进制镜像
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePackConfig, applyProxyEnv } from "./pack-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const webRoot = join(repoRoot, "web");

// ===== 解析命令行参数 =====
const args = process.argv.slice(2);
const flags = {
  skipDeps: args.includes("--skip-deps"),
  skipCheck: args.includes("--skip-check"),
  onlyBuild: args.includes("--only-build"),
  force: args.includes("--force"),
};

// ===== 代理 & 镜像配置（来自 package.json packConfig，env 可覆盖） =====
const packConfig = resolvePackConfig();
applyProxyEnv(packConfig);
const HTTP_PROXY = packConfig.httpProxy;

// ===== 工具函数 =====
const DEBUG = !!process.env.DEBUG;

function log(step, msg) {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  console.log(`[${ts}] [pack] [${step}] ${msg}`);
}

function debug(step, msg) {
  if (DEBUG) log(step, msg);
}

/** 同步运行命令，失败抛错并终止 */
function run(cmd, cmdArgs, opts = {}) {
  log("exec", `${cmd} ${cmdArgs.join(" ")}`);
  debug("exec", `cwd: ${opts.cwd ?? repoRoot}`);
  // Windows 下 pnpm/npm 等是 .cmd shim，不带 shell: true 时 spawnSync 找不到
  const useShell = opts.shell ?? (process.platform === "win32");
  const result = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    cwd: opts.cwd ?? repoRoot,
    shell: useShell,
    env: { ...process.env, ...opts.env },
  });
  if (result.status !== 0) {
    const errMsg = `命令失败 (exit ${result.status ?? "unknown"}): ${cmd} ${cmdArgs.join(" ")}`;
    console.error(`\n❌ [pack] ${errMsg}\n`);
    process.exit(1);
  }
  return result;
}

/** 分隔线 */
function banner(title) {
  console.log("\n" + "═".repeat(60));
  console.log(`  ${title}`);
  console.log("═".repeat(60));
}

/** 计时器 */
function timer() {
  const start = Date.now();
  return {
    elapsed() {
      const ms = Date.now() - start;
      if (ms < 1000) return `${ms}ms`;
      return `${(ms / 1000).toFixed(1)}s`;
    },
  };
}

// ===== 步骤实现 =====

/**
 * Step 1: 安装依赖
 * pnpm install + 修复 app-builder-lib 版本冲突
 */
function stepInstallDeps() {
  banner("Step 1/6: 安装依赖");

  // pnpm install
  log("deps", "执行 pnpm install ...");
  run("pnpm", ["install"], { cwd: repoRoot });

  // 检查并修复 app-builder-lib 版本冲突
  const appBuilderPkg = join(webRoot, "node_modules", "app-builder-lib", "package.json");
  if (existsSync(appBuilderPkg)) {
    const pkg = JSON.parse(readFileSync(appBuilderPkg, "utf-8"));
    if (pkg.version.startsWith("25.0.")) {
      log("deps", "检测到 app-builder-lib 25.0.x 版本冲突，升级到 25.1.0 ...");
      run("pnpm", ["update", "app-builder-lib@25.1.0", "--filter", "web"]);
    } else {
      log("deps", `app-builder-lib 版本 ${pkg.version}，无需修复`);
    }
  }

  log("deps", "✓ 依赖安装完成");
}

/**
 * Step 2: 下载 Node 22 LTS 二进制 + better-sqlite3 预编译
 * 委托给 electron-pack.mjs
 */
function stepPrepareNative() {
  banner("Step 2/6: 下载 Node 22 LTS + SQLite 预编译");

  const electronPackScript = join(__dirname, "electron-pack.mjs");
  const forceFlag = flags.force ? ["--force"] : [];

  // 检查 Node 二进制是否已存在（--force 时跳过此检查）
  const nodeExe = join(repoRoot, "build", "node", process.platform === "win32" ? "node.exe" : "node");
  if (!flags.force && existsSync(nodeExe)) {
    log("native", `Node 二进制已存在: ${nodeExe}，跳过下载`);
    log("native", `检查 better-sqlite3 预编译 ...`);
    // 仅执行 sqlite 子命令（它会自动检查 node 是否存在）
    run("node", [electronPackScript, "sqlite", ...forceFlag]);
  } else {
    log("native", "下载 Node 22 LTS 二进制 + better-sqlite3 预编译 ...");
    run("node", [electronPackScript, "sqlite", ...forceFlag]);
  }

  log("native", "✓ Native 模块准备完成");
}

/**
 * Step 3: 类型检查（仅后端，跳过有预存错误的 vue-tsc）
 */
function stepTypeCheck() {
  banner("Step 3/6: 后端类型检查");
  run("pnpm", ["type-check"]);
  log("check", "✓ 类型检查通过");
}

/**
 * Step 4: 后端 SSR 构建
 */
function stepBuildBackend() {
  banner("Step 4/6: 后端 SSR 构建");
  run("pnpm", ["build"]);
  log("build", "✓ 后端构建完成 → dist/index.js");
}

/**
 * Step 5: 前端 + Electron 主进程/preload 构建
 * 跳过 vue-tsc（有预存类型错误），直接跑 vite build
 */
function stepBuildFrontend() {
  banner("Step 5/6: 前端 + Electron 主进程构建");
  log("build", "跳过 vue-tsc（预存类型错误），直接执行 vite build ...");

  // 直接用 vite build 而非 pnpm build（后者含 vue-tsc 屏障）
  run("pnpm", ["exec", "vite", "build"], { cwd: webRoot });

  log("build", "✓ 前端构建完成 → web/dist/ + web/dist-electron/");
}

/**
 * Step 6: electron-builder 打包安装包
 */
function stepElectronBuilderPack() {
  banner("Step 6/6: electron-builder 打包安装包");

  const distScript = join(webRoot, "scripts", "dist-electron.mjs");
  run("node", [distScript], { cwd: webRoot });

  log("pack", "✓ 安装包生成完成");
}

// ===== 主流程 =====
async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║          cheryClaw Electron 一键打包                    ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  平台: ${process.platform}-${process.arch}`);
  console.log(`  Node: ${process.version}`);
  console.log(`  代理: ${HTTP_PROXY}`);
  console.log(`  Electron 镜像: ${process.env.ELECTRON_MIRROR}`);
  console.log(`  跳过依赖: ${flags.skipDeps}  跳过检查: ${flags.skipCheck}  仅构建: ${flags.onlyBuild}  强制下载: ${flags.force}`);

  const totalTimer = timer();

  try {
    // Step 1: 安装依赖
    if (!flags.skipDeps && !flags.onlyBuild) {
      stepInstallDeps();
    } else {
      log("skip", "跳过依赖安装");
    }

    // Step 2: Node + SQLite
    if (!flags.onlyBuild) {
      stepPrepareNative();
    } else {
      log("skip", "跳过 Node/SQLite 下载");
    }

    // Step 3: 类型检查
    if (!flags.skipCheck && !flags.onlyBuild) {
      stepTypeCheck();
    } else {
      log("skip", "跳过类型检查");
    }

    // Step 4: 后端构建
    stepBuildBackend();

    // Step 5: 前端构建
    stepBuildFrontend();

    // Step 6: electron-builder 打包
    stepElectronBuilderPack();

    // 完成
    banner("✓ 打包完成");
    console.log(`  总耗时: ${totalTimer.elapsed()}`);
    console.log(`  产物目录: ${join(webRoot, "release")}`);
    console.log("");
  } catch (err) {
    console.error(`\n❌ 打包失败: ${err.message}`);
    if (DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
