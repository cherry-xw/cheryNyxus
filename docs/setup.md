# 开发环境搭建

> 面向新接手项目的开发者（或 AI 协作者）。目标：从空仓库到 `pnpm dev` 跑起后端、浏览器看到前端。
>
> 阅读约定：标注 **🔧 人工必做** 的步骤无法被 AI / 脚本自动完成（系统级依赖、密钥、本机路径），是卡点，必须人来；标注 **🤖 AI 可执行** 的步骤可交给 AI 或脚本一键完成。

---

## 1. 前置条件（🔧 人工必做）

这些是系统级依赖，AI 不能替你装，**漏一个 `pnpm install` 就会失败**。

### 1.1 Node.js（>=20）

- 要求：`engines.node >=20`（见 [package.json](../package.json)）。推荐 **Node 20 LTS** 或 **22**（打包固定 `22.11.0`，见 `packConfig.nodeVersion`）。
- 验证：`node --version` 输出 `v20.x` 及以上。
- 安装：[nodejs.org](https://nodejs.org/) 或 `nvm install 20`。多版本用 nvm / fnm 管理。

### 1.2 pnpm

- 本仓是 pnpm workspace（[pnpm-workspace.yaml](../pnpm-workspace.yaml)，含 `web/`），**必须用 pnpm**，不要用 npm / yarn。
- 推荐通过 corepack（随 Node 附带，不污染全局）：

  ```bash
  corepack enable
  corepack prepare pnpm@latest --activate
  ```

  或 `npm install -g pnpm`。
- 验证：`pnpm --version`。

### 1.3 Git（插件导入硬性前提）

- 系统-git 是**硬性依赖**：技能 / 插件的 Git 导入走 `git clone --depth 1`（详见 [agent/plugin.md](./agent/plugin.md)）。即使不用插件，clone 本仓也需要它。
- 验证：`git --version`。

### 1.4 Native 模块编译工具链（🔧 人工必做，易漏）

后端依赖 `better-sqlite3`（[package.json](../package.json) `dependencies`），`pnpm install` 时需**本地编译**原生模块。缺工具链会看到 `gyp` / `python` 相关报错。

| 平台 | 需要的工具 |
|------|-----------|
| Linux | `python3` + `make` + `g++`（如 Ubuntu：`sudo apt install -y python3 make g++`） |
| macOS | Xcode Command Line Tools：`xcode-select --install` |
| Windows | 「Visual Studio Build Tools」含 C++ 桌面开发 workload + Python 3 |

> ⚠️ **Electron 运行模式 ABI 坑**：开发期 Node 直跑没问题；若要跑 Electron 一体模式（`pnpm electron:dev`），`better-sqlite3` 需按 Electron ABI 重编译（`pnpm --filter web rebuild`）。该问题待彻底解决，详见 [web/electron.md](./web/electron.md)。**开发期可先用浏览器模式绕开。**

---

## 2. 安装依赖（🤖 AI 可执行）

克隆本仓后，在仓库根目录执行：

```bash
pnpm install
```

这一步会自动触发 `postinstall` 钩子（[scripts/setup-env.mjs](../scripts/setup-env.mjs)），完成环境初始化与内置资产增量升级：

| 来源 | 目标 | 说明 |
|------|------|------|
| `.env.example` | `.env` | 仅目标缺失时创建，已有密钥永不覆盖 |
| `.chery.template/` | `.chery/` | 全新 workspace 整体初始化；已有 workspace 按官方文件哈希增量同步 |

> `.chery/.template-manifest.json` 记录上一版官方文件哈希。升级只替换仍保持官方原版的文件；用户修改或主动删除的资产保持不变。被替换的旧版文件与配置会先备份到 `.chery/backups/template/<timestamp>/`。`config.yaml` 不做整文件覆盖，只迁移当前版本缺失的内置角色、感官组和预设引用。
>
> 若种子没生成（比如模板当时未就绪），可手动运行 `node scripts/setup-env.mjs`。后端 guardian 正常启动和执行维护命令前也会做同样的增量同步；同步失败只告警，并继续尝试使用原 workspace 启动。
>
> `.env` 与 `.chery/` 都在 [.gitignore](../.gitignore) 中（运行时配置不入库），所以这一步是本地配置的**唯一起点**。

---

## 3. 配置一颗大脑（🔧 首次启动必做）

发行模板只保留一颗名为 `default` 的占位大脑。后端可以带占位配置启动；首次对话前，在设置页完成以下配置即可使用。

### 3.1 配置 LLM API Key

编辑 [.env](../.env)（由 `.env.example` 首次复制，已有文件不会覆盖）：

```bash
LLM_API_KEY=你的真实密钥
```

也可以设置同名系统环境变量；优先级为 **系统环境变量 > `.env` 文件**。设置页大脑卡片的密钥下拉选择 `LLM_API_KEY`，磁盘配置保存为 `key: $LLM_API_KEY`，不会把真实值写入 `config.yaml`。

### 3.2 在设置页完成 default 大脑

打开「设置 → 大脑 → default」，依次填写：

1. 适配器：模板默认 `openai`，按实际服务切换。
2. 地址：包含服务要求的版本段，例如 `https://api.openai.com/v1`。
3. 模型：可手填模型 id，或先填写地址与密钥后刷新模型列表选择。
4. 密钥：选择 `LLM_API_KEY`，测试连接成功后保存。

模板中的 `<YOUR_LLM_URL>` 与 `<YOUR_MODEL_NAME>` 在设置页按空值显示，不会冒充真实配置。保存后服务受控重启，`cheryNyxus` 以及其内置辅助角色统一使用这颗大脑。

### 3.3 后续配置

大脑可用后，直接告诉 CheryNyxus 修改角色、预设、感官组、监管等级等配置。它通过 `config_manage` 完成候选校验、备份和受控重启；字段参考见 [.chery.template/docs/config.md](../.chery.template/docs/config.md)。Mock 调试仍受支持，但不再进入发行默认配置，使用方法见 [mock.md](./mock.md)。

---

## 4. 启动与验证（🤖 AI 可执行）

### 4.1 后端开发模式

```bash
pnpm dev
```

SSR 构建 + nodemon 热重载，监听 `ws://127.0.0.1:8182`（端口见 `config.yaml` 的 `server.port`）。

### 4.2 前端（浏览器模式，推荐开发期）

```bash
pnpm web:dev      # 仅前端，单独开终端；或：
pnpm dev:all      # concurrently 同时拉起 backend + web
```

### 4.3 验证清单

| 检查项 | 命令 | 期望 |
|--------|------|------|
| 类型检查（后端） | `pnpm type-check` | 通过（**注意**：`src/db/chat.ts`、`src/service/rule/list.ts` 等存在预存 TSC 错误基线，非本次回归；新增模块改动需保证自己的代码 0 错误） |
| 类型检查（前端） | `pnpm --filter web type-check` | 通过（前端验证最终交用户自测） |
| Lint | `pnpm lint` | 通过 |
| 单测 | `pnpm test` | vitest；套件有预存失败基线，开发期以后端 TSC 为门控 |
| 流程测试 | 见 [flow-test.md](./flow-test.md) | S1–S16 场景矩阵 |

> 「预存错误 / 失败基线」是指仓库本身就存在的、与本次改动无关的历史问题，别当成自己引入的回归去修。

---

## 5. 常用命令速查

| 命令 | 作用 |
|------|------|
| `pnpm install` | 装依赖 + postinstall 钟子初始化 `.env` / `.chery/` |
| `pnpm dev` | 后端开发（SSR + nodemon 热重载） |
| `pnpm build` | 后端构建到 `dist/`（先跑 `type-check`） |
| `node dist/index.js` | 运行编译产物 |
| `pnpm compile:senses` | 编译 `.chery/senses/` 外部感官 |
| `pnpm web:dev` | 前端浏览器开发模式 |
| `pnpm electron:dev` | 前端 Electron 开发模式（注意 §1.4 ABI 坑） |
| `pnpm dev:all` | 同时起 backend + web |
| `pnpm type-check` / `pnpm lint` | 后端类型检查 / lint（改码后必跑） |
| `pnpm test` | vitest 单测 |
| `pnpm electron:pack` | Electron 打包（详见 [web/pack-guide.md](./web/pack-guide.md)） |

---

## 6. 故障排查

- **`pnpm install` 报 gyp / python 错** → 缺 native 编译工具链，补 §1.4。
- **启动报空 key / `assertChatOptions` 拦截** → `.env` 变量名与 `config.yaml` 的 `$XXX` 不一致，或 key 为空；检查 §3.1 / §3.2。
- **agent 不干活 / 报 workspace 不存在** → `presets.<name>.workspace` 没改成真实路径；检查 §3.2-2。
- **`pnpm dev` 端口冲突** → 改 `config.yaml` 的 `server.port`。
- **Electron 模式 better-sqlite3 崩溃** → ABI 不匹配，见 §1.4 + [web/electron.md](./web/electron.md)；开发期用浏览器模式。
- **前端连不上后端** → 前端通过 `/api/config` 自动发现 WS 地址，确认后端 `server.host`/`port` 可达、防火墙放行。
