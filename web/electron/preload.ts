import { contextBridge, ipcRenderer } from "electron";

/**
 * preload：同步从 main 进程取后端端口配置，注入渲染进程 window.__BACKEND_CONFIG__。
 * 渲染进程据此构建 ws:// 连接地址，无需 fetch /api/config（file:// 下无法 fetch 相对地址）。
 *
 * main 在 createWindow 前已 waitForBackend，配置就绪，sendSync 立即返回。
 *
 * P5c：同时注入 __BACKEND_HTTP_URL__（http://localhost:<webPort>），前端 fetch /api/* 用
 * （httpUrl helper，Electron 模式下 file:// origin==="null" 相对路径不可用）。
 *
 * 同时通过 contextBridge.exposeInMainWorld('__ELECTRON__', ...) 暴露 IPC 桥，
 * 渲染进程可调 window.__ELECTRON__.openConfigDir() 打开用户配置目录（系统文件管理器）。
 */
interface BackendConfig {
  wsPort: number;
  webPort: number;
  transport: "binary" | "json";
}

const config = ipcRenderer.sendSync("get-backend-config") as BackendConfig | null;

if (config) {
  contextBridge.exposeInMainWorld("__BACKEND_CONFIG__", config);
  contextBridge.exposeInMainWorld("__BACKEND_HTTP_URL__", `http://localhost:${config.webPort}`);
}

// IPC 桥：渲染进程 → main 进程
contextBridge.exposeInMainWorld("__ELECTRON__", {
  /** 打开用户配置目录（.chery/）到系统文件管理器。降级路径时自动用降级后的位置。 */
  openConfigDir: () => ipcRenderer.invoke("open-config-dir") as Promise<string>,
});

declare global {
  interface Window {
    __ELECTRON__?: {
      openConfigDir: () => Promise<string>;
    };
  }
}
