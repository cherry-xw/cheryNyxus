# Agent Sense（内置感官与重载）

> 源码 [src/agent/sense/](../../src/agent/sense/) ｜ 上级 [agent](./README.md) ｜ 相关 [./middleware.md](./middleware.md)（sense 中间件）

## 职责

定义并注册**内置感官**（execute_command / read_file / write_file / skill / search_codebase），管理 bash 子进程生命周期，重载全局 sense registry（内置 + 编译产物），并为 `compile-senses` 子命令提供自测与报告。

> 命名澄清：CLAUDE.md 中的 `execute_skill` 是历史名，**实际 sense 函数名是 `skill`**（[skill.ts](../../src/agent/sense/skill.ts) 第一参数）；bash 感官名是 `execute_command`，不是 `bash`（bash.ts 是文件名）。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [index.ts](../../src/agent/sense/index.ts) | `reloadSenses()`：reset + 注册内置 + 加载编译产物；`runSenseTests()` 自测执行 |
| [bash.ts](../../src/agent/sense/bash.ts) | `execute_command` 感官（manual）：spawn detached 进程组，超时转后台，结果 30 行截取 |
| [read.ts](../../src/agent/sense/read.ts) | `read_file` 感官（auto）：大文件策略（truncate/drain/none）+ hash 含 mtime + 写 sharedData |
| [write.ts](../../src/agent/sense/write.ts) | `write_file` 感官（manual）：临时文件 + rename，行范围替换，写前修改检测 |
| [skill.ts](../../src/agent/sense/skill.ts) | `skill` 感官（auto）：实时读取 SKILL.md 完整指令 |
| [search.ts](../../src/agent/sense/search.ts) | `search_codebase` 感官（auto）：fff FileFinder 单例，content(grep)/filename(fileSearch) 双模式 |
| [processRegistry.ts](../../src/agent/sense/processRegistry.ts) | bash 子进程注册表（chatId→pid），进程组 kill；chatId 来自 SenseRuntimeContext |
| [compileToolsReporter.ts](../../src/agent/sense/compileToolsReporter.ts) | `compile-senses` 子命令的报告输出（编译/测试表格 + 失败详情） |

## 核心概念 / 导出

### 内置感官注册表

| sense 函数名 | 文件 | 监管等级 | schema 关键字段 |
|--------------|------|----------|-----------------|
| `execute_command` | [bash.ts](../../src/agent/sense/bash.ts) | manual | `command`、`description` |
| `read_file` | [read.ts](../../src/agent/sense/read.ts) | auto | `path`、`limit?`、`offset?`、`compression?` |
| `write_file` | [write.ts](../../src/agent/sense/write.ts) | manual | `path`、`content`、`offset?`、`limit?` |
| `skill` | [skill.ts](../../src/agent/sense/skill.ts) | auto | `name` |
| `search_codebase` | [search.ts](../../src/agent/sense/search.ts) | auto | `mode?`、`query`、`regex?`、`maxResults?`、`contextLines?` |
| `generate_image` | [media.ts](../../src/agent/sense/media.ts) | smart | `prompt` |
| `generate_video` | [media.ts](../../src/agent/sense/media.ts) | smart | `prompt` |
| `generate_audio` | [media.ts](../../src/agent/sense/media.ts) | smart | `prompt` |

> ⚠ sense **函数名**（首参数）才是注册 key，与文件名无关。bash.ts → "execute_command"、skill.ts → "skill"。

三个 `generate_*` sense 统一调用 `media.<kind>` 网关，将其返回的 base64 资产保存至 `.chery/media/` 并返回受控读取 URL。它们虽在 registry 中注册，但仅当前 brain 的 `capabilities.generate.<kind>=true` 才会被 RuntimeResolver 注入模型。详见 [../model-capabilities.md](../model-capabilities.md)。

### 监管等级（[core/config.ts](../../src/core/config.ts)）

```ts
export enum SupervisionLevel { auto = 0, smart = 1, manual = 2 }
```

| 等级 | 行为 |
|------|------|
| auto (0) | 直接执行，无需审批 |
| smart (1) | 等待客户端审批（`sense.approval`）后执行 |
| manual (2) | 禁止自动执行，仅手动触发 |

