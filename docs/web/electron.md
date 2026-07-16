# Electron 集成详解

> 源码 [web/electron/](../../web/electron/) ｜ 上级 [README.md](./README.md) ｜ 相关 [deployment.md](./deployment.md)、[web/vite.config.ts](../../web/vite.config.ts)、[web/scripts/electron-dev.sh](../../web/scripts/electron-dev.sh)、[./env.md](./env.md)（环境抽象层）

## 职责

记录 `web/` 接入 Electron 43(桌面 shell)的集成方式与运行环境坑。web/ 通过 `vite-plugin-electron` 把 Electron 主进程编译与 Vite 渲染构建串联,开发期 HMR、生产期 `loadFile` 加载 `dist/`。**模式 2(Electron 一体)下,main 进程 spawn 后端子进程**,preload 注入端口配置。本文档是 [README.md](./README.md) 的 Electron 专题展开,部署模式见 [deployment.md](./deployment.md)。

## 集成方式

[vite.config.ts](../../web/vite.config.ts) 经 `vite-plugin-electron/simple` 挂载:

```ts
electron({
  main: { entry: 'electron/main.ts' },
  preload: { input: 'electron/preload.ts' },  // IPC 注入后端配置
  renderer: {},
})
```

- **主进程 ESM**:`web/package.json` `"type":"module"` → 产出 `dist-electron/main.js`,Electron ≥28 原生支持 ESM。
- **路径解析**:用 `import.meta.url` / `import.meta.dirname`,无 esmShim。
- **preload**:[electron/preload.ts](../../web/electron/preload.ts) 经 `contextBridge.exposeInMainWorld` 注入 `window.__BACKEND_CONFIG__`。
- **`base:'./'`**:生产 `loadFile` 相对路径必需。
- **vue-router `createWebHashHistory`**:Electron `file://` 必需。

依赖版本:Vite 8 + `@vitejs/plugin-vue` 6 + `vite-plugin-electron` 1.1 + `electron` 43。`pnpm-workspace.yaml` `allowBuilds` 含 `electron:true`。[turbo.json](../../turbo.json) build outputs 含 `dist-electron/**`。[web/package.json](../../web/package.json) `"main":"dist-electron/main.js"` + `"electron":"electron ."`。

## 主进程路径解析

[electron/main.ts](../../web/electron/main.ts) 加载渲染入口:

```ts
if (process.env.VITE_DEV_SERVER_URL) {
  void win.loadURL(process.env.VITE_DEV_SERVER_URL)   // vite serve 时插件注入
} else {
  void win.loadFile(join(import.meta.dirname, '..', 'dist', 'index.html'))  // 生产
}
```

**关键坑**:不能用 `fileURLToPath(new URL('../dist/index.html', import.meta.url))`——vite-plugin-electron build 时 vite 静态分析 `new URL(literal, import.meta.url)`,把 `index.html` 内联成 data URL → `ERR_INVALID_URL_SCHEME`。改用 `join(import.meta.dirname, '..', 'dist', 'index.html')`(运行时构造,绕开静态分析)。`import.meta.dirname` Node 20.11+ / Electron 43 支持,rollup 保留不转换。

## Electron spawn 后端(模式 2)

[electron/main.ts](../../web/electron/main.ts) `startBackend()` 用**系统 node** spawn 后端 bundle(`node + index.js`):

```ts
loadEnvFile();                              // 1. 加载 .env → process.env（不覆盖 OS env，空值不灌）
const cheryDir = getRuntimeRoot();          // 2. CHERY_DIR 父目录（默认 cheryClaw.exe 同级）
spawn(getNodeExecutable(), [getBackendBundle()], {
  env: { ...process.env, CHERY_DIR, ...(app.isPackaged ? { DB_DIR } : {}) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
// delete env.ELECTRON_RUN_AS_NODE  // 防 shell 注入污染
```

