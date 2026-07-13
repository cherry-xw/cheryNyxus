# cheryClaw Electron 桌面应用打包操作手册

> 上级 [docs/web/README.md](./README.md) ｜ 相关 [electron.md](./electron.md)、[deployment.md](./deployment.md)

## 职责

按序执行一组命令，把 cheryClaw 源码打包成可分发的桌面应用安装包。

## 打包配置

所有下载/镜像/代理默认值统一在 [package.json](../../package.json) 的 `packConfig` 字段中维护：

```json
"packConfig": {
  "nodeVersion": "22.11.0",
  "httpProxy": "http://127.0.0.1:7890",
  "electronMirror": "https://npmmirror.com/mirrors/electron/",
  "builderBinariesMirror": "https://npmmirror.com/mirrors/electron-builder-binaries/"
}
```

[scripts/pack-config.mjs](../../scripts/pack-config.mjs) 读取该字段，导出 `resolvePackConfig()` 和 `applyProxyEnv()`，供所有打包脚本 import。**这是配置的唯一事实源**，三处使用点不另写默认值。

**环境变量覆盖**（优先级高于 `packConfig`）：

| packConfig 字段 | 环境变量 | 说明 |
| --- | --- | --- |
| `httpProxy` | `ELECTRON_PACK_PROXY` | HTTP 代理（绕 GitHub 反爬） |
| `electronMirror` | `ELECTRON_MIRROR` | Electron 本体下载镜像 |
| `builderBinariesMirror` | `ELECTRON_BUILDER_BINARIES_MIRROR` | 辅助二进制镜像 |

切换网络环境示例：

```bash
# 默认（读 package.json packConfig）
pnpm electron:pack

# 公司环境
ELECTRON_PACK_PROXY=http://company-proxy:8080 pnpm electron:pack

# 无代理 / 海外环境
ELECTRON_PACK_PROXY= pnpm electron:pack
```

## 环境前置

| 工具 | 最低版本 | 用途 |
| --- | --- | --- |
| Node.js | 20.18+ | 执行脚本、运行 pnpm |
| pnpm | 11.9+ (全局安装) | workspace 依赖管理 |
| Python | 3.x | 仅 `node-gyp` fallback 时需要 |
| Build Tools | latest | 同上，仅 Linux/macOS 需 gcc/clang |

**安装 pnpm**（一次性）：

```bash
npm install -g pnpm@11.9.0
```

## 一、一键打包

### 全量打包（首次 / 依赖变更后）

```bash
pnpm electron:pack
```

等价于以下 6 步顺序执行：

| 步骤 | 命令 | 产物 |
| --- | --- | --- |
| 1. 安装依赖 | `pnpm install` | `node_modules/` |
| 2. 下载 Node 22 LTS + SQLite 预编译 | `electron-pack.mjs sqlite` | `build/node/node.exe` + `better_sqlite3.node` (ABI 127) |
| 3. 后端类型检查 | `pnpm type-check` | 无 |
| 4. 后端 SSR 构建 | `pnpm build` | `dist/index.js` + native addon |
| 5. 前端 + Electron 主进程构建 | `vite build` (跳过 vue-tsc) | `web/dist/` + `web/dist-electron/` |
| 6. 安装包生成 | `electron-builder` | `web/release/*.exe` |

### 增量打包（日常开发）

```bash
pnpm electron:pack:fast
```

跳过步骤 1（依赖安装）和步骤 3（类型检查），直接从步骤 2 开始。

### 强制重新下载（版本升级 / 文件损坏时）

```bash
pnpm electron:pack:force
```

忽略步骤 2 中 Node 二进制和 SQLite 预编译的存在性检查，强制重新下载全部依赖。

### 产物

| 平台 | 安装包 | 路径 |
| --- | --- | --- |
| Windows | NSIS `.exe`（~150 MB） | `web/release/cheryClaw Setup 1.0.0.exe` |
| macOS | DMG | `web/release/cheryClaw-1.0.0.dmg` |
| Linux | AppImage | `web/release/cheryClaw-1.0.0.AppImage` |

## 二、底层子命令

[scripts/electron-pack.mjs](../../scripts/electron-pack.mjs) 提供底层子命令，可单独执行用于调试：

```bash
node scripts/electron-pack.mjs node     # 仅下载 Node 22 LTS 二进制
node scripts/electron-pack.mjs sqlite   # 下载 Node + 拉 SQLite 预编译
node scripts/electron-pack.mjs pack    # 仅构建 + 打包（依赖前置步骤）
```

## 三、打包后目录结构

afterPack 钩子（[web/scripts/post-pack.mjs](../../web/scripts/post-pack.mjs)）在打包阶段就把 `.env` 与 `.chery/` 复制到 `cheryClaw.exe` 同级——**用户首次安装即看到，无需首次启动**。

