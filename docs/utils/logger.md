# Logger 统一日志

> 源码 [src/utils/logger/](../../src/utils/logger/) ｜ 上级 [./README.md](./README.md) ｜ 相关 [./drain.md](./drain.md) ｜ 配置 [./README.md#config](./README.md)

## 职责

cheryClaw 的**统一日志模块**，全项目唯一的日志出口。提供：

- **等级化日志**：`debug / info / warn / error / silent`，低于配置等级的调用静默丢弃。
- **多目标输出**：`console`（stdout/stderr）+ 按天滚动文件（`.chery/logs/YYYY-MM-DD.log`，可同时输出）。
- **两种格式**：`plain`（带时间戳 + 调用位置 `[file:line] [LEVEL] msg`）/ `json`（结构化字段）。
- **调用位置追踪**：通过 `Error.stack` 解析调用方 `文件名:行号`，自动跳过 logger 内部栈帧。
- **bash 子进程日志工具集**（`logger.tools`）：日志目录解析、日志路径生成、头部格式化、按保留时长清理旧日志、大小判定等 —— 供 `execute_command` 感官记录长跑命令输出。
- **通用文件日志工具集**（`logger.tools`）：tmpdir 下的目录缓存、大小判定、`WriteStream` 创建、按 `birthtime` 清理过期 `.log` 文件。

> ⚠ `.claude/CLAUDE.md` 将 logger 描述为 `bashLogger.ts` + `fileLogger.ts` 两文件分立，**与现状不符**。真实结构是单文件 [logger/index.ts](../../src/utils/logger/index.ts)，bash/文件工具都通过 `logger.tools` 命名空间暴露。本文档以源码为准。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [types.ts](../../src/utils/logger/types.ts) | `LogLevel` 枚举 + `InternalLoggerConfig` / `Logger` / `LoggerTools` / `BashLogInfo` interface；仅类型，依赖 config 的 `LoggerConfig` 类型 |
| [index.ts](../../src/utils/logger/index.ts) | `createLogger` 闭包工厂 + 默认 Proxy 实例 `logger`（延迟初始化）+ `initLogger` + 所有 bash/文件工具函数实现 |

## 核心概念 / 导出

### 配置来源与解析

日志配置来自 `.chery/config.yaml` 的 `global.logger`（[config.ts `LoggerConfig`](../../src/utils/config.ts#L86-L92)）：

```yaml
global:
  logger:
    level: info              # debug | info | warn | error | silent
    output: [file]           # (console | file)[]，可同时多处
    timestamp: true          # plain 格式下是否带时间戳
    location: true           # 是否带 [file:line] 调用位置
    format: plain            # plain | json
```

`loadLoggerConfig()` 把它解析成内部形态（[index.ts](../../src/utils/logger/index.ts#L49-L59)），缺省值：`level=info`、`output=["console"]`、`timestamp=true`、`location=true`、`format="plain"`。`level` 字符串经 `parseLogLevel` 转成 `LogLevel` 枚举（数值，便于比较）。

### 真实 TS 签名

```ts
// types.ts
enum LogLevel { debug = 0, info = 1, warn = 2, error = 3, silent = 4 }

interface InternalLoggerConfig {
  level: LogLevel;
  output: ("console" | "file")[];
  timestamp: boolean;
  location: boolean;
  format: "plain" | "json";
}

interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  write(message: string): void;     // 不带 level/timestamp，原样写 console+file（受 level>info 限制）
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  close(): void;
  getConfig(): InternalLoggerConfig;
  setConfig(config: Partial<ConfigLoggerConfig>): void;   // 运行时热更（output 新增 file 会延迟 init stream）
  tools: LoggerTools;
}

interface LoggerTools {
  // Bash 日志
  getBashLogDir(): string;                              // tmpdir/cheryClaw-bash-logs/
  createBashLogPath(pid: number, startTime: number): string;  // {startTime}-{pid}.log
  formatBashLogHeader(info: BashLogInfo): string;       // YAML frontmatter 头部
  cleanOldBashLogs(retentionHours: number): void;       // 删除超龄 .log
  // 通用文件日志
  getLogDirectory(name: string): string;                // tmpdir/{name}（带缓存）
  createLogFilePath(logDirName: string, filename: string): string;
  getLogSize(logPath: string): number;                  // stat 失败返回 0
  shouldShowPartialLog(logPath: string): boolean;       // size > 10KB 阈值
  getLogSizeThreshold(): number;                        // 10 * 1024
  formatLogSize(bytes: number): string;                 // B / KB / MB
  createLogStream(logPath: string): WriteStream;        // flags:"w"
  cleanOldLogFiles(logDirName: string, retentionHours: number): void;
}

interface BashLogInfo {
  pid: number;
  command: string;
  startTime: number;       // epoch ms
  logPath: string;
  description?: string;
  status: "running" | "completed" | "killed";
}
```

### 公开导出

```ts
// index.ts
export type { BashLogInfo } from "./types.js";
export function initLogger(config?: ConfigLoggerConfig): Logger;   // 显式初始化（由 config.ts 调用）
export const logger: Logger;   // Proxy 默认实例，延迟初始化，import 即可用
```

## 关键流程 / 数据流

### 延迟初始化 + Proxy 代理

```ts
// index.ts 末尾
let _logger: Logger | null = null;
function getLogger(): Logger {
  if (!_logger) _logger = createLogger();   // 用默认配置（console / info / plain）
  return _logger;
}
export const logger: Logger = new Proxy({} as Logger, {
  get(_target, prop) { return Reflect.get(getLogger(), prop); },
});
```

任何模块 `import { logger }` 即拿到这个 Proxy，**首次访问属性**时才真正 `createLogger()`。`initLogger(config)` 由 [config.ts 加载流程](./README.md#关键流程--数据流) 之外的地方显式调用以注入 yaml 配置（若不调用，logger 仍可用，只是走默认配置）。

### createLogger 闭包结构

`createLogger(config?)` 用闭包持有 `_config` 与 `_fileStream`（[index.ts](../../src/utils/logger/index.ts#L69-L205)），返回 Logger 对象：

- **`initFileStream()`**：若 `output` 含 `file`，在 `cheryDir/.chery/logs/` 下建 `YYYY-MM-DD.log` 的 append 流（`dayjs().format("YYYY-MM-DD")`）。cheryDir 取 `process.env.CHERY_DIR ?? process.cwd()`。
- **`getLocation()`**：`new Error().stack` 切行，跳过含 `utils/logger` 的内部栈帧，正则 `/at\s+(?:.*?\s+\()?(.+):(\d+):(\d+)\)?/` 抓首个外部帧，返回 `basename:line`，全部失败返回 `"unknown"`。
- **`format(levelName, args)`**：
  - 参数序列化：字符串原样；`Error` 取 `stack ?? message`；其他 `JSON.stringify(arg, null, 2)`，失败回落 `String(arg)`；最后 `join(" ")`。
  - `json` 格式：`{ level, timestamp, location?, message }` → `JSON.stringify`。
  - `plain` 格式：可选 `[timestamp]` + `[location]` + `[LEVEL]` + message，`join(" ")`。
- **`output(level, levelName, args)`**：`if (_config.level > level) return`；格式化后按 `output` 写 console（`level >= error` 走 stderr，否则 stdout）+ file stream。
- **`write(message)`**：不走 `format`，直接写（受 `level > info` 限制）。
- **`setConfig(patch)`**：合并配置重新解析；若 `patch.output` 含 `file` 且当前无 stream，延迟 `initFileStream()`。

### 一次日志调用数据流

```
某模块 logger.info("xxx", obj)
  └─ logger Proxy → getLogger()（首次时 createLogger）
       └─ Logger.info(...args) → output(LogLevel.info, "INFO", args)
            ├─ if config.level > info: return（静默）
            ├─ format("INFO", args)
            │    ├─ 序列化 args（string/Error/JSON）
            │    ├─ getLocation()（Error.stack 解析外部调用位置）
            │    └─ plain: [ts] [file:line] [INFO] msg  /  json: {level,ts,location,message}
            ├─ if output 含 console: stdout.write(formatted + "\n")
            └─ if _fileStream: _fileStream.write(formatted + "\n")
```

### bash 日志生命周期（被 `execute_command` 感官消费）

`agent/sense/bash.ts` 在命令**超时进入后台**时（[bash.ts](../../src/agent/sense/bash.ts)）：

```
1. logger.tools.cleanOldBashLogs(LOG_RETENTION_HOURS)     // 启动前清理（config.global.bash_log_retention_hours ?? 24）
2. const logPath = logger.tools.createBashLogPath(startTime, endTime)  // tmpdir/cheryClaw-bash-logs/{endTime}-{pid}.log
3. const header  = logger.tools.formatBashLogHeader(logInfo)            // YAML frontmatter（pid/command/startTime/status/description）
4. writeFileSync(logPath, header + outputBuffer)                        // 落盘已累积的 stdout+stderr
5. 后续 read_file 感官按 logPath 读取详情
```

清理逻辑（[index.ts `cleanOldLogFiles`](../../src/utils/logger/index.ts#L333-L357)）：遍历目录下 `.log` 文件，按 `statSync().birthtimeMs` 早于 `now - retentionMs` 的 `unlinkSync`，单个文件失败静默跳过（防并发删除）。`getLogDirectory(name)` 带 `Map` 缓存，避免重复 `existsSync`/`mkdirSync`。

## 依赖与关联 ⭐

### 内部依赖

| 源 | 目标 | 性质 |
|----|------|------|
| [index.ts](../../src/utils/logger/index.ts) | `@/utils/config.js`（`LoggerConfig` 类型） | 仅类型 import（运行时无环：config.ts 不反向 import logger） |
| [index.ts](../../src/utils/logger/index.ts) | `fs` / `path` / `os` / `dayjs` | runtime：文件流、目录、日期格式化 |
| [types.ts](../../src/utils/logger/types.ts) | `@/utils/config.js`（`LoggerConfig` 类型） | 仅类型 |

### 被依赖（全项目几乎所有非纯算法模块）

| 层 | 模块 |
|----|------|
| **agent** | `middleware/{chat,checkpointState,loop,retry,tool}`、`provider/{mock,ollama}`、`sense/{bash,compileToolsReporter,index,processRegistry}`、`prompt/loadSkill` |
| **core** | `middleware/index` |
| **service** | `chat/{send,streamMapper}`、`message/router`、`websocket/{connection,index}` |
| **utils** | [`drain/drainBase.ts`](./drain.md)（`printTree` 默认走 `logger.info`）、[`rateLimiter.ts`](./README.md#ratelimiter)（限流等待时 `logger.info`） |
| **入口/Web** | `index.ts`、`web/server` |

> logger 是 cheryClaw 事实上的**全局副作用出口**：算法层（drain、rateLimiter）也依赖它打诊断信息。这意味着 logger 自身必须保持零业务依赖（仅类型依赖 config），否则会成环。

### 横切参考

- 配置真实样例（含 `global.logger`）：[.chery/config.yaml](../../.chery/config.yaml#L80-L88)
- `execute_command` 感官如何用 `logger.tools`：[../../src/agent/sense/bash.ts](../../src/agent/sense/bash.ts)
- `read_file` 感官如何读取 bash 落盘的日志（`shouldShowPartialLog` / `getLogSize` 判定大小后决定截断/drain）：[../../src/agent/sense/read.ts](../../src/agent/sense/read.ts)
- config.ts 的 `LoggerConfig` 类型与全局配置加载：[./README.md#config](./README.md)
- drain 模块对 logger 的使用（打印 prefix tree）：[./drain.md](./drain.md)

## 扩展点

### 运行时改配置

`logger.setConfig({ level: "debug", output: ["console", "file"] })` 可热更 —— 例如排障时临时拉到 debug。注意：`output` 新增 `"file"` 会触发延迟 `initFileStream()`（按当天日期建文件）；缩减则旧 stream 不会自动关闭，需手动 `logger.close()`。

### 日志文件滚动

当前按天滚动：文件名 `YYYY-MM-DD.log`，append 模式（`flags: "a"`）。**不会自动删除旧日志文件**（logger 自身不持有清理逻辑）；清理 bash/通用文件日志走 `logger.tools.cleanOld*Logs(retentionHours)`，需调用方主动触发（`execute_command` 在每次执行前清理一次，保留期由 `config.global.bash_log_retention_hours` 控制，默认 24h）。

### 新增输出目标（loki/elasticsearch 等）

`output()` 函数（[index.ts](../../src/utils/logger/index.ts#L141-L154)）当前只分支 `console` 与 `_fileStream`。新增需：

1. `LoggerConfig.output` 联合类型加新值（在 [config.ts](../../src/utils/config.ts#L86-L92)）。
2. `InternalLoggerConfig.output` 同步（[types.ts](../../src/utils/logger/types.ts)）。
3. `loadLoggerConfig` 默认值与解析。
4. `createLogger` 内初始化对应客户端，`output()` 加分支。
5. `close()` 释放资源。

### 自定义 bash 日志目录

`BASH_LOG_DIR_NAME = "cheryClaw-bash-logs"`（[index.ts](../../src/utils/logger/index.ts#L242)）是常量，落在 `os.tmpdir()` 下。若要换路径（如挂载持久卷），改该常量或新增 `getLogDirectory` 参数；当前通过 `logDirCache` 缓存，同一 `name` 只解析一次。

### 已知局限（待确认）

- **位置追踪靠 `Error.stack`**：性能开销大且依赖 V8 栈格式。生产环境若关 `location: false` 可省开销。
- **`write(message)`** 与 `info` 等级共用 `level > info` 限制：意味着 `level` 设为 `warn`/`error` 时，`write` 也会被静默（**待确认**是否符合设计意图，可能影响直接写流式输出的场景）。
- **`_fileStream` 单例**：一个 logger 实例只持有一个文件流（当天日期）；跨天运行不会自动切到新文件（进程长跑场景**待确认**是否需定时重开流）。
