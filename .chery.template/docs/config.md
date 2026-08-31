# config.yaml — 主配置参考表

> 模板文件：`.chery.template/config.yaml` ｜ 运行位置：`.chery/config.yaml`（gitignored）
> 加载入口与类型：[src/utils/config.ts](../../src/utils/config.ts)
> 相关文档：[../../docs/utils/README.md](../../docs/utils/README.md)（加载/校验流程）

## 用途

唯一对外配置入口。定义 LLM 大脑、感官监管等级、角色/预设、WebSocket 服务端口、日志、文件压缩等所有运行时参数。框架启动期由 `loadConfig()` 一次性加载为内存单例；运行期修改通过 `config.get` / `config.save` RPC（设置面板）落盘，**重启生效**。

## 顶层结构

| 段 | 类型 | 必填 | 说明 |
|----|------|------|------|
| `global` | object | ✅ | 全局运行参数（thinking / supervision / stream / 超时 / 日志 / 文件压缩） |
| `llm` | object | ✅ | LLM 配置根（`llm.brain.<name>` 为脑实例 map，至少一个） |
| `media` | object | ❌ | 媒体网关（图片/视频/音频生成），当前未启用，留作扩展 |
| `sense_groups` | object | ✅（如启用感官） | 感官分组（角色通过 `senseGroup` 引用） |
| `roles` | object | ✅（如启用角色） | 角色定义（brain、工具组、提示词和权限） |
| `presets` | object | ✅ | 预设配置（leader、成员、可选 workspace 与监管规则） |
| `server` | object | ❌ | WebSocket 服务监听配置（默认 port 8182 / transport binary / host 127.0.0.1） |
| `memory` | object | ❌ | 长期记忆参数（`max_count` / `max_chars`） |

