# Web 工作区总览

> 源码 [web/](../../web/) ｜ 上级 [docs](../) ｜ 相关 [protocol.md](../protocol.md)、[interaction.md](../interaction.md)、[./electron.md](./electron.md)、[./deployment.md](./deployment.md)、[./pack-guide.md](./pack-guide.md)（打包操作手册）、[./electron-pack-progress.md](./electron-pack-progress.md)（打包进度跟踪）

## 职责

`web/` 是 CheryNyxus 的**前端工作区**——pnpm workspace + Turborepo monorepo 中的一个 package，与后端（root）同仓不同包。前端通过 `/api/config` 获取公开服务配置，并用 WebSocket 客户端连接后端 RPC（[protocol.md](../protocol.md)）。

### 技术栈

| 维度 | 选型 |
|------|------|
| 框架 | Vue 3.5 + `<script setup>` + TypeScript（严格模式，`noUncheckedIndexedAccess`） |
| 构建 | Vite 8 + `@vitejs/plugin-vue` 6 |
| 路由 | Vue Router 4（`createWebHashHistory`，Electron `file://` 必需） |
| 状态 | Pinia 2（当前空，[stores/index.ts](../../web/src/stores/index.ts) 占位） |
| UI | Element Plus 2（当前全量注册，后续按需引入） |
| 桌面 shell | Electron 43（可选，经 `vite-plugin-electron`）→ 详见 [./electron.md](./electron.md) |

### monorepo 定位

- **包管理器**：pnpm 11.9+（全局安装）。[pnpm-workspace.yaml](../../pnpm-workspace.yaml) 声明 `packages: [web]` + `allowBuilds`（`better-sqlite3`/`esbuild`/`vue-demi`/`electron` 必须 true 才能编译 native addon）。
- **backend 留 root**（未挪到 `apps/`）。root [tsconfig.json](../../tsconfig.json) `exclude` 含 `"web"`，前后端 TS 互不污染。
- **turbo 不能以 root（backend）为目标**：pnpm 递归 workspace 列表不含 root，turbo 的 package graph 只有 `web`。故统一命令不走 `turbo run`，走 `concurrently` / 链式 `pnpm --filter web`。[turbo.json](../../turbo.json) + turbo 仍保留，供 web 及将来新增 workspace 用。

## 文件清单