**优先级链**（实际生效的等级）：感官组 `:level` 后缀覆盖 > 前组已解析 > **感官内置声明（本表）** > `global.supervision`。感官内置声明是**默认值**，可被 sense_groups 配置覆盖（如 `read_file:smart`）。详见 [agent/README.md RuntimeResolver](./README.md)。

### reloadSenses（[index.ts](../../src/agent/sense/index.ts)）

```ts
export async function reloadSenses(): Promise<void> {
  resetSenses();              // 清空全局 senseRegistry
  registerBuiltinSenses();    // registerSenses([bash, read, write, skill])
  await loadCustomSenses();   // 从 senses/*.js 编译产物加载（new Function 执行）
}
```

由 [bootstrap.ts](../../src/agent/bootstrap.ts) 启动期调用，`compile-senses` 子命令结束后也会再次调用。

### 编译产物加载（[index.ts loadCustomSenses](../../src/agent/sense/index.ts)）

```ts
const runtimeContext = { z, sense, SupervisionLevel, registerSenses };

// 遍历 dist/senses/*.js（实际路径相对 import.meta.url）
const fn = new Function("z", "sense", "SupervisionLevel", "registerSenses", pureCode);
const result = fn(runtimeContext.z, runtimeContext.sense, runtimeContext.SupervisionLevel, runtimeContext.registerSenses);
if (result?.definition?.function?.name) {
  registerSenses([result]);   // 编译产物 return 一个 Sense 实例
}
```

> 移除 `// hash:xxx` 注释行后执行。编译机制本身见 [core/sense/compiler](../../src/core/sense/compiler/)。

## 关键流程

### A. execute_command（[bash.ts](../../src/agent/sense/bash.ts)）

```text
input { command, description }
  ├─ cleanOldBashLogs（按 LOG_RETENTION_HOURS 清理）
  ├─ senseCtx?.chatId → chatId（tool.ts doExecuteSense 第 3 参注入）
  ├─ spawn(command, [], { shell:true, detached:true })   ← 新进程组
  ├─ registerBashProcess(chatId, proc, meta)             ← 进注册表
  │
  ├─ stdout/stderr 实时累积 outputBuffer
  │
  ├─ 超时（DEFAULT_TIMEOUT，sense_execute_timeout）：
  │    ├─ 创建日志文件（formatBashLogHeader + outputBuffer）
  │    ├─ resolve({ status:"timeout", ..., message:"进程进入后台运行" })
  │    └─ ⚠ 进程不杀，留在注册表（挂起保留语义）
  │
  └─ close/error：
       ├─ unregisterBashProcess(chatId, pid)             ← 统一在此注销
       └─ resolve({ status:"success"|"error", exitCode, output })
```

**输出截取（[bash.ts formatBashResult](../../src/agent/sense/bash.ts)）：** output 超 30 行显示前 15 + 后 15，中间「省略 N 行」。结果含 `pid` / `exitCode` / `duration` / `logPath`（超时时）。

### B. read_file（[read.ts](../../src/agent/sense/read.ts)）

```text
input { path, limit?, offset?, compression }
  ├─ path.isAbsolute 校验（支持跨平台）
  ├─ stat + readFile
  ├─ 压缩策略决策（compression:"auto" 时）：
  │     size <= truncate_threshold            → none
  │     else isLogFile（按 log_file_extensions）→ drain（Drain 算法去重）
  │     else                                   → truncate（截断头部）
  ├─ 应用 truncate / drain（drain 失败回退 truncate）
  ├─ 切行 + offset/limit 选取 + 行号格式化（"N\t内容"）
  └─ 生成 hash：
       hash        = hashGenerator("file", path, size, mtimeMs, offset, limit, strategy)  ← 完整 hash（含读取参数，历史去重）
       fileHash    = hashGenerator("file", path, size, mtimeMs)                          ← 基础 hash（写入 sharedData 供 write 修改检测）
       sharedData["read_file"][path] = fileHash
```

**两个 hash 的分工：**

