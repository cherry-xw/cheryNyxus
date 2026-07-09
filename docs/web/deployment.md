# 前后端连接与部署模式

> 上级 [README.md](./README.md) ｜ 相关 [protocol.md](../protocol.md)、[interaction.md](../interaction.md)、[electron.md](./electron.md)、[.chery/config.yaml](../../.chery/config.yaml)

## 职责

定义 `web/` 前端与 root 后端的三种运行/部署模式,以及各模式下前后端如何连接。**后端永远保留独立编译运行能力**(模式 1),前端按分发形态选择挂载方式(Electron 一体 / 浏览器静态)。

## 三种运行模式

### 模式 1:后端独立运行(基础,已就绪)

后端是 Vite SSR bundle,独立编译独立跑,不依赖前端。

```
vite build --ssr        →  dist/index.js (+ dist/lib/*.node, dist/lib/@swc/wasm/, dist/senses/)
node dist/index.js      →  WebSocket server on config.server.port (8182)
                        →  HTTP server on config.server.web_port (8183, /api/config + 静态 serve)
```

- 编译:`pnpm build`(dev)/ `build:test` / `build:prod`([vite.config.ts](../../vite.config.ts) `postBuildFix`)
- 运行:`node dist/index.js`(`package.json` `main`)
- WS 协议:[protocol.md](../protocol.md)
- HTTP:/api/config + 静态 serve → [docs/service/http.md](../service/http.md)

### 模式 2:Electron 一体打包(代码就绪,native ABI 待解决)

Electron 应用启动时,主进程 spawn **系统 node** 跑后端 bundle(`node + index.js`,弃用 `ELECTRON_RUN_AS_NODE`),preload 注入端口配置,渲染进程 `loadFile` 加载本地前端产物,连本地 WS。

```
electron 启动
  ├─ main: spawn(getNodeExecutable(), [后端 bundle], {env: CHERY_DIR, DB_DIR?})  // 系统 node,非 ELECTRON_RUN_AS_NODE
  │    ├─ 轮询 http://localhost:<web_port>/api/config 等就绪
  │    └─ 打包时 DB_DIR = app.getPath('userData')（可写）
  ├─ preload: ipcRenderer.sendSync('get-backend-config') → window.__BACKEND_CONFIG__
  ├─ 渲染进程: loadFile(dist/index.html)
  └─ 前端 WS 客户端读 window.__BACKEND_CONFIG__ → ws://localhost:<wsPort>
```

