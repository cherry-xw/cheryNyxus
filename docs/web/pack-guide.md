# cheryClaw Electron 桌面应用打包操作手册

> 上级 [docs/web/README.md](./README.md) ｜ 相关 [electron.md](./electron.md)、[deployment.md](./deployment.md)、[electron-pack-progress.md](./electron-pack-progress.md)、[../CLAUDE.md](../../CLAUDE.md)

## 职责

按序执行一组命令，把 cheryClaw 源码打包成可分发的桌面应用安装包。每条命令标注**作用**和**产物**。

## 环境前置

| 工具 | 最低版本 | 用途 |
|------|---------|------|
| Node.js | 20.18+ (本项目用 22.23 验证) | 执行脚本、运行 pnpm |
| pnpm | 11.9+ (全局安装) | workspace 依赖管理 |
| Python | 3.x | 仅 `node-gyp` fallback 时需要 |
| Visual Studio Build Tools / Xcode | latest | 同上，仅 Linux/macOS 需 gcc/clang |
| curl | any | 脚本下载 Node 22 二进制与 better-sqlite3 prebuilt |

**大陆网络环境**：electron-builder 阶段会下载两类二进制，均依赖国内可达的镜像：
- **辅助工具**（winCodeSign / Squirrel.Windows / 7z-extract）：源 `https://github.com/electron-userland/electron-builder-binaries`，DNS 落到 `20.205.243.166`，经常 ETIMEDOUT。
- **Electron 本体**（如 `electron-v43.0.0-win32-x64.zip`）：源 `https://github.com/electron/electron/releases`，同样 DNS 不可达。

`scripts/electron-pack.mjs` 与 `web/scripts/dist-electron.mjs` 默认填以下两个 env：
- `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
- `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（末尾必须带斜杠；被 `@electron/get` 拼接）

env 同名覆盖；置空字符串禁用。

**安装 pnpm**（一次性；要求版本 ≥ 11.9.0）：

```bash
npm install -g pnpm@11.9.0
pnpm --version
```

## 一、首次构建（从零到 nsis 安装包）

按序执行下文命令。**前一步失败请勿跳到下一步**，先排查。

### 1. 安装依赖

```bash
pnpm install
```

**作用**：解析 `pnpm-lock.yaml`，下载并链接 `root` + `web` 两个 workspace 包的全部依赖（含 native modules）。`pnpm-workspace.yaml` 的 `allowBuilds` 控制哪些包允许编译。

**产物**：
- `node_modules/`（符号链接到 `.pnpm/` 虚拟存储）
- `node_modules/.pnpm/`（实际解压的包）

**首次安装较慢**（约 1-2 分钟）。网络不稳可加 `--prefer-offline`（用缓存）。registry 限速可配置代理：

```bash
pnpm config set https-proxy http://127.0.0.1:1234
```

### 2. 修复 electron-builder 与 app-builder-lib 版本冲突（pre-existing 上游 bug）

```bash
pnpm update app-builder-lib@25.1.0 --filter web
```

**作用**：electron-builder 25.1.0 内部引用 `app-builder-lib/out/util/config/load` 模块，但 `package.json` 写 `^25.0.0`，lockfile 锁了 25.0.0（缺该文件），导致 CLI 启动失败。强制升级到 25.1.0 修复。

**产物**：`pnpm-lock.yaml` 更新 + `node_modules/.pnpm/app-builder-lib@25.1.0*/`

### 3. 下载 Node 22 LTS 二进制（发行版后端运行时）

```bash
node scripts/electron-pack.mjs node
```

**作用**：从 `https://nodejs.org/dist/v22.11.0/` 下载 host 平台对应的 Node 22 LTS 二进制，解压到 `build/node/node[.exe]`。版本号硬编码在 [scripts/electron-pack.mjs](../../scripts/electron-pack.mjs) 顶部 `NODE_VERSION = "22.11.0"`。

**产物**：
- `build/node/node[.exe]`（约 35-80 MB，已加 `.gitignore`）

**已存在则跳过**（>1MB 视为有效）。可重复执行，`build/` 下产物可缓存用于多次构建。

### 4. 拉 Node 22 ABI 的 better-sqlite3 预编译

```bash
node scripts/electron-pack.mjs sqlite
```

**作用**：调用下载的 Node 22（`build/node/node.exe`）取 `process.versions.modules` (= 127)，从 GitHub release 直下 `better-sqlite3-v<ver>-node-v127-<plat>-<arch>.tar.gz`，流式解压到 `node_modules/better-sqlite3/build/Release/better_sqlite3.node`。版本号读 `node_modules/better-sqlite3/package.json`，无需硬编码。

**产物**：
- `node_modules/better-sqlite3/build/Release/better_sqlite3.node`（约 1.9 MB）

