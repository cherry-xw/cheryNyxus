# cheryClaw Electron 桌面应用打包 — 进度总结

> 日期：2026-07-12 | 分支：sp | 状态：**实现中（脚本编写）**

---

## 1. 需求概述

将 cheryClaw 前后端打包为 Electron 桌面应用安装包，支持 Windows (nsis)、macOS (dmg)、Linux (AppImage)，内嵌 Node 22 LTS 二进制。

---

## 2. 项目结构速览

```
cheryClaw/
├── src/                    # 后端源码（Node.js + better-sqlite3）
├── dist/                   # 后端 SSR 构建产物（vite build --ssr）
│   ├── index.js            # 后端入口 bundle
│   └── lib/
│       ├── better-sqlite3-better_sqlite3-*.node  # native addon
│       └── @swc/wasm/      # wasm 运行时
├── web/
│   ├── src/                # 前端源码（Vue3 + Element Plus）
│   ├── electron/
│   │   ├── main.ts         # Electron 主进程
│   │   └── preload.ts      # preload 桥接
│   ├── dist/                # 前端渲染产物（vite build）
│   ├── dist-electron/       # Electron 主进程/preload 产物
│   ├── vite.config.ts      # 前端构建配置
│   └── electron-builder.yml # electron-builder 打包配置
├── .chery/                 # 运行时配置（config.yaml, prompts, skills, senses）
├── vite.config.ts          # 后端 SSR 构建配置
├── package.json            # 后端根包
└── pnpm-workspace.yaml     # pnpm workspace + allowBuilds
```

---

## 3. 当前已就绪部分 ✅

### 3.1 后端构建

| 项目 | 状态 | 说明 |
|------|------|------|
| SSR build | ✅ | `vite build --ssr` → `dist/index.js` |
| native addon 处理 | ✅ | `vite-plugin-native-modules` + `postBuildFix` 插件 |
| .node 文件重定位 | ✅ | `dist/` → `dist/lib/`（带 EBUSY 重试） |
| require 路径修正 | ✅ | `"./X.node"` → `"./lib/X.node"` |
| addon 导出结构修正 | ✅ | `__toCommonJS(exports)` → `nativeModule` |
| @swc/wasm 复制 | ✅ | → `dist/lib/@swc/wasm/` |
| .env 清理 | ✅ | 防历史构建泄露密钥 |

**构建命令**：`pnpm build`（dev）/ `pnpm build:prod`（prod）

### 3.2 前端构建

| 项目 | 状态 | 说明 |
|------|------|------|
| Vue3 构建 | ✅ | `vue-tsc -b && vite build` → `web/dist/` |
| Electron 主进程编译 | ✅ | `vite-plugin-electron/simple` → `web/dist-electron/main.js` |
| preload 编译 | ✅ | → `web/dist-electron/preload.mjs` |
| base: './' | ✅ | 兼容 Electron loadFile |
| 开发 proxy | ✅ | `/api` → :8183, `/ws` → :8182 |

**构建命令**：`pnpm --filter web build`

### 3.3 Electron 主进程逻辑

| 项目 | 状态 | 说明 |
|------|------|------|
| `getNodeExecutable()` | ✅ | 优先 `resources/node[.exe]`，fallback 系统 `node` |
| `getBackendBundle()` | ✅ | `app.getAppPath()/../dist/index.js` |
| `startBackend()` | ✅ | `spawn(node, [bundle])`，设 CHERY_DIR，删 ELECTRON_RUN_AS_NODE |
| `getWritableCheryRoot()` | ✅ | 打包时 seed `.chery` 到 `userData/runtime/` |
| `waitForBackend()` | ✅ | 轮询 `/api/config`，30s 超时 |
| `createWindow()` | ✅ | dev → loadURL，packaged → loadFile |
| preload 注入 | ✅ | `__BACKEND_CONFIG__` + `__BACKEND_HTTP_URL__` |
| 单实例锁 | ✅ | `requestSingleInstanceLock()` |
| 进程清理 | ✅ | `before-quit` → SIGTERM |

### 3.4 electron-builder.yml 配置

```yaml
files: [dist/**, dist-electron/**]           # asar 内容
extraResources:
  - from: ../dist    → dist                  # 后端 bundle
  - from: ../.chery  → .chery                # 运行时配置（排除 db/）
targets: win=nsis, mac=dmg, linux=AppImage
```

### 3.5 统一构建脚本

| 命令 | 作用 |
|------|------|
| `build:all` | type-check 双端 → 后端 build → 前端 build |
| `dev:all` | concurrently 运行后端 + 前端 dev |

---

## 4. 待解决问题 ❌

### 4.1 Node 二进制未打包（核心缺口）

`getNodeExecutable()` 期望 `resources/node[.exe]`，但 `electron-builder.yml` 的 `extraResources` **未包含 Node 二进制**。