| 路径 | 职责 |
|------|------|
| [web/package.json](../../web/package.json) | workspace 包定义；`scripts`: dev / dev:web / dev:electron / build / type-check / electron |
| [web/vite.config.ts](../../web/vite.config.ts) | Vite 配置；`ELECTRON_ENABLED` 开关条件挂 electron 插件；`base:'./'`；`@` 别名；`build.outDir:'../dist/web'`（SPA 进 root `dist/web/`，与 SSR `dist/index.js` 同级，单一可分发目录）；`build.cssMinify:'esbuild'`（绕开 lightningcss 对 Vue `:deep(...)` 的误报警告）；`rollupOptions.manualChunks` 拆 `vendor-{vue,ui,motion,markdown}`；`rollupOptions.onwarn` 静默 `@vueuse/core` 的 `INVALID_ANNOTATION`（上游库已知问题） |
| [web/tsconfig.json](../../web/tsconfig.json) | `references` 拆分 app + node |
| [web/tsconfig.app.json](../../web/tsconfig.app.json) | 渲染进程 TS（严格、Bundler 解析、`@/*` 别名、`noUncheckedIndexedAccess`） |
| [web/tsconfig.node.json](../../web/tsconfig.node.json) | 主进程 / vite 配置 TS（`types:["node"]`、`composite`） |
| [web/index.html](../../web/index.html) | Vite 入口 HTML |
| [web/env.d.ts](../../web/env.d.ts) | `vite/client` 类型 + `*.vue` 模块声明 |
| [web/src/main.ts](../../web/src/main.ts) | 应用入口：挂 Pinia + Router + ElementPlus |
| [web/src/App.vue](../../web/src/App.vue) | 根组件（`el-container` 布局 + `RouterView`） |
| [web/src/router/index.ts](../../web/src/router/index.ts) | 路由（`createWebHashHistory`，当前仅 Home） |
| [web/src/services/transport.ts](../../web/src/services/transport.ts) | WebSocket 帧编解码（binary/json transport） |
| [web/src/services/platform.ts](../../web/src/services/platform.ts) | **环境抽象层**：`isElectron` / `httpUrl` / `wsUrl` / `getServerConfig`，封装 Electron preload 注入的后端连接全局。详见 [./env.md](./env.md) |
| [web/src/services/ws.ts](../../web/src/services/ws.ts) | RPC WebSocket 客户端：读取 `/api/config` / preload 注入配置并建立连接 |
| [web/src/services/http.ts](../../web/src/services/http.ts) | `httpUrl` 转发层（实现见 [platform.ts](../../web/src/services/platform.ts)），仅做 import 兼容 |
| [web/src/stores/index.ts](../../web/src/stores/index.ts) | Pinia store 汇集（脚手架空） |
| [web/src/views/HomeView.vue](../../web/src/views/HomeView.vue) | 示例视图 |
| [web/src/features/pets/](../../web/src/features/pets/) | Pet 模块：桌面智能体状态、预设、GSAP 动画与渲染，详见 [./pet/](./pet/) |
| [web/src/features/agent/settings/tabs/BrainsTab.vue](../../web/src/features/agent/settings/tabs/BrainsTab.vue) | 「AI 大脑」配置：按连接、运行参数与能力分区编辑模型，媒体服务独立成卡片。 |
| [desktop-cyber-workspace.md](./desktop-cyber-workspace.md) | 浏览器赛博桌面：workspace 窗口模型、任务栏展示序契约（与 z 序分离）、桌面文案语言契约。多窗口工作台/胶囊/Electron 原生窗见 [./workbench-multi-window.md](./workbench-multi-window.md)。 |
| [settings.md](./settings.md) | 设置中心资源工作台、角色头像与装备、大量技能分页和仓库检查交互。 |
| [frontend-protocol-binding.md](./frontend-protocol-binding.md) | 前端协议消费手册：RPC / Notification / Chunk 字段映射到 store / StreamState / UI 组件 + 端到端数据通路（App.vue → ws.ts → streamRouter → store → 视图）。新会话接手前端 / 后端改协议时定位受影响前端点的入口 |
| [frontend-refactor-handoff.md](./frontend-refactor-handoff.md) | F1-F5 重构执行手册（transient，F4 落地后归档/并入 [pet/](./pet/) 等永久架构文档） |
| [font-style-guide.md](./font-style-guide.md) | **前端字体字重规范**：全局 400/600 字重收敛规则、豁免清单（图标/pet 特殊视觉/markdown strong）、判别流程。新 UI 样式开发遵循 |
| [web/src/features/agent/AgentDialog.vue](../../web/src/features/agent/AgentDialog.vue) | 会话消息弹窗：配置角色临时编制、以富文本正文编辑消息与 slash 指令 token，并在独立附件区选择、预览和移除媒体。发送目标选择（quickTarget）生命周期约定见 [../interaction.md](../interaction.md) chat.route.suggest 章节。 |
| [web/electron/main.ts](../../web/electron/main.ts) | Electron 主进程：desktop 全工作区透明宠物窗（启动即建）+ settings/workbench 原生独立窗（ManagedWindow 注册表，托盘打开设置）+ Tray（含开机自启开关），详见 [./electron.md](./electron.md) |
| [web/scripts/electron-dev.mjs](../../web/scripts/electron-dev.mjs) | `electron:dev` 跨平台 wrapper：Windows 直接 `vite`（vite-plugin-electron 拉起 electron）；其他平台转发 [electron-dev.sh](../../web/scripts/electron-dev.sh) 选 xrdp display + `unset ELECTRON_RUN_AS_NODE` |

## 核心概念

### 双运行模式（浏览器 / Electron）

`ELECTRON_ENABLED` 环境变量控制 vite 是否加载 electron 插件（[vite.config.ts](../../web/vite.config.ts) `electronEnabled = process.env.ELECTRON_ENABLED !== 'false'`，plugins 数组 `.filter(Boolean)`）：