**前提**：步骤 3 必须已执行（脚本会自动调 node 子命令）。

### 5. 类型检查（root + web）

```bash
pnpm type-check:all
```

**作用**：`tsc --noEmit` 检查 root TypeScript；`vue-tsc -b` 检查 web TypeScript（含 .vue 单文件组件）。

**产物**：无产物（pure type-check）。失败时**不要**继续构建，先修类型错误。

> ⚠ `web/src/features/pets/PetBubbles.vue`、`PetSprite.vue`、`web/src/services/ws.ts` 等文件预存 type-check 错误（与本任务无关）。本地开发可只跑 root type-check：

```bash
pnpm type-check  # 仅 root，跳过 vue-tsc
```

### 6. 构建后端 SSR bundle

```bash
pnpm build
```

**作用**：vite SSR 模式打包 `src/index.ts` → `dist/index.js`，复制 native addon（`better_sqlite3.node`）到 `dist/lib/`，复制 `@swc/wasm` 到 `dist/lib/@swc/wasm/`，并打补丁修正 `.node` 加载路径与 addon 导出结构。详见 [vite.config.ts](../../vite.config.ts) `postBuildFix`。

**产物**：
- `dist/index.js`（约 1.84 MB）
- `dist/lib/.pnpm-better_sqlite3-*.node`（约 1.92 MB，文件名含 pnpm hash）
- `dist/lib/@swc/wasm/`（wasm 运行时）

### 7. 构建前端 + Electron 主进程/preload

```bash
pnpm --filter web build
```

**作用**：
- `vue-tsc -b`：类型检查（步骤 5 已做，此处作为 build 内置屏障）
- `vite build`：构建 Vue3 SPA + 渲染资源
- `vite-plugin-electron/simple`：编译 `web/electron/main.ts`（主进程）和 `web/electron/preload.ts`（preload）

**产物**：
- `web/dist/`（index.html + assets）
- `web/dist-electron/main.js`（约 2.58 kB）
- `web/dist-electron/preload.mjs`（约 0.23 kB）

> ⚠ vue-tsc 阶段会因 PetBubbles/PetSprite/ws.ts 等预存错误失败。跳过 type-check 仅跑 vite：

```bash
cd web && pnpm exec vite build
```

### 8. 触发 electron-builder 打包安装包

```bash
pnpm --filter web dist
```

**作用**：读 [web/electron-builder.yml](../../web/electron-builder.yml)，按 `targets` 字段打包当前 host 平台安装包：
- win32 → NSIS `.exe` 安装器（~150 MB）
- macOS → DMG（仅 macOS host 可打）
- Linux → AppImage（仅 Linux host 可打）

**产物**：
- `web/release/cheryClaw Setup 1.0.0.exe`（Windows NSIS）
- `web/release/cheryClaw-1.0.0.dmg`（macOS）
- `web/release/cheryClaw-1.0.0.AppImage`（Linux）

**前提**：步骤 1-7 全部通过；`app-builder-bin` 必须可用（步骤 2 修复后一般 OK）。

## 二、增量构建（日常开发）

修改代码后仅需重跑对应步骤：

| 改动内容 | 重跑步骤 |
|---------|---------|
| `src/**/*.ts`（后端） | 6 → 8 |
| `web/src/**/*.{vue,ts,js}`（前端） | 7 → 8 |
| `web/electron/**` | 7 → 8 |
| `package.json` 依赖 | 1 → 6 → 7 → 8 |
| Node 版本升级（脚本内 `NODE_VERSION` 改） | 3 → 4 → 6 → 8 |
| better-sqlite3 升级（package.json 改） | 1 → 4 → 6 → 8 |
| electron-builder / app-builder-lib 版本 | 2 → 1 → 6 → 7 → 8 |

## 三、一键全量（开发期常用）

```bash
pnpm build:all    # type-check:all + build + web build（不含 electron-builder dist）
pnpm pack:electron  # node + sqlite + build:all + electron-builder dist（全流程）
```

`pack:electron` 是 [scripts/electron-pack.mjs](../../scripts/electron-pack.mjs) 的默认子命令，等价于：

```
scripts/electron-pack.mjs all
  = node   （步骤 3）
  + sqlite（步骤 4，隐含 node）
  + pack  （步骤 6 + 7 + 8）
```

子命令可拆分使用：

| 子命令 | 等价步骤 |
|--------|---------|
| `node scripts/electron-pack.mjs node` | 3 |
| `node scripts/electron-pack.mjs sqlite` | 3 + 4 |
| `node scripts/electron-pack.mjs pack` | 6 + 7 + 8（依赖 1-5） |
| `node scripts/electron-pack.mjs all` | 3 + 4 + 6 + 7 + 8 |

## 四、跨平台构建

