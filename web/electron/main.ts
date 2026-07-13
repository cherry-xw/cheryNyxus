import { join, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { app, BrowserWindow, ipcMain, shell } from "electron";

const WS_PORT = Number(process.env.WS_PORT ?? 8182);
const WEB_PORT = Number(process.env.WEB_PORT ?? 8183);

let backend: ChildProcess | null = null;
let serverConfig: { wsPort: number; webPort: number; transport: string } | null = null;
/** `getRuntimeRoot()` 解析结果缓存（启动后固定）。 */
let runtimeRoot: string | null = null;

/**
 * 后端 bundle 路径：
 * - 开发期（electron .）：app.getAppPath() = web/，../dist = <root>/dist
 * - 打包后：extraResources dist/ → resources/dist，app.getAppPath() = resources/app，../dist = resources/dist
 */
function getBackendBundle(): string {
  return join(app.getAppPath(), "..", "dist", "index.js");
}

/**
 * node 可执行文件：打包后优先 extraResources 内的 node；否则系统 PATH 的 node。
 *
 * 路径模式：
 * - 打包后：resources/node/node[.exe]（electron-builder.yml extraResources 把 build/node/ 整目录打入）
 * - 开发期：系统 PATH 的 node
 *
 * 用系统 node 跑后端 bundle（node + index.js），better-sqlite3 用系统 Node ABI，
 * 与后端 build 时一致 —— 避免 ELECTRON_RUN_AS_NODE（Electron 内嵌 node ABI）的跨 ABI 问题。
 * 发行版通过 scripts/electron-pack.mjs 下载匹配的 Node 22 LTS 二进制到 build/node/。
 */
function getNodeExecutable(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  const bundled = join(app.getAppPath(), "..", "node", "node" + ext);
  if (existsSync(bundled)) return bundled;
  return "node";
}

/**
 * 解析用户运行时配置根目录（`CHERY_DIR` 的父目录，即 `.env` 与 `.chery/` 所在目录）：
 *
 * - 打包后：afterPack 钩子（[scripts/post-pack.mjs](../../scripts/post-pack.mjs)）已经把 `.env`
 *   和 `.chery/` 复制到 `cheryClaw.exe` 同级。默认 `dirname(process.execPath)`；
 *   `.env` 中 `CHERY_DIR` 非空时改用其值（便于跨平台部署）。
 * - 开发期：默认项目根 `<repo>/`（含 `.chery/`），`CHERY_DIR` env 优先。
 *
 * 返回值缓存：启动后固定，IPC `open-config-dir` 复用。
 */
function getRuntimeRoot(): string {
  if (runtimeRoot) return runtimeRoot;
  if (!app.isPackaged) {
    runtimeRoot = process.env.CHERY_DIR ?? join(app.getAppPath(), "..");
  } else {
    runtimeRoot = process.env.CHERY_DIR || dirname(process.execPath);
  }
  return runtimeRoot;
}

/**
 * 从 `getRuntimeRoot()/.env` 加载环境变量到 `process.env`。
 *
 * 加载规则：
 * - 跳过空行和 `#` 注释
 * - 空值（如 `CHERY_DIR=`）**不灌进 `process.env`**——保留默认推断行为
 * - 已存在的 `process.env` 变量**不覆盖**——OS env 优先级最高
 *
 * 注意：模板 `.env` 与运行时 `.env` 都在 `getRuntimeRoot()` 下，打包后由 afterPack
 * 钩子在打包阶段复制；不存在则静默跳过（用户可能手动删了 `.env`）。
 */
function loadEnvFile(): void {
  const envPath = join(getRuntimeRoot(), ".env");
  if (!existsSync(envPath)) {
    console.log(`[setup] no .env at ${envPath}, skipping env load`);
    return;
  }

  const content = readFileSync(envPath, "utf8");
  let loadedCount = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (!value) continue; // 空值：保留默认推断（不灌进 process.env）
    if (key in process.env) continue; // 不覆盖已有（OS env 优先）
    process.env[key] = value;
    loadedCount++;
  }
  console.log(`[setup] loaded ${loadedCount} env var(s) from ${envPath}`);
}

/**
 * 启动后端子进程：系统 node + 后端 SSR bundle（node + index.js）。
 *
 * - `CHERY_DIR`：来自 `process.env.CHERY_DIR`（`.env` 灌入）或 `getRuntimeRoot()`
 * - `DB_DIR`：打包后落 `app.getPath('userData')/.chery/db`（可写，NSIS 默认 Program Files
 *   也能写）；开发期沿用 `CHERY_DIR/.chery/db`
 */
function startBackend(): ChildProcess {
  // 加载 .env（必须在 CHERY_DIR 计算之前，因为 .env 可能覆盖 CHERY_DIR）
  loadEnvFile();

  // 重新解析 runtimeRoot（CHERY_DIR 可能被 .env 改了）
  runtimeRoot = null;
  const cheryDir = getRuntimeRoot();

  const env: NodeJS.ProcessEnv = { ...process.env, CHERY_DIR: cheryDir };
  // 清理 shell 可能注入的 ELECTRON_RUN_AS_NODE（系统 node 不认，但避免污染）
  delete env.ELECTRON_RUN_AS_NODE;
  if (app.isPackaged) {
    env.DB_DIR = join(app.getPath("userData"), ".chery", "db");
  }

  const child = spawn(getNodeExecutable(), [getBackendBundle()], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[backend] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[backend] ${d}`));
  child.on("exit", (code) => {
    console.log(`[backend] exited with ${code}`);
  });
  return child;
}

/**
 * 轮询 /api/config 等后端就绪，顺带取端口配置。
 */
async function waitForBackend(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${WEB_PORT}/api/config`);
      if (res.ok) {
        serverConfig = (await res.json()) as { wsPort: number; webPort: number; transport: string };
        return;
      }
    } catch {
      // 后端尚未就绪
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`后端启动超时（${timeoutMs}ms）`);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "cheryClaw",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, "preload.mjs"),
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(async () => {
  // 单实例锁
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  // IPC：preload 同步取后端端口配置（createWindow 在 waitForBackend 之后，配置已就绪）
  ipcMain.on("get-backend-config", (event) => {
    event.returnValue = serverConfig ?? { wsPort: WS_PORT, webPort: WEB_PORT, transport: "binary" };
  });

  // IPC：渲染进程打开用户配置目录（系统文件管理器）
  ipcMain.handle("open-config-dir", () => {
    const target = join(getRuntimeRoot(), ".chery");
    return shell.openPath(target);
  });

  // 启动日志：让用户在 console / 日志文件里能找到 .env 和 .chery 的真实路径
  console.log(`[setup] runtime root: ${getRuntimeRoot()}`);
  console.log(`[setup] .chery path: ${join(getRuntimeRoot(), ".chery")}`);
  console.log(`[setup] .env path: ${join(getRuntimeRoot(), ".env")}`);

  try {
    backend = startBackend();
    await waitForBackend();
    createWindow();
  } catch (e) {
    console.error("启动后端失败:", e);
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (backend && !backend.killed) {
    backend.kill("SIGTERM");
    backend = null;
  }
});