**当前行为**：打包后 fallback 到系统 PATH 的 `node`。用户机器无 Node 则无法启动后端。

**需解决**：下载 Node 22 LTS 二进制到构建产物，打入 extraResources。

Node 22 LTS 各平台二进制来源（nodejs.org）：
- **win32-x64**: `node-v22.x.x-win-x64.zip` → `node.exe`
- **darwin-x64**: `node-v22.x.x-darwin-x64.tar.gz` → `bin/node`
- **darwin-arm64**: `node-v22.x.x-darwin-arm64.tar.gz` → `bin/node`
- **linux-x64**: `node-v22.x.x-linux-x64.tar.xz` → `bin/node`

### 4.2 better-sqlite3 ABI 不匹配

当前 `.node` 针对构建机器的系统 Node ABI 编译。如果打包的 Node 22 与构建机器 Node 版本不同，会导致 `NODE_MODULE_VERSION` mismatch 崩溃。

**编译链分析**：
```
pnpm install
  → allowBuilds.better-sqlite3: true
  → prebuild-install || node-gyp rebuild --release
  → node_modules/better-sqlite3/build/Release/better_sqlite3.node
    → (针对当前系统 Node ABI)

pnpm build
  → vite-plugin-native-modules 复制 .node 到 dist/
  → postBuildFix 移到 dist/lib/ + 修正路径 + 修正导出

打包
  → extraResources 把 dist/ 打入 resources/dist/
  → 但 .node ABI 可能与打包的 Node 22 不匹配!
```

**需解决**：打包时用目标 Node 22 二进制重新编译 better-sqlite3。

### 4.3 统一打包脚本缺失

没有一条命令完成：编译后端 → 编译前端 → 编译 better-sqlite3(Node22 ABI) → electron-builder 打包。

### 4.4 pnpm-workspace.yaml 占位符

```yaml
'@parcel/watcher': set this to true or false  # ← TODO 占位符
```

### 4.5 开发环境遗留问题

- `@ff-labs/fff-node` / `ffi-rs` 在 `node_modules` 中未安装（仅存在于 lockfile）
- 当前构建环境可能存在不一致

---

## 5. 关键路径映射（打包后文件系统）

```
安装目录/
├── resources/
│   ├── app.asar                    # [dist/**, dist-electron/**]
│   ├── dist/                       # 后端 bundle（来自 ../dist）
│   │   ├── index.js
│   │   └── lib/
│   │       ├── better-sqlite3-*.node
│   │       └── @swc/wasm/
│   ├── .chery/                     # 运行时配置（只读 seed）
│   │   ├── config.yaml
│   │   ├── system.md
│   │   ├── prompts/
│   │   ├── skills/
│   │   └── senses/
│   └── node[.exe]                  # ❌ 待添加：Node 22 二进制
└── <userData>/runtime/              # 首次启动创建（可写）
    └── .chery/
        ├── config.yaml              # seed 自 resources/.chery/
        └── db/                     # 数据库文件
```

**路径解析链**：
- `app.getAppPath()` = `resources/app/`（或 `resources/app.asar`）
- `getNodeExecutable()` → `resources/node[.exe]`（待添加）
- `getBackendBundle()` → `resources/dist/index.js` ✅
- `getWritableCheryRoot()` → `<userData>/runtime/` ✅

---

## 6. 方案方向（待确认）

### 6.1 Node 二进制打包

**推荐方案**：构建脚本中从 nodejs.org 下载 Node 22 LTS 二进制到 `build/node/`，然后 electron-builder 的 `extraResources` 打包。

优点：
- 版本可控、可锁定
- 跨平台统一处理
- 不增加 npm 依赖

缺点：
- 首次构建需下载（~30-50MB）
- 需处理网络异常

### 6.2 better-sqlite3 ABI 匹配

**推荐方案**：在打包脚本中，用下载的 Node 22 二进制执行 better-sqlite3 的 node-gyp rebuild。

```bash
# 用打包的 node 编译 better-sqlite3
./build/node/node.exe node_modules/.bin/node-gyp rebuild \
  --target=v22.x.x \
  --directory=node_modules/better-sqlite3
```

或者使用 better-sqlite3 的 prebuild-install 指定目标：
```bash
npx prebuild-install --runtime=node --target=22.x.x -r native
```

### 6.3 统一打包脚本

新增 `scripts/electron-pack.sh`（bash，跨平台）或 Node.js 脚本：

```
1. 下载 Node 22 LTS 二进制 → build/node/
2. pnpm build:all          → 后端 dist/ + 前端 web/dist/
3. 用 Node 22 重新编译 better-sqlite3 → dist/lib/*.node 更新
4. pnpm --filter web dist   → electron-builder 打包
```

---

## 7. 需要修改的文件清单

