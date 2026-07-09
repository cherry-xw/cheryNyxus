# Utils 工具层

> 源码 [src/utils/](../../src/utils/) ｜ 上级 [docs/](../) ｜ 相关 [../mock.md](../mock.md) ｜ [./drain.md](./drain.md) ｜ [./logger.md](./logger.md)

## 职责

`utils/` 是 cheryClaw 的**基础工具层**，为 `core/` / `agent/` / `service/` / `db/` / `web/` 所有上层提供：

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
| [hash.ts](../../src/utils/hash.ts) | `hashGenerator(...parts)` — SHA256 柯里化，`${prefix}::${rest.join(":")}` 作为输入；用于感官 cache key |
| [json.ts](../../src/utils/json.ts) | `safeJsonParse(raw, fallback)` — 失败返回 fallback 不抛错 |
| [generator.ts](../../src/utils/generator.ts) | `isAsyncGenerator(value)` — 类型守卫，判断值是否为 `AsyncGenerator` |
| [rateLimiter.ts](../../src/utils/rateLimiter.ts) | `getRateLimiter(url, key, rpm)` — 按 `(url,key)` 共享的滑动窗口 RPM 限流器单例注册表 |

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

`Config` 顶层结构（详见 [config.ts 类型定义](../../src/utils/config.ts#L55-L132)）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `global` | `ExtendedGlobalConfig` | 全局开关（thinking/supervision/stream/超时/loop 上限）+ logger + file_compression + 自动补全的 4 个 `.chery/` 子路径 |
| `llm.brain` | `Record<string, BrainConfig>` | Brain 名称 → provider/model/url/key/thinking/rpm/mock 配置 |
| `sense_groups` | `Record<string, string[]>` | 感官分组（值如 `"read_file"` 或 `"execute_command:auto"` 覆盖监管等级） |
| `server` | `ServerConfig` | WebSocket `port`（默认 8182）+ `transport`（默认 `"binary"`）；HTTP 静态服务端口原 `web_port` 已废弃，改由环境变量 `WEB_PORT`（默认 8183）指定，与 `electron/main.ts` 一致 |

`BrainConfig` 关键字段（[源码](../../src/utils/config.ts#L55-L67)）：`provider` / `model` / `url?` / `key?` / `thinking?` / `rpm?`（每分钟最大请求数）/ `mock?`（脚本化响应，见 [../mock.md](../mock.md)）。

`$ENV` 替换规则：仅匹配**整段值**的正则 `^\$([A-Z_][A-Z0-9_]*)$`（如 `url: $OLLAMA_HOST`），从 `.env`/进程环境变量取值；缺失会收集到 `missingEnvVars` 并 warn，原样保留字符串。不会替换值中嵌入的 `$VAR`。

### 配置读写（config.get / config.save RPC）

设置面板（web）经两个 RPC 读写 `.chery/config.yaml`，**运行时内存单例不碰**（重启生效），避开热更复杂度：

```ts
// 原始形态（磁盘/YAML）：supervision 为字符串、无路径补全、key 仍为 $ENV 占位符
export interface ConfigRaw {
  global: GlobalConfigRaw;                 // supervision: "auto"|"confirm"|"manual"
  llm: LLMConfig;
  sense_groups?: Record<string, string[]>;
  mcp_servers?: Record<string, McpServerConfigRaw>;
  default?: DefaultAgentConfig;
  subagents?: Record<string, SubagentConfig>;
}

export function readRawConfig(): ConfigRaw;        // 读原文，剥离 server 段（config.get）
export function saveRawConfig(partial: ConfigRaw): { ok: true } | { ok: false; errors: string[] };
//   校验(validateRawConfig) -> 读盘取 server 段 -> merge -> js-yaml dump(无注释) -> writeFileSync
export function validateRawConfig(raw: ConfigRaw): string[];  // 业务校验，loadConfig 启动期亦调用
```

校验规则（`validateRawConfig`，返回错误字符串数组，空=通过）：
- `default.brain` / `subagents.*.brain` 必须存在于 `llm.brain`（loadConfig 启动期 fail loud 同源）
- `global.supervision` / `mcp_servers.*.supervision` 必须是 `auto|confirm|manual`（修原 `SupervisionLevel[name]` 非法值静默变 undefined 的 bug）
- `sense_groups.*[]` 的 `:level` 后缀必须合法
- `llm.brain.*` 的 `model` / `provider` 必填

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

## 关键流程 / 数据流

### 配置加载（启动期，一次性）

```
loadConfig()
  ├─ resolve cheryDir = process.env.CHERY_DIR ?? process.cwd()
  ├─ readFileSync(.chery/config.yaml)  → 不存在则 process.exit(1)
  ├─ yaml.load → rawConfig
  ├─ replaceEnvVars(rawConfig)         → 递归整段 $ENV 替换，缺失收集到 missingEnvVars
  ├─ supervision: string → SupervisionLevel 枚举
  ├─ 补全 global.{skills_dir, senses_dir, system_prompt, db_dir}（cheryDir + .chery/...）
  ├─ server 默认值兜底（port 8182 / transport binary；web_port 已废弃，改 WEB_PORT 环境变量）
  └─ warn: CHERY_DIR 未配置 / 缺失环境变量
module 顶层 `const config = loadConfig()` → 全局单例，import 即触发
```

`.env` 加载：config.ts 在模块顶层用 `dotenv.config()` 读 `src/../.env`（tsx 开发）或 `dist/.env`（生产）。

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