- **完整 hash（返回值）**：含 offset/limit/strategy，被 [tool.ts doExecuteSense](../../src/agent/middleware/tool.ts) 用于历史 sense 消息去重——同 hash 命中时旧消息被替换为短说明。
- **基础 hash（写入 sharedData）**：仅含 path/size/mtimeMs，被 [write.ts](../../src/agent/sense/write.ts) 用于写前检测——write 时对比当前文件基础 hash 与读取时存的，不同 = 被外部改动，需重新读取。

> **hash 必须含 mtime：** 它是「内容是否变动」的关键判据，去掉会让等长改写误判为相同。

### C. write_file（[write.ts](../../src/agent/sense/write.ts)）

```text
input { path, content, offset?, limit? }
  ├─ 三种调用模式（由 offset/limit 是否同时传决定）：
  │     ① 全量写入（不传 offset/limit）：content=完整文件内容，已存在则整体覆盖
  │     ② 行范围替换（同时传）：须先 read_file；从 offset 行起替换 limit 行；limit=0 纯插入
  │     ③ 追加末尾：offset=总行数、limit=0
  ├─ offset/limit 必须同时给或不给（违例报错并提示全量/追加写法）
  ├─ 写前修改检测（storedHash = sharedData["read_file"][path]）：
  │     ├─ 存在 storedHash：算当前文件基础 hash，不同 → 返回「文件修改警告，需重新读取」
  │     │   文件不存在（ENOENT）：行范围写入则报错，否则继续（新建）
  │     └─ 无 storedHash 但行范围写入：提示「需先 read_file」
  ├─ 确定最终内容：
  │     行范围模式 → replaceLines(原内容, 新内容, offset, limit)
  │     完整写入   → input.content
  ├─ 写临时文件 os.tmpdir()/${Date.now()}-${filename}
  ├─ rename(tmp, target)
  │     └─ EXDEV（跨文件系统）→ copyFile + unlink 兜底
  └─ 返回「成功写入/替换 N-M 行」（hash 恒为空，write 不参与去重）
```

**写前修改检测的意义：** 防止 LLM 基于过期读取内容覆盖外部改动——必须先 read_file 拿到最新 hash，write 时验证未变才允许写。

### D. skill（[skill.ts](../../src/agent/sense/skill.ts)）

```text
input { name }
  ├─ getSkillRealtime(name) → { skill, size, mtimeMs }（实时读取，无缓存）
  ├─ 未找到 → 返回 "Error: skill "{name}" not found"
  ├─ hash = hashGenerator("skill", name, size, mtimeMs)
  └─ content = `"{name}"技能已激活。以下是完整指令...{skill.content}`
```

**hash 基于 size + mtimeMs**：内容变化时 hash 也变化，触发 [tool.ts doExecuteSense](../../src/agent/middleware/tool.ts) 去重逻辑失效（新旧内容 hash 不同 → 各自独立留存，LLM 自行对比）。

### E. search_codebase（[search.ts](../../src/agent/sense/search.ts)）

```text
input { mode, query, regex?, maxResults?, contextLines? }
  ├─ getFinder() → 模块级 FileFinder 单例（首次：create({basePath:cwd, aiMode}) + waitForScan(10s)）
  │   └─ 不可用 → 返回「索引未就绪」错误（hash 空）
  ├─ mode="filename" → finder.fileSearch(query, {pageSize})
  │   └─ 格式化：每条 relativePath [gitStatus]，头部汇总 totalMatched/totalFiles
  └─ mode="content"(默认) → finder.grep(query, {mode, pageSize, before/afterContext, timeBudgetMs:8000})
      ├─ query 约束语法：'*.ts TODO' / 'src/ TODO'
      ├─ regex=true → mode:"regex"，否则 "plain"
      ├─ contextLines>0 → 上下文行带行号缩进
      └─ 格式化：每条 relativePath:lineNumber: lineContent，nextCursor 非空时附「仍有更多」
```

