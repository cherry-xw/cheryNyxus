# cheryClaw Electron 桌面应用打包 — 进度总结

> 日期：2026-07-13 | 分支：sp | 状态：**已完成**

---

## 1. 需求概述

将 cheryClaw 前后端打包为 Electron 桌面应用安装包，支持 Windows (nsis)、macOS (dmg)、Linux (AppImage)，内嵌 Node 22 LTS 二进制。

---

## 2. 项目结构速览

```
cheryClaw/
├── src/                    # 后端源码（Node.js + better-sqlite3）
├── dist/                   # 后端 SSR 构建产物（vite build --ssr）
│   ├── index.js
│   └── lib/
│       ├── better-sqlite3-*.node
│       └── @swc/wasm/
├── web/
│   ├── src/                # 前端源码（Vue3 + Element Plus）
│   ├── electron/
│   │   ├── main.ts         # Electron 主进程
│   │   └── preload.ts      # preload 桥接
│   ├── dist/               # 前端渲染产物
│   ├── dist-electron/      # Electron 主进程/preload 产物
│   ├── scripts/
│   │   └── dist-electron.mjs # electron-builder 薄包装（注入镜像 env）
│   ├── vite.config.ts
│   └── electron-builder.yml
├── scripts/
│   ├── pack-config.mjs     # 打包配置单一事实源（读 package.json packConfig）
│   ├── pack-electron.mjs   # 一键打包脚本（6 步串联）
│   └── electron-pack.mjs   # 底层打包脚本（Node/SQLite 下载 + 构建）
├── .chery/                 # 运行时配置
├── package.json            # packConfig 字段 = 配置单一事实源
└── pnpm-workspace.yaml
```

---

## 3. 完成状态

### 3.1 后端构建 ✅

| 项目 | 说明 |
| --- | --- |
| SSR build | `vite build --ssr` → `dist/index.js` |
| native addon 处理 | `vite-plugin-native-modules` + `postBuildFix` |
| .node 文件重定位 | `dist/` → `dist/lib/`（带 EBUSY 重试） |
| require 路径修正 | `"./X.node"` → `"./lib/X.node"` |
| @swc/wasm 复制 | → `dist/lib/@swc/wasm/` |
| .env 清理 | 防历史构建泄露密钥 |

**构建命令**：`pnpm build`（dev）/ `pnpm build:prod`（prod）

### 3.2 前端构建 ✅

| 项目 | 说明 |
| --- | --- |
| Vue3 构建 | `vue-tsc -b && vite build` → `web/dist/` |
| Electron 主进程编译 | `vite-plugin-electron/simple` → `web/dist-electron/main.js` |
| preload 编译 | → `web/dist-electron/preload.mjs` |
| base: './' | 兼容 Electron loadFile |
| 开发 proxy | `/api` → :8183, `/ws` → :8182 |

### 3.3 Electron 主进程逻辑 ✅

| 项目 | 说明 |
| --- | --- |
| `getNodeExecutable()` | 优先 `resources/node[.exe]`，fallback 系统 `node` |
| `getBackendBundle()` | `app.getAppPath()/../dist/index.js` |
| `startBackend()` | spawn 系统 node，设 CHERY_DIR |
| `loadEnvFile()` | 读 `cheryClaw.exe/.env`，空值不灌进 process.env，不覆盖 OS env；不存在则跳过 |
| `getRuntimeRoot()` | 打包后 `process.env.CHERY_DIR || dirname(process.execPath)`；开发期项目根 |
| afterPack 钩子 | [web/scripts/post-pack.mjs](../../web/scripts/post-pack.mjs) 把 `.env.example` / `.chery.template/` 复制到 `cheryClaw.exe` 同级，打包即就位 |
| 配置目录入口 | 设置面板调用后端 `utils.openConfigDir` WebSocket RPC，由后端系统默认打开器打开 `<CHERY_DIR>/.chery`；不再维护专用 Electron IPC |
| preload 注入 | `__BACKEND_CONFIG__` + `__BACKEND_HTTP_URL__` |

### 3.4 electron-builder.yml 配置 ✅

```yaml
files: [dist/**, dist-electron/**]
extraResources:
  - from: ../dist    → dist                       # 后端 bundle
  - from: ../.env.example → .env.example         # .env 模板（afterPack 复制为 cheryClaw.exe/.env）
  - from: ../.chery.template → .chery.template   # .chery 模板（afterPack 复制为 cheryClaw.exe/.chery/）
  - from: ../build/node → node                   # Node 22 LTS 二进制
afterPack: ./scripts/post-pack.mjs               # 钩子：模板 → cheryClaw.exe 同级
targets: win=nsis, mac=dmg, linux=AppImage
```

