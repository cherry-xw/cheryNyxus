# Electron 集成详解

> 源码 [web/electron/](../../web/electron/) ｜ 上级 [README.md](README.md) ｜ 相关 [deployment.md](deployment.md)、[web/vite.config.ts](../../web/vite.config.ts)、[./env.md](env.md)

## 职责

Electron 是 CheryNyxus 的前端桌面壳，负责窗口、托盘、目录选择、主题同步和桌面鼠标交互。后端由独立 Node 进程、本地管理器或远程部署运行；Electron 不启动、打包或管理后端。

## 集成方式

`web/vite.config.ts` 通过 `vite-plugin-electron/simple` 编译 `electron/main.ts` 和 `electron/preload.ts`。开发期由 Vite 提供渲染页面，生产期主进程使用 `loadFile` 加载 `web/dist/index.html`。

- `web/electron/main.ts` 只创建窗口、处理桌面 IPC、托盘和显示器变化。
- `web/electron/preload.ts` 只暴露桌面能力；不注入后端端口、session token、Node runtime 或后端文件路径。
- 渲染进程的 HTTP/WS 连接统一经过 [`web/src/services/platform.ts`](../../web/src/services/platform.ts)。纯前端 Electron 没有旧版后端配置时，会发现本机管理器 `127.0.0.1:39980`。
- 首次连接或后端重启后的连接发现不由 Electron main 等待后端完成；`getServerConfig({ refresh: true })` 会重新读取管理器和后端的实际监听信息。

## 多窗口与桌面交互

当前 Electron surface 包括 desktop、settings、workbench、composer、history、login 和 task-center。各 surface 自己连接后端 WebSocket；窗口之间只经 preload bridge 传递窗口控制、主题和必要的桌面事件，不经 IPC 传递业务凭据或后端进程控制。

desktop 窗口承载桌面宠物和 Nyxus 入口，支持鼠标穿透、全屏隐藏和显示器变化自适应。settings、workbench 和 composer 使用独立原生窗口；窗口行为和当前 surface 入口以 `main.ts` 的 `createManagedWindow()`、`window:open`、`window:control` 为准。

## IPC 通道边界

| 通道 | 用途 |
| --- | --- |
| `dialog:pickDirectory` | Electron 原生目录选择 |
| `desktop:mouse-passthrough` | desktop 窗口鼠标穿透 |
| `window:open` | 创建或聚焦 settings/workbench/composer 等窗口 |
| `window:control` | 最小化、最大化、恢复和关闭窗口 |
| `window:set-background`、`window:flash` | 窗口视觉和提醒 |
| `theme:changed`、`theme:set` | 多窗口主题同步 |
| `auth:changed` | 桌面窗口间同步登录状态 |

新增业务能力优先扩展后端 WebSocket RPC；只有必须由 Electron main 执行、且后端无法执行的桌面能力，才新增 IPC 和 preload bridge。

## 主进程路径解析

主进程使用 `import.meta.dirname` 加载 `../dist/index.html`，开发期使用 `VITE_DEV_SERVER_URL`。主进程不得加入后端 spawn、后端等待、guardian 管理、后端环境注入或退出时杀后端逻辑。

## 打包边界

`web/electron-builder.yml` 只应包含前端静态产物和 Electron 主进程/preload 产物：

```yaml
files: [dist/**, dist-electron/**]
```

不得通过 `extraResources` 打包后端 bundle、Node runtime、`.env` 或 `.chery` 模板。后端发布、配置和凭据由独立运行入口及本地管理器提供。打包静态检查至少确认：主进程没有后端 `spawn`，资源清单没有后端 bundle 和 Node runtime。

## 构建产物

| 产物 | 内容 |
| --- | --- |
| `web/dist/` | Vite 渲染页面和静态资源 |
| `web/dist-electron/main.js` | Electron 主进程 |
| `web/dist-electron/preload.mjs` | Electron preload |

`vite-plugin-electron` 在构建时只编译这些入口，不启动 Electron，因此 headless 类型检查和构建可以执行。Electron 实机操作、托盘、跨窗口和远程连接属于 H 的人工验收。

## 托盘与服务边界

Electron 自身的托盘只控制桌面壳窗口，不控制后端。后端管理器的 Windows 托盘入口位于 [`deploy/windows/tray-manager.ps1`](../../deploy/windows/tray-manager.ps1)，Linux 服务入口位于 [`deploy/systemd/service.sh`](../../deploy/systemd/service.sh)。两者由管理器 CLI 安装，真实开机启动、自动恢复和跨设备行为留到 H。

## 运行环境

桌面透明窗、GPU 安全模式、全屏检测和 xrdp 只影响 Electron 窗口。定位黑屏优先查看 `render-process-gone`、`child-process-gone` 和 `did-fail-load` 日志；这些问题不能通过把后端重新塞回 Electron 解决。

## 依赖与关联

- 依赖：`vite-plugin-electron`、Electron 43、Vite 和 Vue。
- 连接入口：[`web/src/services/platform.ts`](../../web/src/services/platform.ts)、[`web/src/services/ws.ts`](../../web/src/services/ws.ts)。
- 运行指南：[`docs/guides/backend-runtime.md`](../guides/backend-runtime.md)、[`docs/guides/relay-deployment.md`](../guides/relay-deployment.md)。
- 前端部署：[`deployment.md`](deployment.md)。
