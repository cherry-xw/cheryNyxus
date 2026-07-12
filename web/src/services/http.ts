/**
 * httpUrl：拼绝对 URL 调后端 HTTP 端点（/api/*）。
 *
 * Electron 模式：preload 经 contextBridge 注入 window.__BACKEND_HTTP_URL__（"http://localhost:<webPort>"），
 * 渲染进程 file:// origin === "null"，相对路径 fetch 直接挂；必须显式 base。
 *
 * 浏览器模式：无注入 → 空 base → 返回相对路径（与原 fetch("/api/...") 等价，Vite dev proxy / 生产同源 serve 直连）。
 *
 * 详细：[docs/service/http.md](../../../docs/service/http.md)「前端调用路径与 httpUrl helper」段。
 */
declare global {
  interface Window {
    /** Electron preload 注入（http://localhost:<webPort>）；浏览器模式无 */
    __BACKEND_HTTP_URL__?: string;
  }
}

export function httpUrl(path: string): string {
  const base = typeof window !== "undefined" ? (window.__BACKEND_HTTP_URL__ ?? "") : "";
  return `${base}${path}`;
}