- main spawn:[electron/main.ts](../../web/electron/main.ts)
- preload 注入:[electron/preload.ts](../../web/electron/preload.ts)
- 前端读 injected config:[ws.ts](../../web/src/services/ws.ts) `connect()`
- 打包:[electron-builder.yml](../../web/electron-builder.yml)(`extraResources` 打后端 `dist/` + `.chery/`)
- ⚠ **native ABI 待解决**:见 [关键坑](#native-addon-abi模式-2-待解决)

### 模式 3:Web 浏览器打包(已就绪)

前端构建为浏览器静态产物,后端 HTTP serve,浏览器访问后端 URL。

```
pnpm web:build          →  web/dist/ (index.html + assets)
node dist/index.js      →  HTTP server on :8183 (serve web/dist/ + /api/config)
                        →  WebSocket server on :8182
浏览器                  →  http://localhost:8183
                        →  fetch('/api/config') → {wsPort, transport}
                        →  前端 WS 客户端 → ws://localhost:8182
```

- 后端 HTTP serve:[src/service/http/index.ts](../../src/service/http/index.ts)
- 静态目录:`WEB_DIST_DIR` env,默认 `../web/dist`(相对后端 `dist/`)
- 开发期:`dev:all`(后端 + `web:dev`),前端 `vite.config.ts`:
  - `server.host: true` → 监听 0.0.0.0,支持内网跨机器访问(如其他主机 `http://<server-ip>:5173/`)
  - proxy `/api` → `:8183`(HTTP)、`/ws` → `ws://:8182`(`ws:true`)→ WS 走 vite proxy,跨机器只需暴露单端口 5173,无需开放 8182
  - 前端 WS url 三模式分支([ws.ts](../../web/src/services/ws.ts)):Electron(`__BACKEND_CONFIG__`)→ 直连 wsPort;dev(`import.meta.env.DEV`)→ `ws://<访问地址>/ws`(走 vite proxy);生产 → 直连 `ws://<host>:<wsPort>`(8182 需对客户端开放)

## 数据流对比

```
模式 1（后端独立）:
  node dist/index.js ──WS:8182──> (无前端, 供调试)
                    └──HTTP:8183──> /api/config + 静态 serve

模式 2（Electron 一体）:
  electron . ──spawn(system node)──> node dist/index.js ──WS:8182───────────┐
  electron . ──preload──> window.__BACKEND_CONFIG__ ────────────────────────┤
  electron . ──loadFile──> dist/index.html ─────────────────────────────────┘ 渲染进程

模式 3（Web 浏览器）:
  node dist/index.js ──HTTP:8183──> web/dist/ ──> 浏览器
                  └──WS:8182────────────────────────────> 浏览器
  浏览器 fetch('/api/config') → wsPort → 连 WS
```

## 当前进度(gap)

| 能力 | 状态 | 说明 |
|------|------|------|
| 后端 SSR 编译 + 独立运行 | ✅ | [vite.config.ts](../../vite.config.ts) `postBuildFix` |
| 后端 WebSocket server | ✅ | [docs/service/websocket.md](../service/websocket.md) |
| 前端构建(Electron + 浏览器) | ✅ | `pnpm web:build` → `dist/` + `dist-electron/` |
| 前端 WS 客户端 | ✅ | [web/src/services/transport.ts](../../web/src/services/transport.ts) + [ws.ts](../../web/src/services/ws.ts) |
| 后端 HTTP static serve + /api/config | ✅ | [src/service/http/index.ts](../../src/service/http/index.ts) |
| Electron main spawn 后端 | ✅ | [electron/main.ts](../../web/electron/main.ts) |
| preload 注入端口配置 | ✅ | [electron/preload.ts](../../web/electron/preload.ts) |
| DB 路径 → userData | ✅ | `DB_DIR` env([config.ts](../../src/utils/config.ts)),main 打包时注入 `app.getPath('userData')` |
| electron-builder 打包配置 | ✅ | [electron-builder.yml](../../web/electron-builder.yml);GUI 验证留后续 |
| native addon ABI(better-sqlite3 跨 ABI) | ✅ 开发期 / ⚠ 发行版 | 改用系统 node spawn(弃用 ELECTRON_RUN_AS_NODE);发行版需打包 node 二进制,见 [关键坑](#native-addon-abi模式-2) |

## 实现路线

- ✅ 阶段 1:前端 WS 客户端 + 后端 HTTP serve + /api/config + `dev:all` 联调
- ✅ 阶段 2:Electron main spawn + preload + `electron-builder` 配置 + `DB_DIR`
- ✅ 阶段 2:native ABI 改用系统 node spawn 解决(开发期,弃用 `ELECTRON_RUN_AS_NODE`);发行版打包 node 二进制待办
- ✅ 阶段 3:文档同步

## 关键坑

### native addon ABI(模式 2)

**开发期已解决**:弃用 `ELECTRON_RUN_AS_NODE`,改用系统 node spawn 后端(`node + index.js`)。better-sqlite3 用系统 Node ABI,与后端 build 时一致,无跨 ABI 问题。

**原因**:`ELECTRON_RUN_AS_NODE` 用 Electron 内嵌 node(ABI ≈ Node 20),后端 `dist/lib/better_sqlite3.node` 针对系统 node(Node 24,ABI 137),跨 ABI 崩溃。系统 node spawn 用同 ABI,匹配。

**待办(发行版)**:终端用户机器可能无 node。需:
1. 打包 node 二进制到 [electron-builder.yml](../../web/electron-builder.yml) `extraResources`([main.ts](../../web/electron/main.ts) `getNodeExecutable()` 已优先 `../node`)
2. 后端 build 时 better-sqlite3 针对打包的 node 版本编译(prebuild 或 node-gyp 匹配 ABI)

`electron-builder install-app-deps` / `npmRebuild` 只 rebuild `web/` deps,不触及 root better-sqlite3 —— 因改用系统 node,无需 electron-rebuild。

### 后端资源分发(模式 2,已配置)

[electron-builder.yml](../../web/electron-builder.yml) `extraResources`:

| 资源 | from | to | 用途 |
|------|------|-----|------|
| 后端 bundle | `../dist` | `dist` | `index.js` + `lib/*.node` + `lib/@swc/wasm/` + `senses/` |
| 配置 | `../.chery` | `.chery` | `config.yaml` + `system.md` + `skills/` + `senses/`(filter 排除 `db/`) |

main spawn 时 `CHERY_DIR = resources/`(只读 config/skills/senses),`DB_DIR = app.getPath('userData')/.chery/db`(可写)。

### DB 路径(模式 2,已解决)

- [config.ts](../../src/utils/config.ts):`db_dir = process.env.DB_DIR ?? cheryDir/.chery/db`
- [electron/main.ts](../../web/electron/main.ts):打包时(`app.isPackaged`)注入 `DB_DIR = app.getPath('userData')/.chery/db`;开发期 `electron .` 沿用 `CHERY_DIR/.chery/db`(项目目录)

### 端口协调(模式 2,已解决)

main 常量 `WS_PORT`/`WEB_PORT`(默认 8182/8183,可 env 覆盖);`waitForBackend()` 轮询 `/api/config` 确认就绪 + 取端口;preload `sendSync('get-backend-config')` 同步注入渲染进程 `window.__BACKEND_CONFIG__`。渲染进程据此连 `ws://localhost:<wsPort>`,无需 `fetch('/api/config')`(file:// 下无法 fetch 相对地址)。

## 依赖与关联

- **后端**:root `dist/index.js`([vite.config.ts](../../vite.config.ts) SSR 构建 + `postBuildFix`),协议见 [protocol.md](../protocol.md),HTTP 模块见 [docs/service/http.md](../service/http.md)。
- **前端**:[web/](../../web/) 工作区,构建见 [README.md](./README.md),Electron 集成见 [electron.md](./electron.md)。
- **配置**:`config.server.port`(WS 8182)/ `config.server.web_port`(HTTP 8183)见 [src/utils/config.ts](../../src/utils/config.ts) + [.chery/config.yaml](../../.chery/config.yaml)。
- **横切参考**:[interaction.md](../interaction.md)(RPC 交互序列)、[protocol.md](../protocol.md)(WS 帧格式 + HTTP API)。

## 扩展点

- **CORS**:当前 HTTP 不带 CORS(浏览器模式同源,Electron 模式 preload 注入不走 fetch)。若需跨域访问 `/api/config`,在 [http/index.ts](../../src/service/http/index.ts) 加 `Access-Control-Allow-Origin`。
- **Electron native ABI 解决**:见上方「解决方向」,选一种实现。
- **electron-builder 打包验证**:`pnpm --filter web dist` 产安装包;GUI 运行验证需 xrdp(见 [electron.md](./electron.md#运行环境坑xrdp))。
