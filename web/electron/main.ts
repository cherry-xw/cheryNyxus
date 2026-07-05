import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { app, BrowserWindow, ipcMain } from "electron";

const WS_PORT = Number(process.env.WS_PORT ?? 8182);
const WEB_PORT = Number(process.env.WEB_PORT ?? 8183);

let backend: ChildProcess | null = null;
let serverConfig: { wsPort: number; webPort: number; transport: string } | null = null;

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
 * 用系统 node 跑后端 bundle（node + index.js），better-sqlite3 用系统 Node ABI，
 * 与后端 build 时一致 —— 避免 ELECTRON_RUN_AS_NODE（Electron 内嵌 node ABI）的跨 ABI 问题。
 * 代价：发行版需打包 node 二进制（extraResources），否则依赖用户机器已装 node。
 */
function getNodeExecutable(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  const bundled = join(app.getAppPath(), "..", "node" + ext);
  if (existsSync(bundled)) return bundled;
  return "node";
}

/**
 * 启动后端子进程：系统 node + 后端 SSR bundle（node + index.js）。
 * - CHERY_DIR：开发期默认 <root>（项目 .chery）；打包后默认 resources/（extraResources 的 .chery）
 * - DB_DIR：打包后落 app.getPath('userData')（可写）；开发期沿用 CHERY_DIR/.chery/db
 */
function startBackend(): ChildProcess {
  const cheryDir = process.env.CHERY_DIR ?? join(app.getAppPath(), "..");
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
