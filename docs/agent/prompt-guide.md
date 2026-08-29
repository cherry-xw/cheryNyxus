# 提示词编写规范 + 问题排查清单（Prompt Guide）

> 目的：沉淀 LLM 工具链（Sense/提示词）编写中反复踩坑的设计要点，并分门别类记录历史 bug 诊断，保证"遇到过的问题不再多次触犯"。新增感官 / 修改系统提示词前必读。
>
> 来源案例：对话 `25c894db-adff-42b2-806a-71ace90934aa`（2026-08-23，cherryNyxus 配置管理角色清配置任务，6 个节点全部异常）。

## 一、提示词编写规范（设计要点）

### 1. 路径锚点必注入

**规则**：系统提示词必须给 LLM 至少一个**绝对路径锚点**（`.chery` 配置目录位置 / preset workspace），否则"感官要求绝对路径 + 系统不提供任何路径信息"自相矛盾。

- 教训：`<environment>` 段只有 OS/日期/时间（`src/agent/prompt/index.ts`），不含 cwd/`.chery` 位置 → LLM 无从构造绝对路径 → 只能猜相对路径 `.chery` 或用 `pwd` 自救。
- 现状：`<environment>` 段已补充 `.chery` 配置目录绝对路径（`buildPromptPieces`）；preset 配了 `workspace` 时额外注入 `<workspace>` 段。
- 新增提示词段时必须自检：**LLM 能否据此回答"某个文件的绝对路径是什么"？**

### 2. 结构化通道引导

**规则**：配置/敏感类操作应引导走结构化感官（`config_manage` 等），避免 LLM 用文件工具/命令猜路径。

- 教训：LLM 不知道 `.chery/config.yaml` 在哪 → search / read / execute_command 连环踩坑；`config_manage` 不需要路径，本应是唯一正确通道。
- 现状：`config_manage` 描述明确"本感官是读写 .chery 配置的唯一正式通道"；`execute_command` 无 workspace 报错时引导走 `config_manage(action="get")`。
- 判断：新增文件型感官时，先问"这个操作是否可以用已有结构化感官表达？"

### 3. zod schema → JSON Schema 陷阱（discriminatedUnion 顶层 required 丢失）

**规则**：`z.discriminatedUnion` 转 JSON Schema 时顶层 `required`/`properties` 为 `undefined`（仅 `oneOf` 分支内部有）→ `senseCreator` 用 `required: jsonSchema.required ?? []` 兜底 → **模型端 tool 定义 `required: []`，必填参数不再强制**。

- 教训：`config_manage` 用 `z.discriminatedUnion('action', [...])` → LLM 连续两次传 `{}`（空参数）→ 进 smart 审批后被拒/报缺 action。
- 现状：改用普通 `z.object({ action: z.enum(['get','patch','rollback', ...]), ... })`，`toJSONSchema().required` 含 `action`。
- 当前配置协议：顶层仍是普通 object + action enum；资源级 operations 才使用嵌套 discriminated union，避免再次丢失顶层 required。
- 自检：**新增/修改感官 schema 后必须断言 `schema.toJSONSchema().required` 非空**（每个必填参数都在其中）。

### 4. 运行时 schema 校验（schema 不止用于生成 tool 定义）

**规则**：sense 执行前必须对参数做 `safeParse`，校验失败返回结构化错误（列出缺失/非法字段），而非把原始参数直接丢给 handler。

- 教训：`doExecuteSense`（`src/agent/middleware/tool.ts`）此前直接 `senseEntry.execute(args)` 不 parse → 空参数直达 handler → 靠 handler 内部 fallback 兜底。
- 现状：执行前统一 `safeParse`，失败返回"缺参 + 用法"错误，不再产生空调用进审批。
- 附带收益：缺参调用在进入监管审批**之前**就被拦截，避免"空调用进审批 → 超时被拒"的恶性循环。

### 5. 错误消息可诊断性（不得把参数错误包装成环境错误）

**规则**：感官错误必须透传**真实原因** + 给出**可执行的下一步**；禁止把参数错误包装成环境错误。