```
安装目录（cheryClaw.exe 同级）          ← 用户可维护位置
├── cheryClaw.exe
├── .env                                 # API Key 等环境变量（从 .env.example 模板复制，可编辑）
├── .chery\                              # 运行时配置（从 .chery.template/ 复制，可编辑）
│   ├── config.yaml
│   ├── system.md
│   ├── prompts\
│   ├── skills\
│   └── senses\
├── resources\                           # ← 只读，electron-builder 打入
│   ├── app.asar                         # [dist/**, dist-electron/**]
│   ├── dist\                            # 后端 bundle
│   │   ├── index.js
│   │   └── lib\
│   │       ├── .pnpm-better_sqlite3-*.node
│   │       └── @swc\wasm\
│   ├── .env.example                     # .env 模板（afterPack 用作种子）
│   ├── .chery.template\                 # .chery 模板（afterPack 用作种子）
│   │   ├── config.yaml
│   │   ├── system.md
│   │   ├── prompts\
│   │   ├── skills\
│   │   └── senses\
│   └── node\node.exe                    # Node 22 LTS 二进制
└── ...（Electron 框架 dll/asar）

<userData>\.chery\db\                     # DB_DIR（始终在 userData，跨权限位置可写）
└── *.sqlite                              # SQLite 数据库
```

**用户配置（`.env` + `.chery/`）位置规则**：

1. **统一在 `cheryClaw.exe` 同级目录**。打包即就位，无需运行时复制。
2. **`CHERY_DIR`**：`.env` 留空时默认 `cheryClaw.exe` 同级；用户可显式设置（如部署到 NAS/容器）。
3. **`DB_DIR`**：始终在 `app.getPath('userData')/.chery/db/`（避开 Program Files 权限问题），不可改。
4. **升级**：主进程不主动重写用户已修改的 `.env`；NSIS 默认会覆盖目标文件，**如需升级不覆盖需加 `nsis.include` 自定义 .nsh 脚本**（暂未实现）。
5. **UX 入口**：设置面板「打开配置目录」按钮直达系统文件管理器。

**`.env` 用法**：填入 `LONGCAT_API_KEY` 等占位符值。`config.yaml` 中用 `$KEY` 引用这些变量，运行时由 [src/utils/config.ts](../../src/utils/config.ts) 替换（[优先级：OS env > `.env`](../utils/README.md)）。

## 四、增量构建对照表

修改代码后仅需重跑对应步骤（通过 `pnpm electron:pack:fast` 或手动）：

| 改动内容 | 需要重跑 |
| --- | --- |
| `src/**/*.ts`（后端） | 步骤 4 → 6 |
| `web/src/**/*.{vue,ts}`（前端） | 步骤 5 → 6 |
| `web/electron/**` | 步骤 5 → 6 |
| `package.json` 依赖 | 步骤 1 → 4 → 5 → 6 |
| `packConfig.nodeVersion` 变更 | 步骤 2 → 4 → 6 |
| better-sqlite3 升级 | 步骤 2 → 4 → 6 |
| `packConfig` 代理/镜像变更 | 步骤 6（仅需重跑 electron-builder） |

## 五、跨平台构建

electron-builder 仅在当前 host 平台打包对应平台，跨平台需在目标平台主机执行：

| 目标平台 | 在哪台机器执行 | 产物 |
| --- | --- | --- |
| Windows NSIS | Windows 主机 | `web/release/*.exe` |
| macOS DMG | macOS 主机 | `web/release/*.dmg` |
| Linux AppImage | Linux 主机 | `web/release/*.AppImage` |

## 六、常见问题

| 问题 | 排查 |
| --- | --- |
| `pnpm install` 超时 | `pnpm config set https-proxy <proxy>` |
| electron-builder 阶段 `ETIMEDOUT` | 检查 `packConfig.httpProxy` 或设 `ELECTRON_PACK_PROXY` |
| `NODE_MODULE_VERSION` 不匹配 | Node 二进制 / SQLite 预编译过期，重跑 `electron:pack` |
| `Cannot find module 'app-builder-lib/.../load'` | `pnpm update app-builder-lib@25.1.0 --filter web` |
| 跨平台构建失败 | electron-builder 不支持跨平台，需在目标 host 执行 |

## 依赖与关联

- **打包配置**：[package.json](../../package.json) `packConfig` 字段 → [scripts/pack-config.mjs](../../scripts/pack-config.mjs) 读取并导出
- **底层脚本**：[scripts/electron-pack.mjs](../../scripts/electron-pack.mjs)（Node/SQLite 下载 + 构建）
- **一键脚本**：[scripts/pack-electron.mjs](../../scripts/pack-electron.mjs)（串联完整流程）
- **Electron 打包入口**：[web/scripts/dist-electron.mjs](../../web/scripts/dist-electron.mjs)（electron-builder 薄包装，注入镜像 env）
- **构建配置**：[web/electron-builder.yml](../../web/electron-builder.yml)、[vite.config.ts](../../vite.config.ts)、[pnpm-workspace.yaml](../../pnpm-workspace.yaml)
- **运行时**：[web/electron/main.ts](../../web/electron/main.ts)、[web/electron/preload.ts](../../web/electron/preload.ts)
- **详细设计**：[electron.md](./electron.md)（Electron 集成）、[deployment.md](./deployment.md)（部署模式 + native ABI）

## 扩展点

- **新增构建平台**（如 linux-arm64）：编辑 [scripts/pack-config.mjs](../../scripts/pack-config.mjs) `PLATFORM_ASSET` + [web/electron-builder.yml](../../web/electron-builder.yml) `linux.target`
- **新增 Node 版本**：修改 [package.json](../../package.json) `packConfig.nodeVersion`
- **CI 集成**：在 workflow 中调用 `pnpm electron:pack`，通过环境变量注入代理/镜像配置