| 命令（root → web） | 实际执行 | 含义 | 环境 |
|------|------|------|------|
| `pnpm web:dev` → `dev:web` | `ELECTRON_ENABLED=false vite` | 纯浏览器 HMR，无 electron | 任意（无 X 可跑） |
| `pnpm electron:dev` → `dev:electron` | `node scripts/electron-dev.mjs`（Windows 直接 `vite`；其他平台 `bash electron-dev.sh` → `vite`） | vite + electron HMR | Windows 无 / 其他需 X display |
| `pnpm --filter web electron` | `electron .` | 运行 `dist` 构建产物 | 需 X display |

> ⚠ `ELECTRON_ENABLED`（控制 vite 插件加载）与 `ELECTRON_RUN_AS_NODE`（electron 自身环境变量）是**两个不同变量**，混用会导致 electron 当 node 跑不开窗。详见 [./electron.md](./electron.md#运行环境坑xrdp)。

### TypeScript references 拆分

[tsconfig.json](../../web/tsconfig.json) 用 `references` 拆 app（渲染进程）与 node（主进程 / vite 配置），`vue-tsc -b` 分别类型检查。root [tsconfig.json](../../tsconfig.json) `exclude` 含 `"web"`，前后端互不污染。

### 构建产物

| 产物 | 内容 |
|------|------|
| [web/dist/index.html](../../web/dist/index.html) + `assets/` | Vite 渲染产物；JS 资产按 [vite.config.ts](../../web/vite.config.ts) `manualChunks` 拆为 `vendor-{vue,ui,motion,markdown}` 与业务 chunk |
| [web/dist-electron/main.js](../../web/dist-electron/) | rollup 经 `vite-plugin-electron` 产出的主进程 ESM |

`base:'./'` 保证 Electron `loadFile` 相对路径正确。

### 主题对比度 token（2026-08-22 统一增强）

全局主题 token 定义在 [theme.css](../../web/src/styles/theme.css)（`:root` 浅色 / `[data-theme='dark']` 深色两套）：

- **文字层级**：`--ink` / `--nx-text`（正文）→ `--nx-text-dim`（次级）→ `--nx-text-faint`（弱化）。统一拉大层级间与背景的对比（深色 `--nx-text` #d7dfd8→#f0f5f1、`--nx-text-faint` 0.5→0.7；浅色边框/弱化同步增强）。
- **底色**：深色 `--nx-bg` 由青灰 `rgba(55,61,60,0.97)` → **更深 `rgba(37,43,41,0.98)`** 增加文字对比；浅色 `--nx-bg` 更白 `rgba(252,251,248,0.98)`。
- **选中/高亮**：深色面板选中态原用 `color-mix(in srgb, var(--nx-*) 10-18%, transparent)` 低透明叠层（浅紫/浅蓝可读性差）→ 系统提升至 **26-34%（底色更实）+ 边框 55%→70%+（亮边框）**，集中收敛于 [nyxusPopoverTheme.less](../../web/src/features/pets/nyxus/styles/nyxusPopoverTheme.less)（C2/C7/C10/C11/D3/approval-frame 区块）。新增/修改选中态沿用此数值区间，勿回退到 <20%。
- **字重**：深色 CRT 面板（待确认面板 / 节点弹窗）统一 **400 字重**（小字号下 600+ 会糊字）。
- **约定**：组件样式一律引用 `var(--nx-*)` / `var(--ink)` 语义 token，不硬编码 hex / 低透明叠层数值。

## 关键流程

### 开发流程

```
dev:web（浏览器）  : vite serve → http://localhost:5173（无 electron，无 X 依赖）
dev:electron（桌面）: electron-dev.mjs 分发（Windows 直接 vite；Linux/macOS 走 electron-dev.sh 选 xrdp display）→ exec vite
                     → vite-plugin-electron 编译 main.ts → 拉 electron 进程 → HMR
dev:all（root）    : concurrently 并行 backend(pnpm dev) + web(pnpm --filter web dev:web)
```

开发期前端可通过 [vite.config.ts](../../web/vite.config.ts) 代理 `/api` 到后端 HTTP 服务，生产期由后端 HTTP server 直接 serve `web/dist/` 并提供 `/api/config`。

### 生产构建

```
web:build = vue-tsc -b && vite build → dist/ + dist-electron/main.js
electron . → 加载 dist/index.html（join(import.meta.dirname,'..','dist','index.html')）
```

`loadFile` 路径用 `import.meta.dirname` 运行时构造，**不能用 `new URL(literal, import.meta.url)`**——vite 静态分析会把 `index.html` 内联成 data URL → `ERR_INVALID_URL_SCHEME`。详见 [./electron.md](./electron.md#主进程路径解析)。

## 依赖与关联 ⭐

### 与后端（root）的关系

- `web/` 与 root backend 同仓 monorepo，但运行时通过 HTTP + WebSocket 解耦：HTTP 端提供静态资源与 `/api/config`，WebSocket 端承载 RPC。
- **协议契约**：web 通过 WebSocket 消费后端 RPC，规范见 [protocol.md](../protocol.md)，交互序列见 [interaction.md](../interaction.md)。
- **配置**：`web_port` 在 [src/utils/config.ts](../../src/utils/config.ts) + [.chery/config.yaml](../../.chery/config.yaml) 中配置（默认 8183），由后端 HTTP server 消费；前端 `fetch('/api/config')` 获取 `wsPort/webPort/transport`。

### monorepo 工具链

| 工具 | 角色 |
|------|------|
| [pnpm-workspace.yaml](../../pnpm-workspace.yaml) | `packages: [web]` + `allowBuilds`（native addon 白名单） |
| [turbo.json](../../turbo.json) | web 的 task 缓存配置（build outputs `dist/**` + `dist-electron/**`） |
| [package.json](../../package.json)（root） | 聚合命令：`web:dev` / `web:build` / `dev:all` / `build:all` / `type-check:all`（均 `pnpm --filter web ...`） |

> turbo 的 package graph 只有 `web`（pnpm workspace 列表不含 root），故 `turbo run <task>` 只跑 web；统一命令走 `concurrently` / 链式，不走 turbo。

### 前端内部依赖

```
main.ts → App.vue + router + stores(空)
        → Pinia + ElementPlus 全量注册
App.vue → RouterView（router 路由表）
```

## 扩展点

- **扩展 WebSocket RPC**：在 [web/src/services/ws.ts](../../web/src/services/ws.ts) 增加更高层业务封装；底层帧编解码在 [web/src/services/transport.ts](../../web/src/services/transport.ts)，协议见 [protocol.md](../protocol.md)。
- **加路由 / 页面**：[web/src/router/index.ts](../../web/src/router/index.ts) 加路由；`web/src/views/` 下加 `.vue`。Electron 下**必须** `createWebHashHistory`（`file://` 不支持 history API）。
- **加 Pinia store**：`web/src/stores/` 下定义，[stores/index.ts](../../web/src/stores/index.ts) 汇出。
- **扩展 Pet 角色 / 动画**：角色数据集中在 Pet preset 模块，框架中立描述符位于 `domain/pets/motion/animation.ts`，GSAP 执行器位于 `features/pets/composables/usePetMotion.ts`。
- **加 Electron IPC**：[electron/main.ts](../../web/electron/main.ts) 启用 preload；新增 `web/electron/preload.ts`（`contextBridge` 暴露安全 API）；[tsconfig.node.json](../../web/tsconfig.node.json) `include` 加 preload。详见 [./electron.md](./electron.md#扩展点)。
- **Electron 打包**：[./electron.md](./electron.md) 集成 + [./pack-guide.md](./pack-guide.md) 操作手册；构建脚本 [scripts/electron-pack.mjs](../../scripts/electron-pack.mjs)（下载 Node 22 LTS + 拉 better-sqlite3 预编译）+ [web/electron-builder.yml](../../web/electron-builder.yml)。
- **Element Plus 按需引入**：当前全量注册（`app.use(ElementPlus)`）；换 `unplugin-vue-components` + `unplugin-auto-import` 减包体。
- **扩展工具渲染器**：为内置工具添加专用 UI 显示（如 `execute_command`、`read_file`）。在 [web/src/features/agent/renderers/](../../web/src/features/agent/renderers/) 下创建渲染器组件并注册。详见 [./renderer.md](./renderer.md)。