- **`getNodeExecutable()`**:优先打包的 node(extraResources 内 `../node`),否则系统 PATH `node`。用系统 node 跑后端,better-sqlite3 用系统 Node ABI,与后端 build 一致,**无跨 ABI 问题**(弃用 `ELECTRON_RUN_AS_NODE`,因 Electron 内嵌 node ABI ≠ 系统 node ABI)。
- **后端 bundle 路径**:`join(app.getAppPath(), '..', 'dist', 'index.js')`。开发期 `<root>/dist/index.js`;打包后 `resources/dist/index.js`。
- **`.env` 加载(`loadEnvFile()`)**:
  - **打包即就位**:[scripts/post-pack.mjs](../../web/scripts/post-pack.mjs) 在打包阶段已经把 `.env` 复制到 `cheryClaw.exe` 同级(从 `resources/.env.example` 模板),无需启动时复制。
  - 运行时只读取 `dirname(process.execPath)/.env`;不存在则静默跳过。
  - 解析 `KEY=VALUE` / `KEY="VALUE"`,跳过 `#` 注释;
  - **空值不灌**(`CHERY_DIR=` → 不写入 process.env,让默认推断生效);
  - **不覆盖已有**(`process.env` 已设的优先于 `.env`,OS env 优先级最高)。
- **`.chery` 用户位置(`getRuntimeRoot()`)**:
  - **打包即就位**:`.chery/` 也由 afterPack 钩子复制到 `cheryClaw.exe` 同级。
  - `CHERY_DIR = process.env.CHERY_DIR || dirname(process.execPath)`——`.env` 中 `CHERY_DIR` 留空时默认 `cheryClaw.exe` 同级,用户可显式覆盖。
  - 开发期:`CHERY_DIR = process.env.CHERY_DIR || <项目根>`。
- **`CHERY_DIR`**:打包后默认 `dirname(process.execPath)/`(exe 同级,`.chery/` 在这下面)。
- **`DB_DIR`**:仅打包时注入 `app.getPath('userData')/.chery/db`(始终可写,跨 Program Files 权限问题);开发期沿用 `CHERY_DIR/.chery/db`。
- **`waitForBackend()`**:轮询 `http://localhost:<WEB_PORT>/api/config`(超时 30s),就绪后 `createWindow()`。
- **退出**:`before-quit` → `backend.kill('SIGTERM')`;单实例锁 `requestSingleInstanceLock()`。
- **UX 入口**:设置面板调用后端 `utils.openConfigDir` WebSocket RPC，由后端进程通过系统默认打开器打开 `CHERY_DIR/.chery`；不再维护专用 Electron IPC。