## global 字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `thinking` | bool | ✅ | — | 是否启用 LLM 思考模式（全局开关；brain 级 `thinking` 覆盖） |
| `supervision` | enum | ✅ | — | Sense 监管等级：`auto`（0，静默）/ `smart`(1，审批）/ `manual`（2，手动）；可被感官配置或感官内置声明覆盖 |
| `stream` | bool | ✅ | — | 是否流式返回（false 则整段返回） |
| `sense_execute_timeout` | number (ms) | ❌ | 10000 | 单次 Sense 执行超时 |
| `approval_timeout` | number (ms) | ❌ | 300000 | 审批等待超时（默认 5 分钟；`0` = 不设业务截止时间） |
| `approval_hard_timeout` | number (ms) | ❌ | 1800000 | 审批运行资源上限；到点暂停运行，持久审批仍可恢复 |
| `disconnect_grace_ms` | number (ms) | ❌ | 15000 | WebSocket 断连后等待重连的宽限时间 |
| `watchdog.timeout_ms` | number (ms) | ❌ | 300000 | 子角色无输出超时；`0` 表示关闭 |
| `watchdog.wake_on_timeout` | bool | ❌ | `false` | 子角色超时后是否唤醒主角色 |
| `bash_log_retention_hours` | number (hours) | ❌ | 24 | bash 子进程日志保留时长 |
| `tree_full_render_threshold` | number | ❌ | 500 | 节点树全量渲染阈值（节点数≤此值跳过视口裁剪避免平移卡顿；`0`=始终裁剪） |
| `history_recall.max_output_chars` | number | ❌ | 4000 | `history_recall` 感官（长会话历史回忆）单次返回的硬字符上限，超限截断并提示缩小范围 |
| `textEditor` | string | ❌ | `notepad` | 文本编辑器命令（设置页「打开配置」按钮调用） |
| `file_compression` | object | ❌ | 见下 | 大日志文件读取时的截断/压缩配置 |

### global.file_compression 子字段

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `truncate_threshold` | number (bytes) | 50000 | 超过此大小的文件读取引发截断/drain 压缩 |
| `truncate_preview_lines` | number | 100 | 截断时保留的前/后预览行数 |
| `log_file_extensions` | string[] | `[".log", ".txt", ".out", ".err"]` | 视为日志文件的扩展名，命中走 drain 模板挖掘 |
| `drain_preview_count` | number | 3 | drain 模式下预览文件数 |

### global.logger 子字段

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `level` | enum | `info` | 日志等级：`debug` / `info` / `warn` / `error` |
| `output` | string[] | `["file"]` | 输出目标：`file`（按天文件）/ `console`（stdout） |
| `timestamp` | bool | `true` | 是否带时间戳 |
| `location` | bool | `true` | 是否带文件:行号 |
| `format` | enum | `plain` | 格式：`plain`（人类可读）/ `json`（结构化） |

## llm.brain.<name> 字段

`name` 为脑实例 key（角色通过 `roles.<role>.brain` 引用）。至少配置一个。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `provider` | enum | ✅ | — | Adapter 名：`openai` / `ollama` / `mock` / `bigmodel` / `anthropic`；详见 [docs/agent/provider.md](../../docs/agent/provider.md) |
| `model` | string | ✅ | — | 模型 id；初始模板用 `<YOUR_MODEL_NAME>` 占位，设置页按未配置展示 |
| `url` | string | ❌ | provider 默认 | API base URL；未启用 `fullUrl` 时应自行包含 `/v1` 等版本段 |
| `key` | string / `$ENV` | ❌ | — | API Key；推荐 `$ENV_VAR` 形式从环境变量注入；缺失运行期 provider 调用时抛错响应前端 |
| `thinking` | enum | ❌ | provider 默认 | 思考强度：`off` / `on` / `low` / `medium` / `high`；可选档位受 [model-thinking.yaml](model-thinking.md) 约束 |
| `rpm` | number | ❌ | 不限流 | 每分钟最大请求数（仅 OpenAI 兼容 provider 生效，60s 滑动窗口） |
| `contextLimit` | number (tokens) | ❌ | provider 默认 | 模型上下文窗口；前端「剩余上下文」显示依据 |
| `capabilities` | object | ❌ | Tool Call 开 / 媒体关 | 模型能力声明 |
| `mock` | object | ❌ | — | mock provider 专用（`provider: mock` 时必填） |
| `hooks` | string | ❌ | — | brain 级 hooks.json 路径（相对 `.chery/`，如 `hooks/anthropic-main.json`）；与全局 `.chery/hooks/hooks.json` 合并（全局在前，brain 级在后；brain 级覆盖全局） |

初始模板仅保留 `default`：在设置页填写地址、模型并选择 `LLM_API_KEY` 后保存，即可使用 CheryNyxus；其他 brain 由设置页或 CheryNyxus 按需创建。

### llm.brain.<name>.capabilities 子字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `input.image` | bool | 是否支持图像输入（多模态） |
| `generate` | object | 生成能力声明（tool call 能力由 `BrainConfig` 顶层默认开；`generate` 用于未来扩展，当前为空 `{}`） |

### llm.brain.<name>.mock 子字段（仅 mock provider）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `enabled` | bool | ✅ | 是否启用 mock（false 则跳过此脑） |
| `file` | string | ✅ | mock 响应脚本路径（相对 `.chery/`，如 `mock/read_file.yaml`） |

## media 字段

当前为扩展预留，类型 `MediaConfig`。完整定义尚未启用，按需扩展：
- 图片/视频/音频网关（url / model / key / enabled）
- `maxUploadMb`：上传上限

## sense_groups.<group> 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sense_groups` | `Record<groupName, senseName[]>` | ✅ | `groupName` 为分组 key（角色通过 `roles.<role>.senseGroup` 引用）；`senseName[]` 为感官名列表，支持 `:level` 后缀覆盖监管等级 |

**senseName 格式：** `<sense>:<level>`，`<level>` 取 `auto` / `smart` / `manual`。优先级：感官配置覆盖 > 感官内置声明 > `global.supervision`。

**内置 Sense：** `read_file` / `write_file` / `execute_command` / `search_codebase` / `spawn_role` / `update_todo` / `skill` / `install_skill` / `config_manage` / `ask_user_question`。

**示例：**

```yaml
sense_groups:
  leader:                    # 纯组长组：不配配置管理感官，配置需交 Cherry Nexus
    - read_file
    - skill
    - write_file
    - execute_command
    - search_codebase
    - spawn_role
    - ask_user_question
    - history_recall
  chery_nexus:               # Cherry Nexus 专属组：组长能力 + 配置管理（install_skill/config_manage 独占）
    - read_file
    - skill
    - write_file
    - execute_command
    - search_codebase
    - spawn_role
    - ask_user_question
    - history_recall
    - install_skill                # 技能安装（Cherry Nexus 职责）
    - config_manage                # 配置管理（Cherry Nexus 独占，.chery/ 路径守卫天然豁免）
  reviewer:                  # 只读组
    - read_file
    - search_codebase
    - skill
```

## roles.<role> 字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `id` | string | ❌ | 按名称确定性生成 | 稳定身份；改名时必须保留 |
| `kind` | `role\|shadow` | ❌ | `role` | Shadow 仅供内部临时流程 |
| `brain` | string | ✅ | — | 引用 `llm.brain` 的 key；启动校验必须存在 |
| `avatar` | string | ❌ | 角色名稳定生成 | 角色头像 Emoji；前端可在设置页切换 |
| `description` | string | ❌ | — | 设置页展示说明，不注入提示词 |
| `mentionable` | bool | ❌ | `false` | 是否允许用户通过 `@` 选择 |
| `senseGroup` | string | ❌ | — | 引用 `sense_groups` 的 key；无 Tool Call 能力的 brain 不得配置 |
| `mcpServers` | string[] | ❌ | `[]` | MCP 服务器列表（占位，当前为空） |
| `systemPrompt` | string | ❌ | 全局提示词 | 相对 `.chery/` 的提示词路径；配置时文件必须存在 |
| `skills` / `plugins` | string[] | ❌ | 全部 | 允许注入的独立技能或插件子集；空数组表示禁用 |
| `permissions` | object | ❌ | `supervised` | 参数级权限模板与覆盖 |
| `lock` | bool | ❌ | `false` | 锁定禁止删除（保护关键角色如 `cheryNyxus` / `curator`） |

**校验（启动期）：** `brain` 必须存在；配置了 `systemPrompt` 时文件必须存在；无 Tool Call 能力的 brain 不得配置 `senseGroup` / `mcpServers`。

## presets.<name> 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ❌ | 稳定身份；改名时必须保留 |
| `leader` | string | ✅ | 主角色名（必须在同预设的 `roles` 内，且存在于 `roles` 顶层） |
| `roles` | string[] | ✅ | 该预设启用的角色列表（含 `leader`）；每个角色必须存在于 `roles` 顶层 |
| `detailRole` | string | ❌ | 节点详情解释角色；必须是本预设成员且不能等于 leader |
| `shadows.conversationRouting` | string | ❌ | 会话路由 Shadow；其工具组必须且只能包含 `select_conversation:auto` |
| `mediaImage` / `mediaVideo` / `mediaAudio` | string | ❌ | 引用类型匹配的媒体服务 |
| `workspace` | string | ❌ | 工作目录绝对路径；缺省时不注入 workspace 提示 |
| `schedule` | object | ❌ | 定时任务 `{cron, task, enabled?}` |
| `rule` | string | ❌ | `.chery/rule/` 下的 smart 监管规则覆盖文件名 |

## server 字段

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `port` | number | 8182 | WebSocket 监听端口 |
| `transport` | enum | `binary` | 传输格式：`binary` / `json`（详见 [docs/protocol.md](../../docs/protocol.md)） |
| `host` | string | `127.0.0.1` | 监听地址 |
| `workspace_browse` | object | — | 文件夹浏览协议（`config.workspace.browse.*`）配置，见下 |

### workspace_browse 字段（文件夹浏览协议）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `roots` | string[] | 全盘 | 允许浏览的根白名单（绝对路径，支持 `~` 展开）。**缺省不设 = 全盘可浏览**：POSIX 为 `/`、win32 为全部存在盘符；权限由系统对后端的实际访问报错把关（无权限目录 → 「下级无法加载」）。配置后收窄为白名单内（路径穿越/软链逃逸拒绝）。`.chery` 系统配置目录恒不可浏览 |
| `default_include_files` | boolean | `false` | 是否允许返回文件（**硬上限**：置 `false` 时调用方传 `includeFiles:true` 也被忽略；置 `true` 后调用方可选） |
| `show_hidden` | boolean | `false` | 是否显示隐藏条目（`.` 开头；`.chery` 恒隐藏不受此控） |
| `max_depth` | number | 不限 | 从根算起的最大浏览深度 |
| `session_ttl_ms` | number | 600000 | 浏览会话存活时间（10 分钟） |
| `rpm` | number | 60 | 每会话每分钟请求上限 |
| `max_sessions` | number | 20 | 并发浏览会话上限 |

> ⚠ `workspace_browse` 是 **server 侧专属**：被 `config.get` 剥离（设置面板不可编辑）、`config.save` 原样保留；改配置需直接编辑 `.chery/config.yaml` 后重启生效。载荷加密为混淆级（协议见 [docs/protocol.md](../../docs/protocol.md) `config.workspace.browse.*`）。

> ⚠ Web 静态服务端口原 `web_port` 已废弃，改由环境变量 `WEB_PORT`（默认 8183）指定。

## memory 字段

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `global.max_count` | number | 30 | 跨会话全局记忆最大条数 |
| `global.max_chars` | number | 500 | 单条全局记忆最大字符数 |
| `workspace.max_count` | number | 15 | 工作区记忆最大条数 |
| `workspace.max_chars` | number | 500 | 单条工作区记忆最大字符数 |

## 特殊语法

### `$ENV` 占位符

```yaml
key: $LLM_API_KEY            # 整段值替换为环境变量；缺失 warn 但不阻断启动
```

- 仅匹配**整段值**的正则 `^\$([A-Z_][A-Z0-9_]*)$`
- 从 `.env` / 进程环境变量取值
- 缺失会收集到 `missingEnvVars`（`Set` 去重，同一变量被多 brain 引用只 warn 一次），原样保留字符串
- 不会替换值中嵌入的 `$VAR`

**示例：**

```yaml
llm:
  brain:
    default:
      key: $LLM_API_KEY
      url: <YOUR_LLM_URL>
      model: <YOUR_MODEL_NAME>
```

## 校验规则摘要（`validateRawConfig`）

返回错误字符串数组（空=通过）。启动期与 `saveRawConfig` 均调用：

1. `roles.*.brain` 必须存在于 `llm.brain`；配置了 `roles.*.systemPrompt` 时文件必须存在
2. `presets.*.leader` 必须引用 `roles` 中的角色，并包含于该预设的 `roles`
3. `presets.*.workspace` 可缺省；保存时非绝对路径为错误，不存在或不可访问为告警
4. `global.supervision` 必须是 `auto|smart|manual`
5. `sense_groups.*[]` 的 `:level` 后缀必须合法
6. `llm.brain.*` 的 `model` / `provider` 必填
7. `capabilities.generate.*` 不得与 `capabilities.toolCall:false` 组合
8. **key 不参与启动校验**：缺失不阻止启动，运行期 provider 调用时若 key 为空才抛错

## 关联

- 模板加载：[src/utils/config.ts](../../src/utils/config.ts) `loadConfig()`
- 类型定义：[src/utils/config.ts](../../src/utils/config.ts#L55-L132)
- 校验逻辑：[src/utils/config.ts](../../src/utils/config.ts) `validateRawConfig()`
- RPC：`config.get` / `config.save` / `config.workspace.validate`（设置面板读写）
- 同步规则：模板只初始化全新 workspace；已有 `.chery/config.yaml` 不做整文件覆盖
- AI 修改入口：见 [`./README.md`](./README.md)「AI 自动修改配置」章节
