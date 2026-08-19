# Utils 工具层

> 源码 [src/utils/](../../src/utils/) ｜ 上级 [docs/](../) ｜ 相关 [../mock.md](../mock.md) ｜ [./drain.md](./drain.md) ｜ [./logger.md](./logger.md)

## 职责

`utils/` 是 CheryNyxus 的**基础工具层**，为 `core/` / `agent/` / `service/` / `db/` / `web/` 所有上层提供：

- **配置加载**：解析 `.chery/config.yaml`，做 `$ENV` 替换、路径补全、默认值兜底，产出全局 `Config` 单例。
- **通用纯工具**：hash（cache key 生成）、json（安全解析）、generator（AsyncGenerator 判定）、rateLimiter（RPM 滑动窗口限流）。
- **Drain 日志模板挖掘**：从重复日志行归纳「模板」，供 `read_file` 感官对大日志文件去重压缩。
- **统一日志**：闭包式 logger（console + 按天文件输出），并集成 bash 子进程日志工具集。

**关键定位**：utils 是**被各层依赖、本身不反向依赖任何业务层**的叶子层。utils 内部仅 logger 依赖 [config.ts](../../src/utils/config.ts) 的类型；drain / rateLimiter 依赖 [logger](./logger.md) 做运行时日志输出。`config.ts` 仅从 `@/core/config` 复用 `SupervisionLevel` 枚举（纯类型枚举，不构成业务耦合）。

> ⚠ `.claude/CLAUDE.md` 中「目录结构」将 logger 描述为 `logger/bashLogger.ts` + `logger/fileLogger.ts`，**与现状不符**。真实结构是统一的 [logger/index.ts](../../src/utils/logger/index.ts)（含 bash/文件工具集，通过 `logger.tools` 暴露）。CLAUDE.md 也漏列了根目录的 [rateLimiter.ts](../../src/utils/rateLimiter.ts)。本文档以源码为准。

## 文件清单

### 根工具（无子目录）

| 文件 | 一句话 |
|------|--------|
| [config.ts](../../src/utils/config.ts) | 加载 `.chery/config.yaml`，`$ENV` 替换 + 路径补全 + 默认值兜底；导出 `Config` 单例与 `BrainConfig`/`GlobalConfig`/`LoggerConfig` 类型；重导出 `SupervisionLevel` |
| [envGuard.ts](../../src/utils/envGuard.ts) | 环境变量敏感信息脱敏：从 `.env` 提取变量名，在文本中替换为占位符，供 sense 中间件统一调用 |
| [hash.ts](../../src/utils/hash.ts) | `hashGenerator(...parts)` — SHA256 柯里化，`${prefix}::${rest.join(":")}` 作为输入；用于感官 cache key |
| [json.ts](../../src/utils/json.ts) | `safeJsonParse(raw, fallback)` — 失败返回 fallback 不抛错 |
| [generator.ts](../../src/utils/generator.ts) | `isAsyncGenerator(value)` — 类型守卫，判断值是否为 `AsyncGenerator` |
| [rateLimiter.ts](../../src/utils/rateLimiter.ts) | `getRateLimiter(url, key, rpm)` — 按 `(url,key)` 共享的滑动窗口 RPM 限流器单例注册表 |
| [modelThinking.ts](../../src/utils/modelThinking.ts) | 模型 → 思考强度档位映射：加载 `.chery/model-thinking.yaml`，按 model 别名匹配，返回档位枚举子集（详见「modelThinking 配置」章节） |

### 子模块（目录）

| 目录 | 文档 | 一句话 |
|------|------|--------|
| [drain/](../../src/utils/drain/) | [./drain.md](./drain.md) | Drain 日志模板挖掘算法：固定深度前缀树 + 簇聚类 + 快照持久化；对外简化入口 `compressLog()` |
| [logger/](../../src/utils/logger/) | [./logger.md](./logger.md) | 闭包式统一日志（console + 按天文件，plain/json），含 bash 子进程与通用文件日志工具集 |