- 教训：`search_codebase` 传相对路径 `.chery` → `FileFinder.create` 抛 `Invalid path` → 统一包装成"fff 原生库不可用或初始扫描失败"（真实日志：`⚠ fff FileFinder.create 失败 (basePath=.chery): Failed to init file picker: Invalid path .chery`）。LLM 收到误导信息后以为环境坏了，其实库完好（`FileFinder.isAvailable()=true`）。
- 现状：`search_codebase` 入口先校验 `path.isAbsolute`，相对路径直接返回"必须绝对路径"；create 失败透传具体 error。
- 自检：**看到错误文本时，能否判断是"参数问题"还是"环境问题"？** 不能 → 重写措辞。

### 6. 失败缓存要带原因与 TTL

**规则**：模块级缓存失败结果时，必须缓存**失败原因**（供诊断）并考虑 TTL，避免"一次失败 → 进程内永久失效"。

- 教训：`search.ts` 的 `finderCache` 缓存 `null`（"初始化失败也缓存 null，需重试重启进程"）→ 一次相对路径失败，后续所有搜索永久报错。

### 7. 模型可写对象禁止 `z.unknown()`

**规则**：模型需要生成的每个配置资源都必须有完整 Zod 类型；不能用 `z.record(z.string(), z.unknown())` 把整棵配置树作为自由对象暴露给模型。人类字段文档用于理解，强类型 JSON Schema 用于生成约束，服务端候选校验用于最终兜底，三层职责不同。

- 事故：对话 `522b058c-d4dd-4905-ba07-ee189ce3bac5` 中，持久化工具参数已证明错误值由模型直接生成：`30000` 变成 `"30000"`、`true` 变成 `"true"`，数组/对象有时变成空字符串；并非工具链序列化改型。
- 根因：旧 `config` 字段为 `z.record(z.string(), z.unknown())`，生成的 JSON Schema 对嵌套值只给出 `additionalProperties: {}`，模型看不到任何真实字段类型。
- 现状：AI 改用 `baseRevision + operations`；brain/role/preset/senseGroup 资源有明确 schema，旧全量 save 明确拒绝。服务端把操作应用到磁盘快照，完整校验候选后才写盘。
- 自检：把 sense 的 JSON Schema 打印出来，确认 number/boolean/array/object 的嵌套类型真实存在，而不是空 `{}`。

## 二、问题排查清单（历史 bug 诊断库）

> 每一条 = 一次真实事故。格式：现象 → 根因 → 修复 → 防再犯。按日期归档，积累后拆分子文档。

### 2026-08-23 · 对话 25c894db 配置清理全链路异常

**现象**：cherryNyxus 配置管理角色执行"删除默认预设相关配置"，6 个节点全部异常：

| #   | 节点            | 现象                                                | 根因                                                                    | 修复                                         |
| --- | --------------- | --------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| 1   | config_manage   | `arguments="{}"` 空参数 → smart 审批 → 30s 超时被拒 | schema 用 discriminatedUnion → 顶层 required 丢失 → 模型不强制传 action | P0：改用 object+enum；P1：运行时 safeParse   |
| 2   | search_codebase | 报"fff 原生库不可用或初始扫描失败"                  | 传相对路径 `.chery` → create 抛 `Invalid path` → 错误消息误导           | P1：入口 path.isAbsolute 校验 + 透传真实错误 |
| 3   | read_file       | "路径 .chery/config.yaml 不是绝对路径"              | LLM 无路径锚点，只能猜相对路径                                          | P2：`<environment>` 注入 cheryDir            |
| 4   | execute_command | "当前会话没有有效工作区"（`pwd` 自救被拒）          | preset 未配 workspace + LLM 不知情                                      | P2：无 workspace 报错引导 config_manage      |
| 5   | config_manage   | "必须显式指定 action"（仍 `{}`）                    | 同 #1（框架 bug 未修前）                                                | P0+P1                                        |
| 6   | config_manage   | 内容为空                                            | 连续踩坑后上下文污染                                                    | 同上                                         |

**核心因果链**：preset 未配 workspace → 系统提示词不注入 `<workspace>` 段 → `<environment>` 也无路径 → LLM 无任何绝对路径锚点 → 需要路径时只能猜/自救 → 每步被拒或误导。

**关键证据**（三方交叉验证）：

- DB 对话记录：`.chery/db/2026-08.db`（messages 表，chat_id=`25c894db...`）
- 运行时日志：`.chery/logs/2026-08-23.log`（`sense.trigger` 的 `arguments` 字段 + `FileFinder.create 失败` 行）
- 环境实测：`FileFinder.isAvailable()=true`（证明库完好，错在参数）

**防再犯**：本文档第一节规范 #1、#3、#5 正是本事故的教训沉淀。