### 3.5 打包配置统一 ✅

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 默认值 | `package.json` `packConfig` 字段 | 代理、镜像、Node 版本 |
| 读取/导出 | `scripts/pack-config.mjs` | 读 package.json + env 覆盖，注入 process.env |
| 底层执行 | `scripts/electron-pack.mjs` | Node 下载 + SQLite 预编译 + 构建 |
| 一键串联 | `scripts/pack-electron.mjs` | 6 步全流程 |
| builder 包装 | `web/scripts/dist-electron.mjs` | electron-builder + 注入镜像 env |

### 3.6 npm scripts ✅

| 命令 | 用途 |
| --- | --- |
| `pnpm electron:pack` | 一键全量打包 |
| `pnpm electron:pack:fast` | 增量打包（跳过依赖安装 + Node/SQLite 下载 + 类型检查，假定缓存已就绪） |

底层子命令直接调用：`node scripts/electron-pack.mjs [node\|sqlite\|pack]`

---

## 4. 已解决问题

### 4.1 Node 二进制打包 ✅

`scripts/electron-pack.mjs` 从 nodejs.org 下载 Node 22 LTS 二进制到 `build/node/`，`electron-builder.yml` `extraResources` 打入 `resources/node[.exe]`。

### 4.2 better-sqlite3 ABI 匹配 ✅

用下载的 Node 22 二进制取 ABI，从 GitHub release 直下对应 `better_sqlite3.node` 预编译，覆盖到 `node_modules/better-sqlite3/build/Release/`。fallback 到 node-gyp 源码编译。

### 4.3 统一打包脚本 ✅

`pnpm electron:pack` 一条命令完成全流程。

### 4.4 国内镜像 ✅

`packConfig` 默认走 npmmirror，env 可覆盖或置空禁用。

### 4.5 Windows tar 路径冲突 ✅

自实现 tar parser（约 30 行），避免 bsdtar 把 `E:` 当 SMB 主机。

---

## 5. 打包后文件系统

```
安装目录/                                          ← 用户可维护（afterPack 钩子打包即就位）
├── cheryClaw.exe
├── .env                                           # API Key 占位符（用户填真实 Key）
├── .chery/                                        # 配置副本
│   ├── config.yaml
│   ├── system.md
│   ├── prompts/
│   ├── skills/
│   └── senses/
└── resources/
    ├── app.asar                # [dist/**, dist-electron/**]
    ├── dist/                   # 后端 bundle
    │   ├── index.js
    │   └── lib/
    │       ├── .pnpm-better-sqlite3-*.node
    │       └── @swc/wasm/
    ├── .env.example            # .env 模板
    ├── .chery.template/        # .chery 模板
    └── node/node.exe           # Node 22 LTS 二进制

<userData>/.chery/db/                                  # DB_DIR（始终在 userData）
└── *.sqlite            # SQLite 数据库
```

**用户配置（`.env` + `.chery/`）位置规则**：

- 统一在 `cheryClaw.exe` 同级，**afterPack 钩子在打包阶段就位**——用户首次安装即看到。
- `CHERY_DIR`：`.env` 留空时默认 `dirname(process.execPath)`；用户可显式设置。
- `DB_DIR`：始终 `app.getPath('userData')/.chery/db/`（避开 Program Files 权限问题）。
- 升级：主进程不主动重写；NSIS 默认会覆盖（暂未实现 NSIS include 跳过）。

详见 [electron.md#electron-spawn-后端模式-2](./electron.md#electron-spawn-后端模式-2)。

## 6. 实现细节记录

- **打包配置单一事实源**：`package.json` 的 `packConfig` 字段 → `scripts/pack-config.mjs` 读取并导出 `resolvePackConfig()` / `applyProxyEnv()`。三个使用点（`electron-pack.mjs`、`pack-electron.mjs`、`dist-electron.mjs`）全部 import，无硬编码。
- **Node 22 LTS 版本锁定**：`packConfig.nodeVersion = "22.11.0"`（ABI=127）。升级时改 `package.json` 一处即可。
- **tar 解压自实现**：Node 内置 `zlib.createGunzip` + 自写 tar parser。避免 Windows `tar` 命令路径冲突。
- **Windows shell 兼容**：`pack-electron.mjs` 的 `run()` 默认 `shell: true`（Windows pnpm 是 .cmd shim）。
