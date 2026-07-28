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

这一步会自动触发 `postinstall` 钩子（[scripts/setup-env.mjs](../scripts/setup-env.mjs)），完成两件**种子初始化**：

| 来源 | 目标 | 说明 |
|------|------|------|
| `.env.example` | `.env` | 单文件拷贝 |
| `.chery.template/` | `.chery/` | 整目录递归拷贝（含 `config.yaml`、prompt、rule 等） |

> 约定：**目标已存在则跳过**，不会覆盖你已有的编辑。若种子没生成（比如模板当时未就绪），手动跑 `node scripts/setup-env.mjs`。
>
> `.env` 与 `.chery/` 都在 [.gitignore](../.gitignore) 中（运行时配置不入库），所以这一步是本地配置的**唯一起点**。

---

## 3. 配置密钥与本机路径（🔧 人工必做，最关键）

依赖装好后，**还跑不起来**——`.chery/config.yaml` 里是占位符，`.env` 里是假 key。这两处必须人手填。

### 3.1 LLM API Key

CheryNyxus 至少需要一个可用 Brain（LLM）。Key 有三种等价写法，**任选其一**：

**方式 A：写进 `.env`（推荐，不入库）**

编辑 [.env](../.env)（由 `.env.example` 拷贝而来），填入真实 key，**变量名必须与 `config.yaml` 中 `$XXX` 占位符一致**：

```bash
# .env
LONGCAT_API_KEY=sk-你的真实key
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

`config.yaml` 里 `key: $LONGCAT_API_KEY` 运行时会从此注入。优先级：**系统环境变量 > `.env` 文件**。

**方式 B：系统环境变量**

直接 `export LONGCAT_API_KEY=...`（或 Windows 系统变量），效果同 A，且优先级更高。

**方式 C：`config.yaml` 直写字面量（不推荐，易泄密）**

```yaml
key: sk-你的真实key   # 不走 $ 占位符，直接写死
```

> ⚠️ 方式 C 会把密钥写进本地 `.chery/`。虽不入库，但属于明文存储，仅限本地调试临时使用。

### 3.2 `.chery/config.yaml` 必改项

打开 [.chery/config.yaml](../.chery/config.yaml)（结构与 [.chery.template/config.yaml](../.chery.template/config.yaml) 一致），改这三类占位符：

1. **Brain 的 url / model**（`llm.brain.<name>`）：

   ```yaml
   my-brain:
     url: https://api.openai.com/v1   # 占位符 <YOUR_OPENAI_COMPATIBLE_URL> 改成真实端点
     model: gpt-4o                     # <YOUR_MODEL_NAME> 改成真实模型 id
     key: $OPENAI_API_KEY              # 与 .env 变量名对齐
   ```

   > `key` 字段**必须非空**：`assertChatOptions` 会拦截空 key。本地不校验 key 的服务（如 LM Studio / Ollama OpenAI 模式）也填任意非空串。

2. **预设的 workspace 路径**（`presets.<name>.workspace`）：

   ```yaml
   presets:
     默认:
       workspace: /home/you/projects/my-workspace   # <YOUR_WORKSPACE_PATH> 改成本机绝对路径
   ```

   这是 agent 实际干活的工作目录，必须真实存在。

3. **（可选）监管等级 / 端口**等：见 [config.yaml 注释](../.chery.template/config.yaml)，按需调。

### 3.3 零配置离线启动（🤖 免 Key 快速验证）

只想验证环境能不能跑、不想配 key？用 **mock provider**——无需网络、无需 key。`config.yaml` 已内置 `mock_test` brain 示例（`.chery/mock/` 脚本驱动），把预设的 `leader` brain 指向 `mock_test` 即可离线走通 send/resume/loop 全流程。详见 [mock.md](./mock.md)。

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
