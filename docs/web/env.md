# Web 端环境抽象层（platform.ts）

> 源码 [web/src/services/platform.ts](../../web/src/services/platform.ts) ｜ 上级 [README.md](./README.md) ｜ 相关 [./electron.md](./electron.md)（preload 注入格式）、[./deployment.md](./deployment.md)

## 职责

封装“渲染进程跑在哪种平台 / 后端怎么连”——业务代码**不再直接读** `window.__BACKEND_CONFIG__` / `window.__BACKEND_HTTP_URL__` 两个 Electron preload 注入的全局。需要操作本机资源且后端可承担的业务能力（如打开配置目录）统一走 WebSocket RPC。

## 导出 API

```ts
// web/src/services/platform.ts
export const isElectron: boolean;                       // 单一事实源（基于 __BACKEND_CONFIG__ 存在性）
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

两个 `window.__*` 全局集中在 `platform.ts` 顶部 `declare global` 一处声明，**别处不再重复**。`platform.ts` 是 `export {}` 模块（强制成为 ESM），`declare global` 才能正常合并到 `Window` 接口。

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

### 业务组件调用后端原生能力

```vue
<script setup lang="ts">
import { agentApi } from "@/services/agentApi";

async function openConfigDir(): Promise<void> {
  await agentApi.openConfigDir();
}
</script>

<template>
  <button title="打开配置文件夹" @click="openConfigDir">
    📁 打开配置文件夹
  </button>
</template>
```

该调用经 WebSocket RPC 在后端主机执行；远程浏览器不会打开浏览器客户端机器的目录。

**目录选择（预设 workspace）**：仅 Electron 模式可用原生对话框拿**绝对路径**——preload 注入 `__PICK_DIRECTORY__`（main 进程 `dialog.showOpenDialog({ properties: ['openDirectory'] })`）。Electron 渲染进程与后端同机，所选即后端机器路径（所有执行在后端）。**浏览器模式无目录选择**：前端机器路径与后端无关（浏览器安全沙箱也无绝对路径），纯文本输入。路径校验双层：前端 `isAbsolutePathFormat` 即时格式校验（POSIX `/` / Windows `C:\` / UNC `\\server\share`，非法红框 `ws-warning`）+ 后端 `validateWorkspace` RPC 存在性校验（设置面板实时 + 保存时）。

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

### 新增后端原生能力

1. 按 [service/message.md](../service/message.md) 的扩展点新增 Method、`RpcMethodMap`、schema 与 handler。
2. 在 `web/src/services/agentApi.ts` 增加业务方法，组件只调用该门面。
3. 若能力会操作文件或进程，协议参数应限制为最小固定集合；例如 `utils.openConfigDir` 不接受客户端路径。
4. 仅当能力必须运行在 Electron main 进程且后端无法承担时，才新增 `ipcMain.handle` 与 preload bridge。

### 新增运行时配置字段

`ServerConfig` 加字段时，main 进程 [get-backend-config](../../web/electron/main.ts#L178) 与后端 [/api/config](../../docs/service/http.md) 同步扩；前端 `getServerConfig()` / `wsUrl()` 自动透传。

## 依赖与关联

- **依赖**：[web/electron/preload.ts](../../web/electron/preload.ts) 注入两个后端连接相关的 `window.__*` 全局；后端 [/api/config](../../docs/service/http.md) 返回 `ServerConfig`。
- **被依赖**：[web/src/services/ws.ts](../../web/src/services/ws.ts)（WS 连接 + RPC）、[web/src/services/http.ts](../../web/src/services/http.ts)（转发层）、[web/src/services/agentApi.ts](../../web/src/services/agentApi.ts)（HTTP/RPC 端点）、[web/src/App.vue](../../web/src/App.vue)（认证）。
- **关联文档**：[README.md#双运行模式](./README.md#双运行模式浏览器--electron)、[./electron.md#preload-注入配置](./electron.md#preload-注入配置)、[./electron.md#扩展点](./electron.md#扩展点)。