> ⚠ 发行版已解决:[scripts/electron-pack.mjs](../../scripts/electron-pack.mjs) 下载 Node 22 LTS 二进制到 `extraResources`,并用其 ABI 重生 better-sqlite3 预编译(详见 [native addon ABI](#native-addon-abi模式-2))。

## preload 注入配置

[electron/preload.ts](../../web/electron/preload.ts):

```ts
const config = ipcRenderer.sendSync('get-backend-config') as BackendConfig | null;
if (config) {
  contextBridge.exposeInMainWorld('__BACKEND_CONFIG__', config);
  // P5c：同步注入 HTTP base URL（http://localhost:<webPort>），前端 fetch /api/* 用
  contextBridge.exposeInMainWorld('__BACKEND_HTTP_URL__', `http://localhost:${config.webPort}`);
}
```

- main `ipcMain.on('get-backend-config')` 返回 `serverConfig`(由 `waitForBackend` 从 `/api/config` 取得,或 fallback 常量)。
- `sendSync` 同步:preload 加载时同步取配置,渲染进程加载时 `window.__BACKEND_CONFIG__` / `window.__BACKEND_HTTP_URL__` 已就绪,无竞态。
- 渲染进程**不直接读**两个 `window.__*` 全局——全部经 [web/src/services/platform.ts](../../web/src/services/platform.ts) 抽象层消费:
  - `__BACKEND_CONFIG__` → `getServerConfig()` / `wsUrl()` / `isElectron`
  - `__BACKEND_HTTP_URL__` → `httpUrl()`
  详见 [./env.md](./env.md)。设置面板的配置目录入口属于后端 RPC，不经过 preload IPC。原 [ws.ts](../../web/src/services/ws.ts) `connect()` 优先读 `window.__BACKEND_CONFIG__`,无需 `fetch('/api/config')`(`file://` 下无法 fetch 相对地址);[http.ts](../../web/src/services/http.ts) `httpUrl(path)` 读 `__BACKEND_HTTP_URL__` 拼完整 HTTP 端点(`/api/auth/me`、`/api/media/upload` 等)。

## electron-builder 打包

[electron-builder.yml](../../web/electron-builder.yml):

```yaml
files: [dist/**, dist-electron/**]              # 渲染 + 主进程
extraResources:
  - { from: ../dist, to: dist }                 # 后端 bundle
  - { from: ../.env.example, to: .env.example } # .env 模板（afterPack 复制为 cheryClaw.exe/.env）
  - { from: ../.chery.template, to: .chery.template }  # .chery 模板（afterPack 复制为 cheryClaw.exe/.chery/）
  - { from: ../build/node, to: node }           # Node 22 LTS 二进制
afterPack: ./scripts/post-pack.mjs              # 把模板复制到 cheryClaw.exe 同级（无需首次启动）
npmRebuild: true                                # native rebuild(注:不解决 root better-sqlite3,见下)
```

- **`.env` 模板分发**:`.env.example` 作为种子打入 `resources/.env.example`,**不带 API Key**。[post-pack.mjs](../../web/scripts/post-pack.mjs) 在打包阶段把它复制为 `cheryClaw.exe` 同级的 `.env`,用户后续自由修改,升级不覆盖(NSIS 默认会覆盖,需手动 NSIS include 跳过)。
- **`.chery` 用户副本**:`resources/.chery.template/` 是只读模板,afterPack 复制为 `cheryClaw.exe` 同级的 `.chery/`,用户编辑这个副本。`.chery.template/` 与开发用的 `.chery/` 隔离——开发期的 `.chery/` 含运行时生成(`db/`、`media/`、`mock/`),不打包。开发环境由 [scripts/setup-env.mjs](../../scripts/setup-env.mjs) 走 `postinstall` 钩子从仓库根 `.chery.template/` 拷出,行为对齐(目标存在即跳过,保护用户编辑)。
- `appId` / `productName` / win/mac/linux targets 配置。
- 打包命令:`pnpm electron:pack`(一键全量)/ `pnpm electron:pack:fast`(增量,跳过依赖安装 + Node 22 LTS + SQLite 预编译 + 类型检查,假定缓存已就绪;Node/better-sqlite3 升版本后需先跑全量重建缓存)。
- native rebuild:`pnpm --filter web rebuild`(`electron-builder install-app-deps`)—— **仅 rebuild web/ deps,不触及 root better-sqlite3**。

## native addon ABI(模式 2)

**开发期已解决**:弃用 `ELECTRON_RUN_AS_NODE`,改用系统 node spawn 后端。better-sqlite3 用系统 Node ABI,与后端 build 时一致,无跨 ABI 问题。

**原因**:`ELECTRON_RUN_AS_NODE` 用 Electron 内嵌 node(ABI ≈ Node 20),后端 `better_sqlite3.node` 针对系统 node(Node 24,ABI 137),跨 ABI 崩溃。系统 node spawn 用同 ABI,匹配。

**发行版已解决**:统一打包脚本完成:

1. 下载 Node 22 LTS(ABI 127)二进制到 [build/node/](../../build/node/);[electron-builder.yml](../../web/electron-builder.yml) `extraResources` 把它打入 `resources/node[.exe]`。`getNodeExecutable()` 优先用它,无则 fallback 系统 node。
2. 用下载的 Node 22 从 GitHub release 直下 better-sqlite3 Node 22 ABI 预编译,覆盖到 `node_modules/better-sqlite3/build/Release/`。下一次后端 build,vite-plugin-native-modules 复制新 ABI 的 `.node` 到 `dist/lib/`。
3. 打包配置(Node 版本/代理/镜像)统一在 [package.json](../../package.json) `packConfig` 字段,由 [scripts/pack-config.mjs](../../scripts/pack-config.mjs) 读取。一键打包:`pnpm electron:pack`。

详见 [deployment.md#native-addon-abi模式-2](./deployment.md#native-addon-abi模式-2)。

## 构建产物

| 产物 | 产出方 | 内容 |
|------|--------|------|
| [web/dist/](../../web/dist/) | Vite 渲染构建 | `index.html` + assets |
| [web/dist-electron/main.js](../../web/dist-electron/) | rollup 经 `vite-plugin-electron` | 主进程 ESM |
| [web/dist-electron/preload.mjs](../../web/dist-electron/) | rollup 经 `vite-plugin-electron` | preload(`contextBridge`) |

`vite-plugin-electron` 在 `vite build` 时经 rollup 产出 main + preload,**不执行 electron**,故 headless 下 type-check/build 正常。

## 双运行模式

详见 [README.md#双运行模式浏览器--electron](./README.md#双运行模式浏览器--electron)。要点:

| 命令 | 实现 | X 依赖 |
|------|------|--------|
| `dev:web` | `ELECTRON_ENABLED=false vite` | 无 |
| `dev:electron` | `bash scripts/electron-dev.sh` → `exec vite` | 有 |
| `electron` | `electron .`(spawn 后端 + loadFile) | 有 |

## 运行环境坑（xrdp）

[scripts/electron-dev.sh](../../web/scripts/electron-dev.sh) 自动解决每次手敲 env 问题:

1. **选最新可用 xrdp display**:`ls /tmp/.X11-unix` 去前缀倒序 + `xset -display :N q` 验活,取第一个通的。
2. **`unset ELECTRON_RUN_AS_NODE`**:agent shell 注入 `ELECTRON_RUN_AS_NODE=1` 会让 electron 当 node 跑不开窗。main.ts spawn 后端用系统 node(非 `ELECTRON_RUN_AS_NODE`),并 `delete env.ELECTRON_RUN_AS_NODE` 防污染子进程;dev:electron 是 vite HMR 模式,不 spawn 后端。
3. **`export XAUTHORITY=$HOME/.Xauthority`**:xrdp Xorg `-auth .Xauthority` 相对 home。
4. 无 display 时退回提示 `web:dev`。

### xrdp display 特性

- 每会话覆盖同一 `~/.Xauthority`,mtime = 最新会话启动时间。
- 新 RDP 连接递增 display 号(:10→:11→…)。故"选最新"= 选用户当前 RDP 会话。

### electron 43 sandbox 坑

`chrome-sandbox` 需 `root:root` + `4755`(pnpm 装的默认非 root)。已 `sudo chown root:root + chmod 4755` 修。`--no-sandbox` 被 safety classifier 拦,走正规 SUID 配置。

## 依赖与关联

- **依赖**:`vite-plugin-electron` 1.1 + `vite-plugin-electron-renderer` 1.0 + `electron` 43 + `electron-builder` 25;经 Vite 8 + `@vitejs/plugin-vue` 6。
- **被依赖**:被 [web/package.json](../../web/package.json) scripts(`dev:electron` / `electron` / `pack` / `dist` / `rebuild`)触发。
- **后端关联**:main spawn 后端 bundle([src/index.ts](../../src/index.ts) 产物),协议 [protocol.md](../protocol.md),HTTP `/api/config` 见 [service/http.md](../service/http.md)。
- **关联文档**:[README.md](./README.md)(web 总览)、[deployment.md](./deployment.md)(部署模式 + native ABI 详解)、[web/vite.config.ts](../../web/vite.config.ts)。

## 扩展点

- **IPC 扩展**:当前 `ipcMain` 仅注册 `get-backend-config`（同步，preload 取后端端口配置）。业务能力优先通过现有 WebSocket RPC 扩展；只有必须在 Electron main 进程执行、且后端进程无法承担的能力，才新增 `ipcMain.handle` + preload bridge。
- **后端原生能力扩展**:配置目录打开等能力按 [../service/message.md](../service/message.md) 的 RPC 扩展流程实现，Electron 与浏览器共用；远程浏览器调用作用于后端主机。
- **`.env` / `.chery` 用户位置扩展**:主进程用 `getWritableCheryRoot()` 返回 `cheryDir`,内部已统一探测 `exeRoot` 可写性 + 降级逻辑。若需新增可维护文件,放在 `cheryDir` 下并复用同一探测函数(避免绕过降级逻辑)。
- **native ABI 解决**:已通过 [scripts/electron-pack.mjs](../../scripts/electron-pack.mjs)(Node 22 LTS + prebuild-install)实现,见 [native addon ABI](#native-addon-abi模式-2)。
- **electron-builder 打包验证**:`pnpm --filter web dist` 产安装包;GUI 运行验证需 xrdp(见 [运行环境坑](#运行环境坑xrdp))。
- **窗口行为定制**:[main.ts](../../web/electron/main.ts) `createWindow` 的 `BrowserWindow` 选项;macOS `activate` 重建窗口逻辑已就位。