## 核心概念 / 导出

### config.ts — 全局配置单例

```ts
// 运行时加载 .chery/config.yaml，做 $ENV 替换、supervision 字符串→枚举、路径补全、默认值兜底
const config: Config;          // default export
export type { Config, BrainConfig, GlobalConfig, LoggerConfig };
export { SupervisionLevel } from "@/core/config";   // 从 core 重导出
```

### envGuard.ts — 环境变量脱敏

```ts
// 从 .env 提取环境变量名，在文本中替换为占位符（默认 '[REDACTED]'）
export function redactEnvKeys(content: string, placeholder?: string): string;

// 获取环境变量名列表（带缓存，供测试使用）
export function getEnvVarNames(): string[];

// 重置缓存（供测试使用）
export function resetEnvVarCache(): void;
```

**使用场景：** sense 中间件在返回工具输出前，统一调用 `redactEnvKeys()` 脱敏环境变量名，防止敏感信息泄露。复用 [config.ts](../../src/utils/config.ts) 的 `listEnvVarNames()` 函数，避免重复读取 `.env` 文件。

**替换规则：**

- 使用正则表达式匹配所有 `.env` 中定义的环境变量名
- 词边界匹配（`\b`）确保只匹配完整变量名
- 示例：`API_KEY` 匹配 `"API_KEY=xxx"`，但不匹配 `"MY_API_KEY=xxx"`