**finder 单例 + hash 恒空：** fff 内置实时 watcher，扫描后自动跟进变更，单例 Promise 缓存（失败也缓存 null 避免重试）。搜索结果依赖实时索引（非确定性），故 `hash: ""`（同 bash 不参与历史去重）。fff 是 ffi-rs 加载的原生 `.so`，**必须从 vite SSR 构建外置**（`ssr.external`）——打包会破坏 `findBinary()` 的 `import.meta.url` 平台包解析（pnpm 未提升 `@ff-labs/fff-bin-*` 到项目根）。

### F. bash 进程注册表（[processRegistry.ts](../../src/agent/sense/processRegistry.ts)）

```text
chatId → (pid → BashProcessRecord)
              └─ { pid, proc, command, description, startedAt, killed }
```

**三条生命周期规则（[processRegistry.ts 文件注释](../../src/agent/sense/processRegistry.ts)）：**

| 事件 | 处理 |
|------|------|
| 进程结束（close/error） | 清除（bash.ts 的 close handler 调 unregister） |
| 超时挂起 | **保留**（超时不杀，注册项留在表中待手动管理） |
| 显式 kill | 清除（kill → 进程退出 → close handler 统一 unregister） |

**对外 API：**

| 函数 | 调用方 | 用途 |
|------|--------|------|
| `registerBashProcess(chatId, proc, meta)` | [bash.ts](../../src/agent/sense/bash.ts) | spawn 后注册 |
| `unregisterBashProcess(chatId, pid)` | [bash.ts](../../src/agent/sense/bash.ts) | close/error 后注销 |
| `killBashProcess(chatId, pid)` | service `bash.kill` RPC | `process.kill(-pid, SIGTERM)` 杀整个进程组 |
| `listBashProcesses(chatId)` | service `bash.list` RPC | 返回 BashProcessEntry[]（不含 ChildProcess 句柄） |

**进程组 kill 的必要性：** spawn 时 `detached:true` 使子进程成为进程组组长，`kill(-pid)` 终止整个进程组——避免 `sh -c` 的孙子进程泄漏。`-pid` 失败时（进程组已不存在）兜底 `entry.proc.kill()`。

**chatId 注入机制（[processRegistry.ts 文件注释](../../src/agent/sense/processRegistry.ts)）：** sense executor 支持可选第 3 参 `SenseRuntimeContext`。由 [tool.ts doExecuteSense](../../src/agent/middleware/tool.ts) 调 `execute(args, sharedData, { chatId })` 时注入，bash executor 读取 `senseCtx?.chatId`。测试场景（无 ctx）为 undefined → register 跳过，执行不受影响。

## 依赖与关联 ⭐

### 依赖

| 依赖 | 用途 |
|------|------|
| [core/sense](../../src/core/sense/) | `sense()` 工厂、`Sense`/`SenseResult`/`SenseSharedData`、`registerSenses/resetSenses` |
| [core/config](../../src/core/config.ts) | `SupervisionLevel` |
| [core/sense/compiler/types](../../src/core/sense/compiler/types.ts) | `TestCase`（自测） |
| [core/sense/compiler/index](../../src/core/sense/compiler/index.ts) | `CompiledSenseInfo`/`SenseCompileSummary`（compileToolsReporter） |
| [core/message/adapter](../../src/core/message/adapter.ts) | `ReplaceInfo`（[index.ts TestResultDetail](../../src/agent/sense/index.ts) 间接，retry/read 等） |
| [agent/prompt/loadSkill](../../src/agent/prompt/loadSkill.ts) | `getSkillRealtime`（[skill.ts](../../src/agent/sense/skill.ts)） |
| [utils/config](../../src/utils/config.ts) | `config.global` 各项（sense_execute_timeout、bash_log_retention_hours、file_compression、skills_dir） |
| [utils/hash](../../src/utils/hash.ts) | `hashGenerator`（read/write/skill） |
| [utils/drain](../../src/utils/drain/) | `compressLog`（read_file 大日志去重） |
| [utils/logger](../../src/utils/logger/) | `logger`、`logger.tools.*`（bash 日志：createBashLogPath/formatBashLogHeader/cleanOldBashLogs、`BashLogInfo` 类型） |
| 第三方 | `zod`、`@ff-labs/fff-node`（[search.ts](../../src/agent/sense/search.ts)）、`child_process`、`fs`/`fs/promises`、`os`/`path`、`url` |