| 文件 | 修改类型 | 修改内容 |
|------|---------|---------|
| `electron-builder.yml` | 修改 | 添加 Node 二进制到 extraResources |
| `package.json` | 修改 | 新增打包相关 scripts |
| `web/package.json` | 可能修改 | 打包脚本调整 |
| `scripts/electron-pack.mjs` | **新增** | 统一打包脚本（下载 Node + 编译 + 打包） |
| `docs/web/deployment.md` | 修改 | 更新 Electron 模式文档 |
| `docs/web/electron.md` | 修改 | 更新 native ABI 解决方案 |
| `pnpm-workspace.yaml` | 修改 | 修复 `@parcel/watcher` 占位符 |

---

## 8. 下一步

1. ✅ **确认方案方向**（6.1-6.3）
   - 脚本语言：**Node.js ESM (.mjs)**
   - Node 版本：**脚本内硬编码常量 Node 22 LTS（22.11.0）**
   - better-sqlite3 ABI：**GitHub release URL 直下 + 自实现 tar parser（避免 Windows tar 路径冲突）**
2. ✅ **先更新文档**（Doc-First）— [docs/web/electron.md](./electron.md)、[docs/web/deployment.md](./deployment.md) 已同步
3. ✅ **实现构建脚本** (`scripts/electron-pack.mjs`)
4. ✅ **修改 electron-builder.yml**（含 `from: ../build/node` extraResources）+ `web/electron/main.ts` 路径调整
5. ✅ **修改 package.json scripts**（`pack:electron` / `pack:electron:node` / `pack:electron:sqlite` / `pack:electron:only`）
6. ⚠ **Windows 验证**：
   - ✅ `node scripts/electron-pack.mjs node`（v22.11.0 / ABI 127）
   - ✅ `node scripts/electron-pack.mjs sqlite`（下载 0.99 MB Node 22 ABI 预编译 + 解压到 `node_modules/better-sqlite3/build/Release/`）
   - ✅ `pnpm build`（后端 SSR：`dist/lib/.pnpm-better_sqlite3-*.node` 1.92 MB，路径正确）
   - ✅ `vite build`（前端 + `dist-electron/main.js` 2.58 kB + `dist-electron/preload.mjs` 0.23 kB）
   - ⚠ `electron-builder --win nsis` 失败：electron-builder@25.1.0 引用 `app-builder-lib/out/util/config/load` 但 lockfile 锁了 app-builder-lib@25.0.0（缺少该模块）。**上游 bug**，与本任务脚本无关。修复方式：在 web/package.json 加 `"pnpm": { "overrides": { "app-builder-lib": "25.1.0" } }`（或 downgrad electron-builder 到 25.0.0）。

## 9. 实现细节记录（脚本调优）

- **HTTP 代理**：`scripts/electron-pack.mjs` 默认走 `http://127.0.0.1:1234`（绕过 GitHub release-assets 反爬），可经 `ELECTRON_PACK_PROXY` env 覆盖。Node fetch 通过 `HTTPS_PROXY` env 自动走代理；curl 显式 `-x $HTTP_PROXY`；PowerShell Expand-Archive 用 `[System.Net.WebProxy]::new(...)`。
- **tar 解压自实现**：better-sqlite3 的 prebuilt tarball 直接用 Node 内置 `zlib.createGunzip` + 自写 tar parser（约 30 行）。**避免** Windows 下 `tar` 命令的 `E:\` 路径解析冲突（bsdtar 把 `E:` 当 SMB 主机）。
- **prebuild-install 路径**：不直接调 `node_modules/.bin/prebuild-install`（是 bash wrapper，被 Node 当 JS 解析会 syntax error），改用 GitHub release 直下。
- **国内镜像配置（2026-07-13 补）**：electron-builder 阶段两类下载都走 GitHub，DNS 落到 `20.205.243.166`，ETIMEDOUT。
  - **辅助工具**（winCodeSign / Squirrel.Windows / 7z-extract）：源 `https://github.com/electron-userland/electron-builder-binaries` → `@electron/get` 读 `ELECTRON_BUILDER_BINARIES_MIRROR` 切到 `https://npmmirror.com/mirrors/electron-builder-binaries/`（npmmirror 完整镜像）。
  - **Electron 本体**（如 `electron-v43.0.0-win32-x64.zip`）：源 `https://github.com/electron/electron/releases` → `@electron/get` 读 `ELECTRON_MIRROR` 切到 `https://npmmirror.com/mirrors/electron/`（末尾斜杠不能少，否则 404）。
  - `scripts/electron-pack.mjs` 默认填两个 env；直跑 `pnpm --filter web dist` 时由 `web/scripts/dist-electron.mjs` 注入同样默认值。env 可覆盖，置空字符串禁用回退到 GitHub 源。
