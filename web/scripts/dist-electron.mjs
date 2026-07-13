#!/usr/bin/env node
/**
 * web/scripts/dist-electron.mjs
 * electron-builder 的薄包装，仅做一件事：注入镜像 env 默认值。
 *
 * 背景：electron-builder 打包 Windows / macOS / Linux 时两类下载都依赖 GitHub，国内
 * DNS 落到 20.205.243.166:443，频繁 ETIMEDOUT：
 *
 *   1) 辅助二进制（winCodeSign / Squirrel.Windows / 7z-extract 等），源
 *      https://github.com/electron-userland/electron-builder-binaries
 *      → `@electron/get` 读 `ELECTRON_BUILDER_BINARIES_MIRROR`
 *
 *   2) Electron 本体（如 electron-v43.0.0-win32-x64.zip），源
 *      https://github.com/electron/electron/releases
 *      → `@electron/get` 读 `ELECTRON_MIRROR`（路径末尾必须带斜杠，否则 404）
 *
 * 两个镜像都默认走 npmmirror：
 *   - https://npmmirror.com/mirrors/electron-builder-binaries/
 *   - https://npmmirror.com/mirrors/electron/
 *
 * 与 scripts/electron-pack.mjs 一致（统一默认值来源），确保
 * `pnpm --filter web dist` 与 `pnpm pack:electron` 行为一致。
 *
 * 用法：所有 CLI flag 直接转发，与 `electron-builder` 相同。
 *   node scripts/dist-electron.mjs --win nsis --x64
 *
 * 环境变量：
 *   ELECTRON_BUILDER_BINARIES_MIRROR  已设置则沿用；未设置则注入 npmmirror 默认值；置空
 *                                      字符串可显式禁用（走 GitHub 官方源）。
 *   ELECTRON_MIRROR                   同上；路径末尾斜杠由本脚本兜底补齐。
 *
 * Windows 注意事项：
 *   pnpm 在 .bin/ 同时放 bash shim (electron-builder, #!/bin/sh) 和 .CMD / .ps1
 *   入口。Node spawnSync 不带 shell:true 时直接 exec，Windows 不认 shebang，会
 *   silently exit 1。必须显式走 .CMD shim；找不到时回退 shell:true（让 PATHEXT 处理）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePackConfig, applyProxyEnv } from "../../scripts/pack-config.mjs";

// ===== 代理 & 镜像配置（来自 package.json packConfig，env 可覆盖） =====
const config = resolvePackConfig();
applyProxyEnv(config);

// 定位 electron-builder 的真实 JS 入口：shim 在 Windows 下 stdio 透传不可靠，
// 直接 exec cli.js 最稳。优先 node_modules/electron-builder/cli.js（pnpm 解的目录），
// 否则回退到 .bin shim（带 shell:true 让 PATHEXT 处理）。
const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, "..");
const cliJsCandidates = [
  join(webRoot, "node_modules", "electron-builder", "cli.js"),
];
const directCli = cliJsCandidates.find((p) => existsSync(p));

const binCandidates = [
  "electron-builder",
  "electron-builder.cmd",
  "electron-builder.CMD",
  "electron-builder.ps1",
].map((name) => join(webRoot, "node_modules", ".bin", name));
const shimBin = binCandidates.find((p) => existsSync(p)) ?? "electron-builder";

const args = process.argv.slice(2);

let executable;
let useShell = false;
if (directCli) {
  // 直走 cli.js；通过 node 调用（用 process.execPath 即当前 node 进程同版本）
  executable = process.execPath;
  args.unshift(directCli);
} else {
  // fallback：走 shim；Windows 用 .CMD 或 shell:true 兼容 PATHEXT
  executable = shimBin;
  if (process.platform === "win32" && !/\.(cmd|CMD)$/i.test(executable)) {
    useShell = true;
  }
}

if (process.env.DEBUG) {
  console.error("[dist-electron] BUILDER_BINARIES_MIRROR=", process.env.ELECTRON_BUILDER_BINARIES_MIRROR);
  console.error("[dist-electron] ELECTRON_MIRROR=", process.env.ELECTRON_MIRROR);
  console.error("[dist-electron] EXEC=", executable);
  console.error("[dist-electron] ARGS=", args.join(" "));
  console.error("[dist-electron] SHELL=", useShell);
}

const result = spawnSync(executable, args, {
  stdio: "inherit",
  env: process.env,
  shell: useShell,
});

process.exit(result.status ?? 1);