### 被依赖

| 调用方 | 用途 |
|--------|------|
| [agent/bootstrap.ts](../../src/agent/bootstrap.ts) | `reloadSenses()`（启动期） |
| [agent/middleware/tool.ts](../../src/agent/middleware/tool.ts) | doExecuteSense 调 executor 第 3 参注入 `{ chatId }` |
| [src/index.ts](../../src/index.ts) | `compile-senses` 子命令用 `reportSenseCompileResult`/`runSenseTestsAndCollect` |
| service `bash.list` / `bash.kill` RPC | `listBashProcesses`/`killBashProcess` |

### 横切参考

- [./middleware.md](./middleware.md) — sense 中间件如何调 `senseTable.get(name).execute(args, sharedData)`，以及历史 hash 替换逻辑
- [./prompt.md](./prompt.md) — skill 感官消费 `getSkillRealtime` 的 size/mtimeMs
- [core/sense/compiler](../../src/core/sense/compiler/) — 外部 sense 的编译机制（loadCustomSenses 加载其产物）

## 扩展点

### 添加内置 Sense

1. 在 [sense/](../../src/agent/sense/) 新增 `<name>.ts`，用 [sense()](../../src/core/sense/senseCreator.ts) 工厂创建：

   ```ts
   import { z } from "zod";
   import { sense, type SenseResult, type SenseSharedData } from "@/core/sense";
   import { SupervisionLevel } from "@/core/config";

   const Schema = z.object({ /* ... */ });

   export default sense(
     "my_sense",                       // ← sense 函数名（注册 key）
     "一句话描述（注入 LLM 的 function.description）",
     Schema,
     async (input, sharedData, senseCtx): Promise<SenseResult> => {
       // 执行逻辑；返回 { content, hash }
       return { content: "结果", hash: "" };   // hash 非空才会触发历史去重
     },
     SupervisionLevel.smart,         // ← 默认监管等级（可被 sense_groups 覆盖）
   );
   ```

2. 在 [index.ts](../../src/agent/sense/index.ts) 导入并在 `registerBuiltinSenses()` 中 `registerSenses([...])`：

   ```ts
   import mySense from "./my";
   function registerBuiltinSenses(): void {
     registerSenses([bashSense, readSense, writeSense, skillSense, mySense]);
   }
   ```

3. 在 `config.yaml` 的 `sense_groups` 中引用 `my_sense`（可选加 `:level` 覆盖监管等级）。

### 添加外部（编译产物）Sense

1. 在 `.chery/senses/<name>.ts` 创建文件（系统自动注入 `zod`/`sense`/`SupervisionLevel`/`registerSenses` 导入）。
2. 运行 `compile-senses` 子命令编译到 `senses/<name>.js`。
3. 启动时 `loadCustomSenses` 用 `new Function()` 执行编译产物并注册。
4. 在 `config.yaml` 的 `sense_groups` 中引用。

> 编译细节见 [core/sense/compiler](../../src/core/sense/compiler/)。

### Sense 实现要点

- **hash 字段语义：** 返回 `hash` 非空时，[tool.ts doExecuteSense](../../src/agent/middleware/tool.ts) 会扫描历史 sense 消息，hash 命中则把旧消息替换为短说明。若不希望参与去重，返回 `hash: ""`。
- **sharedData 命名空间约定：** 跨感官共享数据按 namespace 存（如 `sharedData.get("read_file")`）。chatId 不占用 sharedData namespace，而是通过 executor 第三参 `senseCtx?.chatId` 传入。
- **executor 签名：** `(args, sharedData, senseCtx?)`。需要 chatId 时读 `senseCtx?.chatId`（[tool.ts](../../src/agent/middleware/tool.ts) 已在 execute 时注入）。
- **错误处理：** 抛异常会被 [tool.ts doExecuteSense](../../src/agent/middleware/tool.ts) 的 try-catch 转成 `Sense execution failed: ...` content 返回（不传播到 middleware）；建议业务错误也返回 `{ content: "错误说明", hash: "" }` 而非抛。