`Config` 顶层结构（详见 [config.ts 类型定义](../../src/utils/config.ts#L55-L132)）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `global` | `ExtendedGlobalConfig` | 全局开关（thinking/supervision/stream/超时/loop 上限）+ `disconnect_grace_ms` 断连宽限 + logger + file_compression + 自动补全的 4 个 `.chery/` 子路径 |
| `llm.brain` | `Record<string, BrainConfig>` | Brain 名称 → provider/model/url/key/thinking/rpm/mock/capabilities 配置 |
| `media` | `MediaConfig?` | 图片、视频、音频网关（url/model/key/enabled）及 `maxUploadMb` |
| `sense_groups` | `Record<string, string[]>` | 感官分组（值如 `"read_file"` 或 `"execute_command:auto"` 覆盖监管等级） |
| `server` | `ServerConfig` | WebSocket `port`（默认 8182）+ `transport`（默认 `"binary"`）；HTTP 静态服务端口原 `web_port` 已废弃，改由环境变量 `WEB_PORT`（默认 8183）指定，与 `electron/main.ts` 一致 |

`BrainConfig` 关键字段（[源码](../../src/utils/config.ts)）：`provider` / `model` / `url?` / `key?` / `thinking?` / `rpm?`（每分钟最大请求数）/ `mock?`（脚本化响应，见 [../mock.md](../mock.md)）/ `capabilities?`（Tool Call、图片/视频/音频输入及生成能力）。能力缺省兼容旧配置：Tool Call 开启，媒体能力关闭。

`$ENV` 替换规则：仅匹配**整段值**的正则 `^\$([A-Z_][A-Z0-9_]*)$`（如 `url: $OLLAMA_HOST`），从 `.env`/进程环境变量取值；缺失会收集到 `missingEnvVars` 并 warn（`Set` 去重，同一变量被多 brain 引用只提示一次），原样保留字符串。不会替换值中嵌入的 `$VAR`。运行期缺失时 `replaceEnvVars` 会先调用 `reloadEnvFile(false)` 重读 `.env` 文件补充**新添加**的变量（只填缺失、不覆盖 OS env 既有值），因此运行期新增的 `.env` 变量首次被 `$VAR` 引用即可用，无需重启；修改已有变量值仍需重启或经 `env.list` 刷新（`reloadEnvFile(true)` 覆盖式重载）。

### 配置读写（config.get / config.save RPC）

设置面板（web）经 `config.get` / `config.save` 和一个只读校验 RPC 操作 `.chery/config.yaml`，**运行时内存单例不碰**（重启生效），避开热更复杂度：

```ts
// 原始形态（磁盘/YAML）：supervision 为字符串、无路径补全、key 仍为 $ENV 占位符
export interface ConfigRaw {
  global: GlobalConfigRaw;                 // supervision: "auto"|"smart"|"manual"
  llm: LLMConfig;
  media?: MediaConfig;
  sense_groups?: Record<string, string[]>;
  mcp_servers?: Record<string, McpServerConfigRaw>;
  roles?: Record<string, RoleConfig>;
  presets?: Record<string, PresetConfig>;
}

export function readRawConfig(): ConfigRaw;        // 读原文，剥离 server 段（config.get）
export function saveRawConfig(partial: ConfigRaw): { ok: true } | { ok: false; errors: string[] };
//   校验(validateRawConfig) -> 读盘取 server 段 -> merge -> js-yaml dump(无注释) -> writeFileSync
export function validateRawConfig(raw: ConfigRaw): string[];  // 业务校验，loadConfig 启动期亦调用
```

`config.workspace.validate` 接收 `{ workspace }`，只在后端主机上检查非空路径是否为绝对、可访问的目录，返回 `{ valid, error? }`；它不读取或写入配置，也不触发重启。设置页在预设工作区输入变化后调用它，因此浏览器客户端同样能得到后端文件系统的即时结果。保存时 `saveRawConfig` 仍执行同一类校验，避免绕过 UI 写入无效配置。

校验规则（`validateRawConfig`，返回错误字符串数组，空=通过）：
- `roles.*.brain` 必须存在于 `llm.brain`；`roles.*.systemPrompt`（如配置）必须存在
- `presets.*.leader` 必须引用 `roles` 中的角色，并包含于该预设的 `roles`；`presets.*.roles[*]` 必须引用已定义角色
- `presets.*.workspace`（如配置）必须是已存在的目录绝对路径（`fs.accessSync` 校验，fail loud；该字段仅作 system prompt 提示词注入，不约束 sense 行为）
- `global.supervision` / `mcp_servers.*.supervision` 必须是 `auto|smart|manual`（修原 `SupervisionLevel[name]` 非法值静默变 undefined 的 bug）
- `global.disconnect_grace_ms` 必须是有限且 `>= 0` 的毫秒值；缺省为 `15000`，`0` 表示断连后立即请求当前输出结束时暂停
- `global.history_recall.max_output_chars`（如配置）必须是 `> 0` 的数字；缺省 `4000` 由 utils/config 兜底（`history_recall` 感官单次返回硬字符上限）
- `sense_groups.*[]` 的 `:level` 后缀必须合法
- `llm.brain.*` 的 `model` / `provider` 必填
- `capabilities.generate.*` 不得与 `capabilities.toolCall:false` 组合；无 Tool Call brain 的角色不得配置 senseGroup/MCP
- **key 不参与启动校验**：`llm.brain.*.key` / `media.*.key` 缺失不阻止启动，运行期 provider 调用时若 key 为空才抛错响应前端（见 [../agent/provider.md](../agent/provider.md)）。前端 `env.list` 返回的密钥下拉按**后缀过滤**——任何以 `KEY` / `TOKEN` / `SECRET` / `PASSWORD` / `PASSWD` / `ACCESS_KEY_ID` 结尾的变量名都视为可作密钥占位（放宽：不再强制 `API_` 前缀，兼容手写命名如 `AP1I_KEY`），运行时配置（`CHERY_DIR` / `*_HOST` / `*_URL` 等）不进入下拉。

写回保留盘上 `server` 段不动（端口/传输不通过面板编辑），`js-yaml` dump 无注释；完整注释文档备份在 [.chery/config.yaml.example](../../.chery/config.yaml.example)。

### hash.ts

```ts
export function hashGenerator(...parts: string[]): string;
// 例：hashGenerator('file', path, size, mtime) → SHA256(`${'file'}::${[path,size,mtime].join(':')}`)
```

### json.ts

```ts
export function safeJsonParse<T>(raw: string, fallback: T): T;  // 解析失败返回 fallback
```

### generator.ts

```ts
export function isAsyncGenerator(value: unknown): value is AsyncGenerator;
// 通过检测 next/return/throw 三个函数判定
```

### rateLimiter.ts

```ts
export function getRateLimiter(url: string, key: string | undefined, rpm: number): SlidingWindowRateLimiter;
export function resetRateLimiters(): void;  // 测试 / 热更清残留
// SlidingWindowRateLimiter（class，未直接导出）.acquire(): Promise<void>
```

详见 [./logger.md 中 rateLimiter 与 logger 的协作](./logger.md)（rateLimiter 内部调 `logger.info` 打印限流等待）。算法细节见下文「关键流程」。

### modelThinking.ts — 模型档位映射

`ThinkingLevel`（[core/llm](../core/llm.md)）定义 6 档：`off` / `on` / `low` / `medium` / `high` / `xhigh`，并通过 `(string & {})` 允许任意字符串作为额外档位（来自 `.chery/model-thinking.yaml`）。不同模型支持的档位不同（OpenAI o1 系列支持 reasoning_effort 全 4 档，ollama 不接受 thinking 参数，部分长上下文模型可能只支持开关两档）。

`modelThinking` 解决两件事：

1. **配置加载**：读取 `.chery/model-thinking.yaml`，声明模型别名 → thinking 档位数组（**原样保留文件中的字符串，按 YAML 顺序**；不校验、不剔除、不映射）。
2. **运行时查询**：给定 model 名（支持精确/前缀/通配 `*` 匹配），按文件原顺序返回该模型可用的档位列表，供前端 settings 渲染「深度思考」旋钮。

```ts
// 加载（启动期一次性，in-memory 缓存；YAML 不存在则返回空配置，全量走兜底）
export function loadModelThinking(): ModelThinkingConfig;

// 按 model 名查档位（精确 > 前缀 > 通配 `*` > 兜底 ["off","on"]）
export function resolveThinkingLevels(model: string): ThinkingLevel[];

// 批量查询（RPC utils.thinkingLevels 用）
export function resolveThinkingLevelsBatch(models: string[]): Record<string, ThinkingLevel[]>;
```

**配置格式（`.chery/model-thinking.yaml`）：**

```yaml
# thinking 数组原样返回文件中的字符串（按 YAML 顺序）。`on`/`off` 是仅有的「开关档关键词」，
# 但任何字符串都可作档位名（如 DeepSeek 的 `max`）。provider 端按各自协议映射为 API 参数。
# 匹配顺序：精确 > 最长前缀 > 通配 "*"；未命中返回 ["off","on"] 兜底
models:
  - aliases: [gpt-4o, gpt-4o-mini, gpt-4-turbo]
    thinking: [off, low, medium, high]             # → [off, low, medium, high]
  - aliases: [LongCat-Flash-Thinking, LongCat-Flash-Thinking-2601]
    thinking: [off, on]                            # → [off, on]（仅开关）
  - aliases: [glm-5.2, glm-5, glm-4.6]
    thinking: [off, low, medium, high]             # → [off, low, medium, high]
  - aliases: [doubao2.0-pro]
    thinking: [off, low, medium, high]
  - aliases: [deepseek-v4-pro, deepseek-v4-flash]
    thinking: [off, on, high, max]                 # → [off, on, high, max]（`max` 原样；DeepSeek provider 内部映射为 'max'）
  - aliases: ["*"]
    thinking: [off, on]
```

**RPC 暴露：** `utils.thinkingLevels({ models: string[] })` → `{ levels: Record<string, ThinkingLevel[]> }`。前端 BrainCard 在 model 字段变化时调用，渲染「深度思考」选择器。未在 RPC 返回中的 model 后端兜底为 `["off","on"]`。

**前端交互：** ThinkingLevelKnob 采用「真放大镜」设计——上方固定 `84×36px` 的长方形视窗（带边缘扭曲效果），下方是一条优先使用的可拖动小轨道。轨道和视窗共用居中的 `50px` 分段连线与月相图标：以完整序列 `🌑 🌒 🌓 🌔 🌕` 为标尺，按当前模型实际暴露的档位数量等距取样，不依赖档位名称。故 2 档为 `🌑 → 🌕`、3 档为 `🌑 → 🌓 → 🌕`、4 档为 `🌑 → 🌒 → 🌔 → 🌕`、5 档使用完整序列。视窗内隐藏一条与下方轨道共用同一 `T = baseOffset(activeIndex) + dragDelta` 的大轨道（缩放约 2.2x），被 `overflow:hidden` 裁剪后呈现精准放大效果：视窗正中显示的内容与小轨道中线的内容始终一致。当前档位标签直接显示后端值 `off` / `on` / `low` / `medium` / `high`，居中置于视窗上方；无边框的细线 chevron 前后档按钮位于控件底部左右边，仅作为拖拽之外的备用入口，到达首尾时禁用。详见 [ThinkingLevelKnob](../../web/src/features/agent/settings/components/ThinkingLevelKnob.vue) 及 [../service/chat.md §5 工具与设置类 RPC](../service/chat.md)。

## 关键流程 / 数据流

### 配置加载（启动期，一次性）

```
loadConfig()
  ├─ resolve cheryDir = process.env.CHERY_DIR ?? process.cwd()
  ├─ readFileSync(.chery/config.yaml)  → 不存在则 process.exit(1)
  ├─ yaml.load → rawConfig
  ├─ replaceEnvVars(rawConfig)         → 递归整段 $ENV 替换，缺失收集到 missingEnvVars
  ├─ supervision: string → SupervisionLevel 枚举
  ├─ 补全 global.{skills_dir, senses_dir, prompts_dir, db_dir}（cheryDir + .chery/...；prompts_dir 为唯一 prompt 目录，system.md 在其根下）
  ├─ server 默认值兜底（port 8182 / transport binary；web_port 已废弃，改 WEB_PORT 环境变量）
  └─ warn: CHERY_DIR 未配置 / 缺失环境变量
module 顶层 `const config = loadConfig()` → 全局单例，import 即触发
```

`.env` 加载：config.ts 在模块顶层用 `dotenv.config()` 读 `src/../.env`（tsx 开发）或 `dist/.env`（生产）——启动一次性填充 `process.env`（不覆盖 OS env 既有值）。运行期新增/修改 `.env` 后，可经 `reloadEnvFile(override?)` 按需重读：`false` 只填充缺失键（`replaceEnvVars` 兜底用），`true` 以 `.env` 为准覆盖（`env.list` 刷新时触发，见 [../service/README.md](../service/README.md)）。

### rateLimiter 滑动窗口限流（runtime）

```
provider.openai → limitByRpm(url, options)
  └─ getRateLimiter(url, key, rpm)         // (url,key) 共享同一限流器
       └─ SlidingWindowRateLimiter.acquire()
            ├─ 同步段（首个 await 前，原子）：
            │    ├─ 清理 slots 中 <= now-60s 的旧时刻
            │    ├─ 未满(len<rpm): slot=now；已满: slot=slots[len-rpm]+60s
            │    └─ slots.push(slot)
            └─ 若 slot>now: logger.info + await sleep(slot-now)
```

并发安全保证：`acquire()` 的同步段（清理 + 预约 slot + push）在**首个 `await` 前一次性完成**，Node 事件循环不会交错，多个并发请求串行预约，不会超发。窗口固定 60s（`WINDOW_MS = 60_000`）。

## 依赖与关联 ⭐

### utils 内部依赖

| 源 | 目标 | 性质 |
|----|------|------|
| [config.ts](../../src/utils/config.ts) | `@/core/config`（`SupervisionLevel`） | 纯类型/枚举复用 |
| [logger/index.ts](../../src/utils/logger/index.ts) | `@/utils/config.js`（`LoggerConfig` 类型） | 仅类型 import |
| [rateLimiter.ts](../../src/utils/rateLimiter.ts) | `@/utils/logger/index.js` | runtime：`logger.info` 打印限流等待 |
| [drain/drainBase.ts](../../src/utils/drain/drainBase.ts) | `@/utils/logger/index.js` | runtime：`printTree` / `writeLine` 默认走 `logger.info` |
| [drain/index.ts](../../src/utils/drain/index.ts) → [templateMiner.ts](../../src/utils/drain/templateMiner.ts) → [drain.ts](../../src/utils/drain/drain.ts) → [drainBase.ts](../../src/utils/drain/drainBase.ts) | drain 子模块内部继承链 | `Drain extends DrainBase` |

### 被外部依赖（按工具）

| 工具 | 被哪些模块使用 |
|------|----------------|
| **config** | `agent/{builder,runtimeResolver,provider/mock,sense/bash}`、`agent/sense/read`（`file_compression`）、`core/middleware/{index,types}`、`service/{brain/list,sense/list}` —— **唯一对外的配置入口** |
| **logger** | 几乎所有层：`agent/middleware/{chat,checkpointState,loop,retry,tool}`、`agent/provider/{mock,ollama}`、`agent/sense/{bash,compileToolsReporter,index,processRegistry}`、`agent/prompt/loadSkill`、`core/middleware/index`、`service/{chat/send,chat/streamMapper,message/router,websocket/*}`、`index.ts`、`web/server`、`utils/{drain/drainBase,rateLimiter}` |
| **hash** | `agent/sense/{read,skill,write}`、`core/sense/compiler/core`（cache key 生成） |
| **json** | `db/chat`、`service/websocket/transport`、`agent/middleware/tool`（消息/sense 参数安全解析） |
| **generator** | `service/message/router`、`service/websocket/index`（判定 RPC 返回值是否为流） |
| **rateLimiter** | `agent/provider/openai`（仅 OpenAI 兼容 provider 的 RPM 限流） |
| **drain**（`compressLog`） | `agent/sense/read`（大日志文件读取消减；`compression: "drain"` 触发） |

### 横切参考

- 配置文件真实样例：[.chery/config.yaml](../../.chery/config.yaml)
- mock provider（依赖 config.ts 的 `MockConfig` 类型）：[../mock.md](../mock.md)
- `read_file` 感官如何调用 `compressLog` / 读 `file_compression`：[../../src/agent/sense/read.ts](../../src/agent/sense/read.ts)
- OpenAI provider 如何调用 `getRateLimiter`：[../../src/agent/provider/openai.ts](../../src/agent/provider/openai.ts)

## 扩展点

- **新增 Brain Provider 配置**：在 `.chery/config.yaml` 的 `llm.brain.<name>` 下加条目，`provider` 字段对应已注册 Adapter（详见 agent/provider 文档）。无需改 config.ts —— 但若引入新字段，需扩展 `BrainConfig` interface。
- **新增全局配置项**：在 `config.ts` 的 `GlobalConfig` / `FileCompressionConfig` / `LoggerConfig` / `ServerConfig` 加字段，并在 `loadConfig()` 中加默认值兜底（参考 `server` 字段的处理）。
- **新增限流维度**：rateLimiter 当前按 `(url, key)` 共享。若需按 model 或其他维度限流，改 [rateLimiter.ts](../../src/utils/rateLimiter.ts) 的 `limiterKey()`。
- **Drain 算法调参 / 换持久化后端**：见 [./drain.md#扩展点](./drain.md)。
- **日志输出新目标**：logger 当前支持 console + 按天文件。若需 loki/elasticsearch 等，在 [logger/index.ts](../../src/utils/logger/index.ts) 的 `output()` 增加分支，或在 `createLogger` 中扩展 `_fileStream` 机制。