electron-builder 仅在当前 host 平台打包对应平台。**跨平台构建需在目标平台主机上执行**：

| 目标平台 | 在哪台机器执行 | 产物 |
|---------|---------------|------|
| Windows NSIS | Windows 主机 | `web/release/*.exe` |
| macOS DMG | macOS 主机 | `web/release/*.dmg` |
| Linux AppImage | Linux 主机 | `web/release/*.AppImage` |

Node 22 二进制（步骤 3）自动按 host 平台下载对应版本。CI 中通常用 GitHub Actions 的 `windows-latest` / `macos-latest` / `ubuntu-latest` runner 各跑一次。

## 五、产物布局（打包后安装目录）

```
cheryClaw Setup 1.0.0.exe 安装后:
C:\Users\<user>\AppData\Local\Programs\cheryClaw\
├── cheryClaw.exe                    # Electron 主程序
├── resources\
│   ├── app.asar                     # [dist/**, dist-electron/**]
│   ├── dist\                        # 后端 bundle（来自 ../dist）
│   │   ├── index.js
│   │   └── lib\
│   │       ├── .pnpm-better_sqlite3-*.node
│   │       └── @swc\wasm\
│   ├── .chery\                      # 运行时配置（只读 seed）
│   │   ├── config.yaml
│   │   ├── system.md
│   │   ├── prompts\
│   │   ├── skills\
│   │   └── senses\
│   └── node\node.exe                # Node 22 LTS 二进制
└── ...（Electron 框架 dll/asar）

C:\Users\<user>\AppData\Roaming\cheryClaw\runtime\  # 首次启动创建（可写）
└── .chery\
    ├── config.yaml                  # seed 自 resources/.chery/
    └── db\                          # SQLite 数据库
```

## 六、常见问题

| 问题 | 排查 |
|------|------|
| `pnpm install` 超时（registry.npmjs.org 限速） | `pnpm config set https-proxy http://127.0.0.1:1234` |
| `pnpm --filter web dist` 超时 `20.205.243.166:443 ETIMEDOUT` 或 `Timeout awaiting 'request' for 600000ms` | electron-builder 阶段两类下载都走 GitHub，国内不可达：`web/scripts/dist-electron.mjs` 默认注入 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`（辅助工具）与 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（Electron 本体）；`pnpm pack:electron` 走 `scripts/electron-pack.mjs` 同样注入。直接调 `electron-builder` 时需自行 export 同名 env。 |
| `Cannot find module 'app-builder-lib/out/util/config/load'` | 步骤 2：升级 app-builder-lib 到 25.1.0 |
| `prebuild-install` syntax error | 已绕过：脚本用 GitHub release URL 直下，不调 bash wrapper |
| `tar: Cannot connect to E: resolve failed` | 已绕过：脚本用 Node 内置 zlib + 自实现 tar parser，不用系统 tar |
| `git fetch failed` / `ECONNRESET` | GitHub 偶发；脚本默认走 `http://127.0.0.1:1234` 代理，可改 `ELECTRON_PACK_PROXY` env |
| 跨平台构建失败 | electron-builder 不支持跨平台编译；必须在目标 host 上跑 |
| 安装后启动报 `NODE_MODULE_VERSION` 不匹配 | 步骤 4 未跑或 better-sqlite3 被覆盖重装；重跑 `pack:electron:sqlite` |

## 依赖与关联

- **构建脚本**：[scripts/electron-pack.mjs](../../scripts/electron-pack.mjs)（Node.js ESM，自实现 tar parser）
- **配置**：[web/electron-builder.yml](../../web/electron-builder.yml)、[vite.config.ts](../../vite.config.ts)、[pnpm-workspace.yaml](../../pnpm-workspace.yaml)
- **运行时**：[web/electron/main.ts](../../web/electron/main.ts)（spawn Node 跑后端 bundle）、[web/electron/preload.ts](../../web/electron/preload.ts)
- **历史**：完整进度跟踪 [electron-pack-progress.md](./electron-pack-progress.md)；早期设计 [electron.md](./electron.md)、[deployment.md](./deployment.md)

## 扩展点

- **新增构建平台**（如 linux-arm64）：编辑 [scripts/electron-pack.mjs](../../scripts/electron-pack.mjs) `PLATFORM_ASSET` 表 + [web/electron-builder.yml](../../web/electron-builder.yml) `linux.target`。
- **新增 Node 版本**：编辑 [scripts/electron-pack.mjs](../../scripts/electron-pack.mjs) `NODE_VERSION` 常量；同时更新 [docs/web/deployment.md](./deployment.md) 中 ABI 版本号说明。
- **CI 集成**：把本手册「一、首次构建」步骤 1-8 复制到 `.github/workflows/release.yml` 的 job 内。