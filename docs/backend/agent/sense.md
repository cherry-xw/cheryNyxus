# Agent Sense（内置感官与重载）

> 源码 [apps/backend/src/agent/sense/](../../../apps/backend/src/agent/sense) ｜ 上级 [agent](README.md) ｜ 相关 [./middleware.md](middleware.md)（sense 中间件）

## 职责

定义并注册**内置感官**（execute_command / read_file / write_file / skill / search_codebase），管理 bash 子进程生命周期，重载全局 sense registry（内置 + 编译产物），并为 `compile-senses` 子命令提供自测与报告。

> 命名澄清：CLAUDE.md 中的 `execute_skill` 是历史名，**实际 sense 函数名是 `skill`**（[skill.ts](../../../apps/backend/src/agent/sense/skill.ts) 第一参数）；bash 感官名是 `execute_command`，不是 `bash`（bash.ts 是文件名）。

## 受管小应用工具

`managed_app` 以 `action` 提供 create、exec、task_status、task_cancel、publish、stop、delete、renew、status、backup。stop 保留持久数据；delete 仅在用户明确要求时彻底清理本人指定应用，拒绝活动任务，不删除公共镜像或其他用户项目。create 必须同时提供 appId 与 title；appId 为 3–32 位小写字母、数字或连字符，首尾不能为连字符，后续操作复用该 ID。缺参返回可修正的 INVALID_INPUT，不代表授权拒绝。身份与不可放宽权限见[角色安全](role-security.md#受管请求)。注册入口是 `agent/sense/index.ts`，执行入口是 `agent/sense/managedApp.ts`，控制器通信使用 `service/managedApp/socketRpc.ts`。项目文件可以通过 exec 调用容器内 Node 标准库编辑，不把通用文件工具指向 Backend 挂载目录。

受管命令的进程隔离由宿主控制器负责；不允许依靠任务可修改的环境变量确定清理范围。当前隔离实现仍在验证中，未通过独立审查前不得启用模型命令入口。验证必须覆盖清空环境、后台派生、脱离进程组，以及任务主动修改父进程死亡信号的情况。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [index.ts](../../../apps/backend/src/agent/sense/index.ts) | `reloadSenses()`：reset + 注册内置 + 加载编译产物；`runSenseTests()` 自测执行 |
| [bash.ts](../../../apps/backend/src/agent/sense/bash.ts) | `execute_command` 感官（manual）：spawn detached 进程组，超时转后台，结果 30 行截取 |
| [read.ts](../../../apps/backend/src/agent/sense/read.ts) | `read_file` 感官（auto）：大文件策略（truncate/drain/none）+ hash 含 mtime + 写 sharedData |
| [write.ts](../../../apps/backend/src/agent/sense/write.ts) | `write_file` 感官（manual）：临时文件 + rename，行范围替换，写前修改检测 |
| [skill.ts](../../../apps/backend/src/agent/sense/skill.ts) | `skill` 感官（auto）：实时读取 SKILL.md 完整指令 |
| [search.ts](../../../apps/backend/src/agent/sense/search.ts) | `search_codebase` 感官（auto）：fff FileFinder 单例，content(grep)/filename(fileSearch) 双模式 |
| [apps/web/fetch.ts](../../../apps/backend/src/agent/sense/web/fetch.ts) | `web_fetch` 感官（smart）：公开 HTTP(S) 读取、逐跳 SSRF 校验、大小/类型/正文清洗限制 |
| [processRegistry.ts](../../../apps/backend/src/agent/sense/processRegistry.ts) | bash 子进程注册表（chatId→pid），进程组 kill；chatId 来自 SenseRuntimeContext |
| [compileToolsReporter.ts](../../../apps/backend/src/agent/sense/compileToolsReporter.ts) | `compile-senses` 子命令的报告输出（编译/测试表格 + 失败详情） |

## 核心概念 / 导出

### 内置感官注册表

| sense 函数名 | 文件 | 监管等级 | schema 关键字段 |
|--------------|------|----------|-----------------|
| `execute_command` | [bash.ts](../../../apps/backend/src/agent/sense/bash.ts) | smart | `shell`、`command`、`description`、可选 `workdir` |
| `read_file` | [read.ts](../../../apps/backend/src/agent/sense/read.ts) | auto | `path`、`limit?`、`offset?`、`compression?` |
| `write_file` | [write.ts](../../../apps/backend/src/agent/sense/write.ts) | manual | `path`、`content`、`offset?`、`limit?` |
| `skill` | [skill.ts](../../../apps/backend/src/agent/sense/skill.ts) | auto | `name` |
| `search_codebase` | [search.ts](../../../apps/backend/src/agent/sense/search.ts) | auto | `mode?`、`query`、`regex?`、`maxResults?`、`contextLines?` |
| `web_fetch` | [apps/web/fetch.ts](../../../apps/backend/src/agent/sense/web/fetch.ts) | smart | `url`、`max_output_chars?` |

> ⚠ sense **函数名**（首参数）才是注册 key，与文件名无关。bash.ts → "execute_command"、skill.ts → "skill"。

文件生成通过文件服务、自定义工具或 MCP 执行；自定义 sense 位于 `.chery/senses/`，工具声明 `capabilities.produces` / `accepts` / `preprocess`。详见 [模型能力](model-capabilities.md) 与 [感官手册](../../../apps/backend/.chery.template/docs/senses.md)。

### 监管等级（[core/config.ts](../../../apps/backend/src/core/config.ts)）

```ts
export enum SupervisionLevel { auto = 0, smart = 1, manual = 2 }
```

| 等级 | 行为 |
|------|------|
| auto (0) | 直接执行，无需审批 |
| smart (1) | 等待客户端审批（`sense.approval`）后执行 |
| manual (2) | 禁止自动执行，仅手动触发 |

**优先级链**（实际生效的等级）：感官组 `:level` 后缀覆盖 > 前组已解析 > **感官内置声明（本表）** > `global.supervision`。感官内置声明是**默认值**，可被 sense_groups 配置覆盖（如 `read_file:smart`）。详见 [agent/README.md RuntimeResolver](README.md)。

### reloadSenses（[index.ts](../../../apps/backend/src/agent/sense/index.ts)）

```ts
export async function reloadSenses(): Promise<void> {
  resetSenses();              // 清空全局 senseRegistry
  registerBuiltinSenses();    // registerSenses([bash, read, write, skill])
  await loadCustomSenses();   // 从 senses/*.js 编译产物加载（new Function 执行）
}
```

由 [bootstrap.ts](../../../apps/backend/src/agent/bootstrap.ts) 启动期调用，`compile-senses` 子命令结束后也会再次调用。

### 编译产物加载（[index.ts loadCustomSenses](../../../apps/backend/src/agent/sense/index.ts)）

```ts
const runtimeContext = { z, sense, SupervisionLevel, registerSenses };

// 遍历 dist/senses/*.js（实际路径相对 import.meta.url）
const result = loadCompiledSense(filePath); // 去 hash + new Function + 注入统一运行时上下文
registerSenses([result]);                    // 编译产物 return 一个 Sense 实例
```

> `compile-senses` 的自测与启动期注册复用同一个 `loadCompiledSense()`，避免 ESM dynamic import 与 `new Function` 使用不同协议。编译机制本身见 [core/sense/compiler](../../../apps/backend/src/core/sense/compiler)。

## 关键流程

### A. execute_command（[bash.ts](../../../apps/backend/src/agent/sense/bash.ts)）

```text
input { shell: 'bash' | 'powershell', command, description, workdir? }
  ├─ cleanOldBashLogs（按 LOG_RETENTION_HOURS 清理）
  ├─ senseCtx?.chatId → chatId（tool.ts doExecuteSense 第 3 参注入）
  ├─ spawn(command, [], { shell:true, detached:true, windowsHide:true })   ← 新进程组（Windows 不弹 cmd 窗）
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

**输出截取（[bash.ts formatBashResult](../../../apps/backend/src/agent/sense/bash.ts)）：** output 超 30 行显示前 15 + 后 15，中间「省略 N 行」。结果含 `pid` / `exitCode` / `duration` / `logPath`（超时时）。

**shell 方言解析（[sandbox.ts](../../../apps/backend/src/core/security/sandbox.ts)）：** `powershell` 走 pwsh → legacy `powershell.exe` 降级链；`bash` 在 win32 下经 `resolvePosixShell()` 探测链解析（PATH bash → PATH sh → git 反查 → 常见路径，详见 [agent/hooks.md](hooks.md) 跨平台执行），非 win32 直接 `bash -lc`。解析失败返回错误说明（fail-soft：错误作为 sense 结果回给 AI，AI 可改用 powershell 方言重试）。

### B. read_file（[read.ts](../../../apps/backend/src/agent/sense/read.ts)）

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

- **完整 hash（返回值）**：含 offset/limit/strategy，被 [tool.ts doExecuteSense](../../../apps/backend/src/agent/middleware/tool.ts) 用于历史 sense 消息去重——同 hash 命中时旧消息被替换为短说明。
- **基础 hash（写入 sharedData）**：仅含 path/size/mtimeMs，被 [write.ts](../../../apps/backend/src/agent/sense/write.ts) 用于写前检测——write 时对比当前文件基础 hash 与读取时存的，不同 = 被外部改动，需重新读取。

> **hash 必须含 mtime：** 它是「内容是否变动」的关键判据，去掉会让等长改写误判为相同。

### C. write_file（[write.ts](../../../apps/backend/src/agent/sense/write.ts)）

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

### D. skill（[skill.ts](../../../apps/backend/src/agent/sense/skill.ts)）

```text
input { name }
  ├─ getSkillRealtime(name) → { skill, size, mtimeMs }（实时读取，无缓存）
  ├─ 未找到 → 返回 "Error: skill "{name}" not found"
  ├─ hash = hashGenerator("skill", name, size, mtimeMs)
  └─ content = `"{name}"技能已激活。以下是完整指令...{skill.content}`
```

**hash 基于 size + mtimeMs**：内容变化时 hash 也变化，触发 [tool.ts doExecuteSense](../../../apps/backend/src/agent/middleware/tool.ts) 去重逻辑失效（新旧内容 hash 不同 → 各自独立留存，LLM 自行对比）。

### E. search_codebase（[search.ts](../../../apps/backend/src/agent/sense/search.ts)）

```text
input { mode, query, regex?, maxResults?, contextLines? }
  ├─ getFinder() → 模块级 FileFinder 单例（首次：create({basePath:cwd, aiMode}) + waitForScan(10s)）
  │   └─ 不可用 → 返回「索引未就绪」错误（hash 空）
  ├─ mode="filename" → finder.fileSearch(query, {pageSize})
  │   └─ 格式化：每条 relativePath [gitStatus]，头部汇总 totalMatched/totalFiles
  └─ mode="content"(默认) → finder.grep(query, {mode, pageSize, before/afterContext, timeBudgetMs:8000})
      ├─ query 约束语法：'*.ts TODO' / 'apps/backend/src/ TODO'
      ├─ regex=true → mode:"regex"，否则 "plain"
      ├─ contextLines>0 → 上下文行带行号缩进
      └─ 格式化：每条 relativePath:lineNumber: lineContent，nextCursor 非空时附「仍有更多」
```

**finder 单例 + hash 恒空：** fff 内置实时 watcher，扫描后自动跟进变更，单例 Promise 缓存（失败也缓存 null 避免重试）。搜索结果依赖实时索引（非确定性），故 `hash: ""`（同 bash 不参与历史去重）。fff 是 ffi-rs 加载的原生 `.so`，**必须从 vite SSR 构建外置**（`ssr.external`）——打包会破坏 `findBinary()` 的 `import.meta.url` 平台包解析（pnpm 未提升 `@ff-labs/fff-bin-*` 到项目根）。

### F. bash 进程注册表（[processRegistry.ts](../../../apps/backend/src/agent/sense/processRegistry.ts)）

```text
chatId → (pid → BashProcessRecord)
              └─ { pid, proc, command, description, startedAt, killed }
```

**三条生命周期规则（[processRegistry.ts 文件注释](../../../apps/backend/src/agent/sense/processRegistry.ts)）：**

| 事件 | 处理 |
|------|------|
| 进程结束（close/error） | 清除（bash.ts 的 close handler 调 unregister） |
| 超时挂起 | **保留**（超时不杀，注册项留在表中待手动管理） |
| 显式 kill | 清除（kill → 进程退出 → close handler 统一 unregister） |

**对外 API：**

| 函数 | 调用方 | 用途 |
|------|--------|------|
| `registerBashProcess(chatId, proc, meta)` | [bash.ts](../../../apps/backend/src/agent/sense/bash.ts) | spawn 后注册 |
| `unregisterBashProcess(chatId, pid)` | [bash.ts](../../../apps/backend/src/agent/sense/bash.ts) | close/error 后注销 |
| `killBashProcess(chatId, pid)` | service `bash.kill` RPC | `process.kill(-pid, SIGTERM)` 杀整个进程组 |
| `listBashProcesses(chatId)` | service `bash.list` RPC | 返回 BashProcessEntry[]（不含 ChildProcess 句柄） |

**进程组 kill 的必要性：** spawn 时 `detached:true` 使子进程成为进程组组长，`kill(-pid)` 终止整个进程组——避免 `sh -c` 的孙子进程泄漏。`-pid` 失败时（进程组已不存在）兜底 `entry.proc.kill()`。`windowsHide:true`（CREATE_NO_WINDOW）仅隐藏子进程控制台窗口，不影响 `detached` 的进程组语义。

**chatId 注入机制（[processRegistry.ts 文件注释](../../../apps/backend/src/agent/sense/processRegistry.ts)）：** sense executor 支持可选第 3 参 `SenseRuntimeContext`。由 [tool.ts doExecuteSense](../../../apps/backend/src/agent/middleware/tool.ts) 调 `execute(args, sharedData, { chatId })` 时注入，bash executor 读取 `senseCtx?.chatId`。测试场景（无 ctx）为 undefined → register 跳过，执行不受影响。

## 依赖与关联 ⭐

### 依赖

| 依赖 | 用途 |
|------|------|
| [core/sense](../../../apps/backend/src/core/sense) | `sense()` 工厂、`Sense`/`SenseResult`/`SenseSharedData`、`registerSenses/resetSenses` |
| [core/config](../../../apps/backend/src/core/config.ts) | `SupervisionLevel` |
| [core/sense/compiler/types](../../../apps/backend/src/core/sense/compiler/types.ts) | `TestCase`（自测） |
| [core/sense/compiler/index](../../../apps/backend/src/core/sense/compiler/index.ts) | `CompiledSenseInfo`/`SenseCompileSummary`（compileToolsReporter） |
| [core/message/adapter](../../../apps/backend/src/core/message/adapter.ts) | `ReplaceInfo`（[index.ts TestResultDetail](../../../apps/backend/src/agent/sense/index.ts) 间接，retry/read 等） |
| [agent/prompt/loadSkill](../../../apps/backend/src/agent/prompt/loadSkill.ts) | `getSkillRealtime`（[skill.ts](../../../apps/backend/src/agent/sense/skill.ts)） |
| [utils/config](../../../apps/backend/src/utils/config.ts) | `config.global` 各项（sense_execute_timeout、bash_log_retention_hours、file_compression、skills_dir） |
| [utils/hash](../../../apps/backend/src/utils/hash.ts) | `hashGenerator`（read/write/skill） |
| [utils/drain](../../../apps/backend/src/utils/drain) | `compressLog`（read_file 大日志去重） |
| [utils/logger](../../../apps/backend/src/utils/logger) | `logger`、`logger.tools.*`（bash 日志：createBashLogPath/formatBashLogHeader/cleanOldBashLogs、`BashLogInfo` 类型） |
| 第三方 | `zod`、`@ff-labs/fff-node`（[search.ts](../../../apps/backend/src/agent/sense/search.ts)）、`child_process`、`fs`/`fs/promises`、`os`/`path`、`url` |

### 被依赖

| 调用方 | 用途 |
|--------|------|
| [agent/bootstrap.ts](../../../apps/backend/src/agent/bootstrap.ts) | `reloadSenses()`（启动期） |
| [agent/middleware/tool.ts](../../../apps/backend/src/agent/middleware/tool.ts) | doExecuteSense 调 executor 第 3 参注入 `{ chatId }` |
| [apps/backend/src/index.ts](../../../apps/backend/src/index.ts) | `compile-senses` 子命令用 `reportSenseCompileResult`/`runSenseTestsAndCollect` |
| service `bash.list` / `bash.kill` RPC | `listBashProcesses`/`killBashProcess` |

### 横切参考

- [./middleware.md](middleware.md) — sense 中间件如何调 `senseTable.get(name).execute(args, sharedData)`，以及历史 hash 替换逻辑
- [./prompt.md](prompt.md) — skill 感官消费 `getSkillRealtime` 的 size/mtimeMs
- [core/sense/compiler](../../../apps/backend/src/core/sense/compiler) — 外部 sense 的编译机制（loadCustomSenses 加载其产物）

## Sense 与其他 Agent 工具的能力对比

本节是当前后端实现的对比事实，不是对外部产品的功能承诺。外部资料只用于确认对比对象公开说明过的边界；“已实现”只表示本仓库有源代码和自动验证证据。外部页面可能变化，不能替代本仓库的测试。

### 对比对象与证据

| 对象 | 已核验的官方入口 | 本次只采用的事实 |
| --- | --- | --- |
| Claude Code | [Tools](https://code.claude.com/docs/en/tools)、[Permissions](https://code.claude.com/docs/en/permissions)、[Hooks](https://code.claude.com/docs/en/hooks) | 有内置工具、按工具和参数匹配的 allow/ask/deny 权限，以及工具前后的生命周期 hook。 |
| Codex CLI | [CLI](https://developers.openai.com/codex/cli)、[Sandbox and approvals](https://developers.openai.com/codex/sandbox) | 有终端代码操作、沙箱和审批两层边界；默认工作区写入模式不等于任意网络访问。 |
| dsh / DeepSeek Harness | [官方站点](https://www.deepseek.com/harness/en/) | 官方说明模型、工具、会话等能力由插件提供，并以追加式会话日志支持查看、恢复、分支和重放；这是公开说明，不是本次运行实测。 |
| OpenCode | [Tools](https://opencode.ai/docs/tools/)、[Permissions](https://opencode.ai/docs/permissions)、[Agents](https://opencode.ai/docs/agents) | 有 bash/read/edit 等工具、按工具和输入模式的 allow/ask/deny 权限，以及按 Agent 覆盖权限。 |
| Pi Agent | [官方文档](https://pi.dev/docs/latest)、[Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) | 有终端代码操作模式，并通过 TypeScript 扩展增加工具、命令、事件处理和 Provider。 |

### 能力差距矩阵

先按产品定位比较范围，再按下表中的公共能力核对实现；“没有兼容层”不等于“没有相同用途的能力”。本项目没有以复制外部产品配置格式为目标。

| 对比对象 | Current（CheryNyxus） | Gap | Implemented / Not implemented | Evidence | Remaining limitation |
| --- | --- | --- | --- | --- | --- |
| Claude Code | 有 Sense 注册、审批和工具执行前后处理。 | 相同用途已有入口，但统一执行状态尚未完整进入后续消息和运行日志。 | 部分实现；状态传递未完成。 | 上方 Claude Code Tools/Permissions/Hooks；本仓库 `doExecuteSense`（下表链接）。 | 不将 hook 或审批功能等同于操作系统隔离，也未测试 Claude Code 本身。 |
| Codex CLI | 有文件、命令工具及执行前授权。 | Codex 官方将操作系统沙箱与审批分开；Sense 注册与审批本身不能证明同等隔离。 | 本地工具和授权已实现；本比较未证明等价的操作系统隔离。 | 上方 Codex Sandbox and approvals；本仓库 `tool.ts` 和公共 Sense 文档（下表链接）。 | 不能从工具调用成功推断文件系统和网络隔离完整。 |
| dsh | 有工具注册、消息记录和基础缓存库。 | 官方说明的会话恢复与重放不能由本项目未接入的缓存库代替。 | 部分实现；通用观察缓存接入、重启恢复和副作用重放保护未实现。 | 上方 dsh 官方站点；本仓库 `runtimeCache.ts` 及其测试（下表链接）。 | 消息可保存不等于操作可安全重放；不宣称兼容 dsh 插件。 |
| OpenCode | 有本地文件/命令工具、角色工具范围和免费搜索。 | 官方区分搜索和指定 URL 抓取；本项目 `web_fetch` 只读取清洗后的正文，不做浏览器渲染。 | 搜索与安全 `web_fetch` 均已实现（本地 fixture 验证）。 | 上方 OpenCode Tools/Permissions/Agents；本仓库[网络搜索与网页读取契约](web-search.md)。 | 不采用其服务作为本项目收费或免费备用路径，真实搜索/抓取可用性未验收。 |
| Pi Agent | 有自定义 Sense 和工具执行处理。 | Pi 扩展还可注册命令、事件、Provider；本项目的 Sense 只负责工具边界，不能代表完整扩展体系。 | Sense 扩展已实现；Pi 扩展接口兼容未实现，也非本计划目标。 | 上方 Pi Extensions；本仓库 `sense()`、注册入口（下表链接）。 | 两者同进程扩展均不能仅凭扩展接口宣称不可信代码隔离。 |

每项固定记录 Current、Gap、状态、Evidence 和 Remaining limitation；不要求兼容其他产品，只比较相同职责的能力。外部资料核验日期为 2026-10-03，以下是文档声明对比，不是对外部产品运行效果的实测。矩阵中的实现状态不代表真实外网、部署或用户验收完成。

| 比较项 | Current（CheryNyxus） | Gap | Implemented / Not implemented | Evidence | Remaining limitation |
| --- | --- | --- | --- | --- | --- |
| 工具声明与注册 | `sense()`、`senseRegistry`、Provider adapter 和 `senseTable` 组成统一注册/执行入口。 | 外部工具的扩展方式和权限模型不完全相同。 | 已实现 CheryNyxus 自己的注册契约；未实现其他产品的兼容层。 | [`apps/backend/src/core/sense/senseCreator.ts`](../../../apps/backend/src/core/sense/senseCreator.ts)、[`apps/backend/src/core/sense/senseRegistry.ts`](../../../apps/backend/src/core/sense/senseRegistry.ts)、[`apps/backend/src/agent/runtimeResolver.ts`](../../../apps/backend/src/agent/runtimeResolver.ts)。 | 自定义 Sense 与宿主同进程，不能据此宣称不可信扩展被沙箱隔离。 |
| 权限、审批与安全策略 | `auto/smart/manual`、`.chery/rule/` 和执行前校验控制 Sense；`execute_command` 等危险能力仍受现有规则约束。 | 对比对象有各自的工具/参数权限语法；本项目不复制其配置格式。 | 已实现本项目的审批链和规则表；未实现 Claude Code/Codex/OpenCode 的权限兼容。 | [`docs/backend/core/sense.md`](../core/sense.md) 的监管等级和规则表；[`apps/backend/src/agent/middleware/tool.ts`](../../../apps/backend/src/agent/middleware/tool.ts) 的执行前校验。 | 未把外部产品的权限规则当作安全证明；规则配置错误仍需按本项目 fail-open 约束审查。 |
| 运行控制 | `executeSenseWithControl` 已执行服务端固定并发闸门（进程内最多 8 个未结束 handler），并检查预先取消、deadline、超时、正文字符数和 UTF-8 字节预算（超限返回 `budget_exceeded` 并尽可能带截断标记）；执行终态（timeout/cancelled/budget_exceeded/provider_error/invalid_result）连同 operationId、durationMs、truncated 与错误结构透传到工具边界、`sense_accept/sense_reject` 消息和用量记录；未结束的取消/超时 handler 在真正结束前继续占用名额。 | 真实外网验证和用户验收仍未完成；跨进程恢复只有基础原语（见「观察缓存、去重与恢复」行）。 | 部分实现；并发闸门、字节预算、终态透传和跨进程恢复原语已落地，并通过最终独立复验（sense/middleware 矩阵 432/432，2026-10-03）。 | [`executeSenseWithControl`](../../../apps/backend/src/core/sense/senseCreator.ts)、[`doExecuteSense`](../../../apps/backend/src/agent/middleware/tool.ts)、[`执行控制测试`](../../../apps/backend/test/core/sense/senseCreator.test.ts)、[`usageRecorder.ts`](../../../apps/backend/src/service/chat/usageRecorder.ts)。 | 非成功结果大小及忽略取消的 handler 仍有限制；准确范围见[公共执行限制](../core/sense.md)。 |
| 本地代码操作 | 内置 `read_file`、`write_file`、`search_codebase`、`execute_command` 经 Sense middleware 执行。 | 与 Claude Code/Codex/OpenCode/Pi 的工具名称、沙箱实现、命令策略不同。 | 已实现本项目工具；未实现外部 CLI 的完整兼容行为。 | [`apps/backend/src/agent/sense/`](../../../apps/backend/src/agent/sense)、[`apps/backend/test/agent/middleware/`](../../../apps/backend/test/agent/middleware)。 | 自动测试不等于跨平台、真实用户目录或生产环境验收。 |
| 免费网络搜索 | `web_search` 默认只注册无密钥 DuckDuckGo 公共 HTML Provider，固定端点、GET、无 Cookie、拒绝重定向、响应/时间/输出有界；实例内固定窗口限流默认每 60 秒 10 次，超限立即返回结构化 `rate_limited`，不排队、不重试，缓存命中与 replay 不消耗限额。 | 没有付费搜索、付费 fallback，也不自动抓取搜索结果链接；读取页面需模型显式调用 `web_fetch`。 | 免费搜索与免费 `web_fetch` 均已实现；真实外网可用性未验收。 | [`webSearch.ts`](../../../apps/backend/src/agent/sense/webSearch.ts)、[`duckduckgo.ts`](../../../apps/backend/src/agent/sense/web/duckduckgo.ts)、[网络搜索契约](web-search.md)、[`apps/backend/test/agent/sense/webSearchIndependent.test.ts`](../../../apps/backend/test/agent/sense/webSearchIndependent.test.ts)。 | 本地 fixture 验证不证明真实 DuckDuckGo 可达或搜索质量；不得从配置状态宣称真实外网可用。 |
| 安全网页读取 | `web_fetch` 只接受无凭据公开 HTTP(S) 与默认端口；逐跳重新解析 DNS 并拒绝 loopback/private/link-local/CGNAT/benchmark/组播与 IPv6 ULA/link-local 地址；重定向最多 5 跳；15 秒超时、400 KiB 响应、只接受 `text/html` 与 `text/plain`；剥离 script/style/noscript；结果使用 ObservationEnvelope 标记 untrusted、来源、观察时间与 truncated；所有失败 fail-closed，不返回部分正文。 | 不执行 JavaScript、不发送 Cookie/登录态、不做浏览器渲染；IPv4 RFC 5737 TEST-NET 三个文档段已拒绝，具体范围与失败语义见[web_fetch 安全边界](web-search.md)。 | 已实现并注册（smart 档）；SSRF/重定向/类型/大小/脚本剥离由本地 transport fixture 测试覆盖。 | [`apps/backend/src/agent/sense/web/fetch.ts`](../../../apps/backend/src/agent/sense/web/fetch.ts)、[`webFetch.test.ts`](../../../apps/backend/test/agent/sense/webFetch.test.ts)、[web_fetch 安全边界](web-search.md)、[独立安全专项测试](../../../apps/backend/test/agent/sense/securityBoundaries.test.ts)。 | 本地 fixture 不证明真实外网页面行为；TEST-NET 拒绝由本地 fixture 验证，不代表真实外网验收。 |
| 结构化观察与多轮回灌 | `ObservationEnvelope` 保留来源、引用、时间和不可信标记，经中间件和消息存储供下一轮使用；`normalizeObservation` 校验 kind 白名单、100k 内容上限与来源 URL（拒绝凭据和非 HTTP(S)）。 | 通用校验覆盖结构合法性，但不构成语义级安全隔离。 | 已实现：通用信封、校验与搜索/抓取接入均落地。 | [`normalizeObservation`](../../../apps/backend/src/core/sense/senseCreator.ts)、[`checkpointState`](../../../apps/backend/src/agent/middleware/checkpointState.ts)、[`webSearchFlow.test.ts`](../../../apps/backend/test/agent/sense/webSearchFlow.test.ts)。 | 外部文本不得作为指令；现有标记不构成安全隔离，校验限制见[公共结果契约](../core/sense.md)。 |
| 外部内容安全 | 搜索与抓取内容标记 `untrusted_external_data`；结果不自动写长期记忆，不返回稳定历史 hash；环境敏感值回灌前脱敏；`web_fetch` 逐跳 SSRF 校验见上行。 | 标记是数据边界约定，不是对抗性隔离；注入文本仍会出现在模型上下文中。 | 搜索与安全抓取边界已实现；注入不可变性（角色、审批、记忆、schema）由真实 middleware 链路专项测试覆盖。 | [`apps/backend/src/agent/sense/web/runtime.ts`](../../../apps/backend/src/agent/sense/web/runtime.ts)、[`apps/backend/src/agent/middleware/tool.ts`](../../../apps/backend/src/agent/middleware/tool.ts)、[网络搜索边界](web-search.md)、[`securityInjection.test.ts`](../../../apps/backend/test/agent/middleware/securityInjection.test.ts)。 | prompt injection 的真实生产风险未验收；测试证明的是结构性边界，不是抗对抗攻击保证。 |
| 观察缓存、去重与恢复 | `WebSearchRuntime.search` 已使用进程内 TTL/条目数/字节有界的 `BoundedRuntimeCache`、规范化 key 和单次 observation 去重；`mode=replay` 只读有效缓存；跨进程恢复有独立原语 `DurableSenseStore`（只持久化已完成/明确拒绝的 observation replay，临时文件加 rename 写入，损坏/过期/缺失统一 `recovery_required`，side-effecting operation 永不静默重跑），生产 Sense 入口需显式接入，不自动替换进程内缓存。 | side-effecting operation 依旧没有可恢复语义；跨进程生产消费点尚未接线。 | 部分实现：搜索生产路径、replay 拒绝、单元测试和跨进程恢复原语已实现；生产接线未完成。 | [`apps/backend/src/agent/sense/web/runtime.ts`](../../../apps/backend/src/agent/sense/web/runtime.ts)、[`apps/backend/src/core/sense/runtimeCache.ts`](../../../apps/backend/src/core/sense/runtimeCache.ts)、[`apps/backend/src/core/sense/recoveryStore.ts`](../../../apps/backend/src/core/sense/recoveryStore.ts)、[`apps/backend/test/agent/sense/webSearchCache.test.ts`](../../../apps/backend/test/agent/sense/webSearchCache.test.ts)、[`apps/backend/test/core/sense/recoveryStore.test.ts`](../../../apps/backend/test/core/sense/recoveryStore.test.ts)。 | 不恢复或重跑写文件、命令等副作用操作；缓存不会跨进程持久化。 |
| 遥测与脱敏 | 生命周期只有 start/finish 两类事件，仅携带 operationId、调用标识、时间和终态，不携带输入、密钥或结果正文；工具结果有环境变量脱敏；执行终态按真实结果记入用量，`budget_exceeded` 附 truncated 标记。 | 生命周期事件尚无独立可审计通道；cache telemetry 只含规范化 sha256 key。 | 部分实现：redaction 契约与专项断言已落地（`securityBoundaries.test.ts` 断言事件不包含输入/结果/错误原文与 hash）。 | [`executeSenseWithControl` 生命周期事件](../../../apps/backend/src/core/sense/senseCreator.ts)、[`apps/backend/src/core/sense/runtimeCache.ts`](../../../apps/backend/src/core/sense/runtimeCache.ts)、[`apps/backend/src/service/chat/usageRecorder.ts`](../../../apps/backend/src/service/chat/usageRecorder.ts)、[`apps/backend/test/agent/sense/securityBoundaries.test.ts`](../../../apps/backend/test/agent/sense/securityBoundaries.test.ts)。 | 不能声称所有日志路径都完成秘密和正文脱敏；覆盖面以专项断言列出的路径为准。 |
| 多 Agent / 子 Agent | 本项目已有 chat、Sense group 和编排基础，但本矩阵只比较 Sense 工具边界。 | 没有把 Claude Code Agent Teams、Codex subagents、OpenCode agents 或 Pi extensions 直接复刻为兼容接口。 | 未实现外部产品兼容层；本项目既有编排不作为对比产品能力的等价证明。 | [`apps/backend/src/agent/builder.ts`](../../../apps/backend/src/agent/builder.ts)、[`docs/shared/architecture/agent-orchestration.md`](../../shared/architecture/agent-orchestration.md)。 | QQ、NapCat、Manager 和新的多 Agent 产品入口不属于本计划；QQ 必须在 Sense 差距计划完成后按独立任务处理。 |

### 免费搜索、外部内容和 QQ 顺序

- 免费搜索策略是硬边界：只允许无密钥公共搜索或本地 synthetic provider；不得加入收费 API、API key、计费凭据或付费 fallback。不可用时返回结构化 unavailable/error，不静默切换到收费服务。
- 搜索和未来可能的抓取结果都是数据，不是指令。结果不得改变系统提示、开发者约束、权限、Sense 规则或长期记忆；只有经过既有 Sense 回灌链才能进入下一轮上下文。
- `web_fetch` 已按上述边界实现并注册为 smart 档感官：URL 协议、凭据、逐跳重定向、DNS/IP 私网阻断、响应大小、内容类型、脚本清理和取消边界均由本地 transport fixture 测试证明（[webFetch.test.ts](../../../apps/backend/test/agent/sense/webFetch.test.ts)、[securityBoundaries.test.ts](../../../apps/backend/test/agent/sense/securityBoundaries.test.ts)）。IPv4 RFC 5737 TEST-NET 文档段已按策略拒绝（`forbidden_address`，不进入 Transport），不再依赖连接失败。真实外网行为未验收。
- QQ/NapCat/Manager 不在本能力计划内。顺序固定为：Sense 能力代码与文档 → 独立集成测试和安全审查 → 最终自动验证与用户审批 → 另行规划 QQ。

### 四状态口径

每项能力必须分别报告四个状态，不能用其中一个代替其他三个：

1. 代码状态：源代码和正式测试是否已落盘。
2. 自动验证状态：命令、退出码、断言和证据路径是否已记录。
3. 实际加载状态：目标进程是否实际加载了新代码；本任务不自动重启生产服务，未证明的项目写“未验证”。
4. 用户验收状态：真实外网、跨设备、视觉交互和主观体验是否由用户确认；自动测试不得代替这一项。

本轮可确认的是局部代码和离线自动验证；真实外网可达性、生产加载和用户验收不作完成声明。

## 扩展点

### 隔离验收专用感官

`role_acceptance` 是 cheryNyxus 的角色配置验收入口。它不是通用任务执行器：服务会为每个场景创建临时工作区和临时 Agent，只暴露目标角色工具与安全白名单的交集，并在正常角色授权之外叠加不可放宽的验收策略。无人值守运行只会预批准覆盖层判定安全的本地 `ask` 操作；越界、破坏性命令和被目标角色显式拒绝的操作仍然拒绝。完整契约见 [role-acceptance.md](role-acceptance.md)。

### 添加内置 Sense

1. 在 [sense/](../../../apps/backend/src/agent/sense) 新增 `<name>.ts`，用 [sense()](../../../apps/backend/src/core/sense/senseCreator.ts) 工厂创建：

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

2. 在 [index.ts](../../../apps/backend/src/agent/sense/index.ts) 导入并在 `registerBuiltinSenses()` 中 `registerSenses([...])`：

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

> 编译细节见 [core/sense/compiler](../../../apps/backend/src/core/sense/compiler)。

### 工具能力声明（Sense 第 6 参）

`sense()` 工厂第 6 个可选参数 `capabilities` 声明工具能力，供发送门控、前置调度与生成注入判断：

```ts
export default sense(
  "external_image_generate",
  "调用外部图片服务生成图片",
  z.object({ prompt: z.string(), images: z.array(z.object({ filename: z.string() })) }),
  async (input) => { /* 出入参翻译 + 落盘 /api/media/ */ return { content }; },
  SupervisionLevel.smart,
  {
    accepts: ["image"],   // 接收：媒体类型 image/video/audio 或文件后缀 doc/docx/pdf…
    produces: ["image"],  // 产出：媒体类型或 text
    preprocess: false,    // 是否前置执行（缺省 false = 普通后置工具）
    batchSize: 3,         // 每批最多处理几个媒体项（缺省 = 一次性全量）
  },
);
```

语义与生效点：

| 字段 | 生效点 |
|---|---|
| `accepts` | 前置调度（`preprocess=true` 时按媒体类型/后缀匹配）、发送门控（该类型可上传）、工具能力声明透传 `sense.tools` |
| `produces` | 生成注入判断（感官组配置即注入，替代大脑 `generate.*` 双门）、`sense.tools` 透传 |
| `preprocess` | 非多模态模型下，`[[media:]]` 引用在发请求前交给该工具执行，结果替换进消息（不持久化、失败跳过+提示） |
| `batchSize` | 仅影响工具内部实现（分批调用外部接口）；调度层永远全量传入，工具内部自行分批/合并/管理并发 |

### Sense 实现要点

- **hash 字段语义：** 返回 `hash` 非空时，[tool.ts doExecuteSense](../../../apps/backend/src/agent/middleware/tool.ts) 会扫描历史 sense 消息，hash 命中则把旧消息替换为短说明。若不希望参与去重，返回 `hash: ""`。
- **sharedData 命名空间约定：** 跨感官共享数据按 namespace 存（如 `sharedData.get("read_file")`）。chatId 不占用 sharedData namespace，而是通过 executor 第三参 `senseCtx?.chatId` 传入。
- **executor 签名：** `(args, sharedData, senseCtx?)`。需要 chatId 时读 `senseCtx?.chatId`（[tool.ts](../../../apps/backend/src/agent/middleware/tool.ts) 已在 execute 时注入）。
- **错误处理：** 抛异常会被 [tool.ts doExecuteSense](../../../apps/backend/src/agent/middleware/tool.ts) 的 try-catch 转成 `Sense execution failed: ...` content 返回（不传播到 middleware）；建议业务错误也返回 `{ content: "错误说明", hash: "" }` 而非抛。
