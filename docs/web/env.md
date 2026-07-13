# Web 端环境抽象层（platform.ts）

> 源码 [web/src/services/platform.ts](../../web/src/services/platform.ts) ｜ 上级 [README.md](./README.md) ｜ 相关 [./electron.md](./electron.md)（preload 注入格式）、[./deployment.md](./deployment.md)

## 职责

封装"渲染进程跑在哪种平台 / 后端怎么连 / 能调什么原生能力"——业务代码**不再直接读** `window.__BACKEND_CONFIG__` / `window.__BACKEND_HTTP_URL__` / `window.__ELECTRON__` 三个 Electron preload 注入的全局。

## 导出 API

```ts
// web/src/services/platform.ts
export const isElectron: boolean;                       // 单一事实源（基于 __BACKEND_CONFIG__ 存在性）
export interface ElectronApi {                          // preload 暴露的 IPC 能力类型
  openConfigDir(): Promise<string>;
}
export const electronApi: ElectronApi | null;           // 业务门面；null 表示非 Electron 模式
export interface ServerConfig {                         // 后端端口 + transport + 会话 token
  wsPort: number;
  webPort: number;
  transport: "binary" | "json";
  sessionToken?: string;
}
export function httpUrl(path: string): string;          // 拼绝对 HTTP URL（Electron file:// 下相对路径挂）
export function wsUrl(cfg: ServerConfig): string;       // 收敛 WS URL 三分支
export async function getServerConfig(): Promise<ServerConfig>;  // 注入优先，否则 fetch /api/config
```

## 设计要点

### 单一 `Window` 类型声明

三个 `window.__*` 全局集中在 `platform.ts` 顶部 `declare global` 一处声明，**别处不再重复**。`platform.ts` 是 `export {}` 模块（强制成为 ESM），`declare global` 才能正常合并到 `Window` 接口。

### `isElectron` 判定

只用 `window.__BACKEND_CONFIG__` 存在性做判定（preload 注入的"最稳定"标记——main 进程在 createWindow 前已 waitForBackend 就绪）。其他全局都是这一位的派生，**不另立标志**。

### `ServerConfig` 类型归属

`ServerConfig` 定义在 `platform.ts`（与 `getServerConfig()` 同源），`ws.ts` 通过 `import type { ServerConfig } from "./platform"` 消费——避免在 ws.ts 与 platform.ts 之间来回 re-export。

### WS URL 三分支收敛

| 模式 | URL 形式 | 触发条件 |
|------|----------|----------|
| Electron 桌面 | `ws://localhost:<wsPort>` | `isElectron` 为真（preload 注入 `__BACKEND_CONFIG__`） |
| 浏览器 / dev | `<ws/wss>://<host>/ws`（vite proxy） | `import.meta.env.DEV` |
| 浏览器 / prod | `<ws/wss>://<host>:<wsPort>` | 后端静态 serve 同源 + 直连 |

原 [web/src/services/ws.ts](../../web/src/services/ws.ts) 的 if-else 三分支已搬到 `wsUrl()`，调用方 `new WebSocket(wsUrl(cfg))` 即可。

### `httpUrl` 保留转发层

为不一次性改完所有调用点（[App.vue](../../web/src/App.vue) 2 处 + [agentApi.ts](../../web/src/services/agentApi.ts) 2 处 import 路径），`http.ts` 改为 `export { httpUrl } from "./platform"`。`httpUrl` 行为不变，纯转发。

## 消费方式

### 业务组件

```vue
<script setup lang="ts">
import { electronApi } from "@/services/platform";

async function openConfigDir(): Promise<void> {
  if (!electronApi) {
    console.warn("[Xxx] openConfigDir 不可用：当前不是 Electron 模式");
    return;
  }
  await electronApi.openConfigDir();
}
</script>

<template>
  <button :disabled="!electronApi" :title="electronApi ? '打开 .chery/' : '仅 Electron 模式可用'" @click="openConfigDir">
    📁 打开配置目录
  </button>
</template>
```

### 业务服务（HTTP / WS）

```ts
import { httpUrl, getServerConfig, wsUrl } from "@/services/platform";
import type { ServerConfig } from "@/services/platform";

// HTTP：自动适配 Electron / 浏览器
const res = await fetch(httpUrl("/api/auth/me"));

// WS：注入优先，否则 fetch
const cfg: ServerConfig = await getServerConfig();
const ws = new WebSocket(wsUrl(cfg));
```

## 扩展点

### 新增 Electron IPC 能力

1. [web/electron/main.ts](../../web/electron/main.ts) 加 `ipcMain.handle("xxx", ...)`。
2. [web/electron/preload.ts](../../web/electron/preload.ts) 经 `contextBridge.exposeInMainWorld("__ELECTRON__", { ..., xxx })` 暴露。
3. [web/src/services/platform.ts](../../web/src/services/platform.ts) 顶部 `Window.__ELECTRON__` 类型加新方法签名；`electronApi`（`const electronApi = window.__ELECTRON__ ?? null`）自动获得新方法。
4. 业务组件直接 `electronApi.xxx()` 调用。

### 新增运行时配置字段

`ServerConfig` 加字段时，main 进程 [get-backend-config](../../web/electron/main.ts#L178) 与后端 [/api/config](../../docs/service/http.md) 同步扩；前端 `getServerConfig()` / `wsUrl()` 自动透传。

## 依赖与关联

- **依赖**：[web/electron/preload.ts](../../web/electron/preload.ts) 注入三个 `window.__*` 全局；后端 [/api/config](../../docs/service/http.md) 返回 `ServerConfig`。
- **被依赖**：[web/src/services/ws.ts](../../web/src/services/ws.ts)（WS 连接 + RPC）、[web/src/services/http.ts](../../web/src/services/http.ts)（转发层）、[web/src/services/agentApi.ts](../../web/src/services/agentApi.ts)（HTTP 端点）、[web/src/App.vue](../../web/src/App.vue)（认证）、[web/src/features/agent/settings/SettingsDialog.vue](../../web/src/features/agent/settings/SettingsDialog.vue)（打开配置目录）。
- **关联文档**：[README.md#双运行模式](./README.md#双运行模式浏览器--electron)、[./electron.md#preload-注入配置](./electron.md#preload-注入配置)、[./electron.md#扩展点](./electron.md#扩展点)。
