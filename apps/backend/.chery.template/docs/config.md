# config.yaml — 主配置参考表

> 模板文件：`.chery.template/config.yaml` ｜ 运行位置：`.chery/config.yaml`（gitignored）
> 加载入口与类型：[config.ts](../../src/utils/config.ts)
> 相关文档：[配置工具](../../../../docs/backend/utils/README.md)（加载/校验流程）

## 用途

唯一对外配置入口。定义 LLM 大脑、感官监管等级、角色/预设、WebSocket 服务端口、日志、文件压缩等所有运行时参数。框架启动期由 `loadConfig()` 一次性加载为内存单例；运行期修改通过 `config.get` / `config.save` RPC（设置面板）落盘，**重启生效**。

## 顶层结构

| 段 | 类型 | 必填 | 说明 |
|----|------|------|------|
| `global` | object | ✅ | 全局运行参数（thinking / supervision / stream / 超时 / 日志 / 文件压缩） |
| `llm` | object | ✅ | LLM 配置根（`llm.brain.<name>` 为脑实例 map，至少一个） |
| `sense_groups` | object | ✅（如启用感官） | 感官分组（角色通过 `senseGroup` 引用） |
| `roles` | object | ✅（如启用角色） | 角色定义（brain、工具组、提示词和权限） |
| `presets` | object | ✅ | 预设配置（leader、成员、可选 workspace 与监管规则） |
| `server` | object | ❌ | WebSocket 服务监听配置（默认 port 8182 / transport binary / host 127.0.0.1） |
| `manager` | object | ❌ | 本地管理器监听配置（`apps/manager/` 独立进程，默认 host 127.0.0.1；见 [manager 字段](#manager-字段)） |
| `memory` | object | ❌ | 长期记忆参数（`max_count` / `max_chars`） |
| `files` | object | ❌ | 文件上传、上下文及图片独立保留策略，见[模型与文件能力](../../../../docs/backend/agent/model-capabilities.md) |

## global 字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `thinking` | bool | ✅ | — | 是否启用 LLM 思考模式（全局开关；brain 级 `thinking` 覆盖） |
| `supervision` | enum | ✅ | — | Sense 监管等级：`auto`（0，静默）/ `smart`(1，审批）/ `manual`（2，手动）；可被感官配置或感官内置声明覆盖 |
| `stream` | bool | ✅ | — | 是否流式返回（false 则整段返回） |
| `llm_request_timeout_ms` | number (ms) | ❌ | 600000 | 单次模型请求超时（默认 10 分钟；`0` = 不限时；QQ 连续任务路径不按此限时中止） |
| `sense_execute_timeout` | number (ms) | ❌ | 30000 | 单次 Sense 执行等待超时 |
| `approval_timeout` | number (ms) | ❌ | 300000 | 审批等待超时（默认 5 分钟；`0` = 不设业务截止时间） |
| `approval_hard_timeout` | number (ms) | ❌ | 1800000 | 审批运行资源上限；到点暂停运行，持久审批仍可恢复 |
| `disconnect_grace_ms` | number (ms) | ❌ | 15000 | WebSocket 断连后等待重连的宽限时间 |
| `maxLoopCount` | number | ❌ | 30 | 单次运行最大工具调用轮数 |
| `watchdog.timeout_ms` | number (ms) | ❌ | 300000 | 子角色无输出超时；`0` 表示关闭 |
| `watchdog.wake_on_timeout` | bool | ❌ | `false` | 子角色超时后是否唤醒主角色 |
| `tree_full_render_threshold` | number | ❌ | 150 | 节点树全量渲染基础阈值（卡牌模式最多 120；`0`=始终裁剪） |
| `history_recall.max_output_chars` | number | ❌ | 4000 | `history_recall` 感官（长会话历史回忆）单次返回的硬字符上限，超限截断并提示缩小范围 |
| `textEditor` | string | ❌ | 系统默认 | 文本编辑器命令（设置页「打开配置」按钮调用；缺省由后端主机系统打开） |
| `file_compression` | object | ❌ | 见下 | 大日志文件读取时的截断/压缩配置 |
| `command` | object | ❌ | `warn 60% / auto 80% / min 32000` | `compact` 指令阈值与最低上下文容量门槛 |

### global.file_compression 子字段

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `truncate_threshold` | number (bytes) | 102400 | 超过此大小的文件读取引发截断/drain 压缩 |
| `truncate_preview_lines` | number | 100 | 截断时保留的前/后预览行数 |
| `log_file_extensions` | string[] | `[".log", ".txt", ".out", ".err"]` | 视为日志文件的扩展名，命中走 drain 模板挖掘 |
| `drain_preview_count` | number | 3 | drain 模式下预览模板样例数 |

### global.logger 子字段

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `level` | enum | `info` | 日志等级：`debug` / `info` / `warn` / `error` / `silent` |
| `output` | string[] | `["console"]` | 输出目标：`console`（终端）/ `file`（按天文件）；空数组 `[]` 表示全部关闭 |
| `timestamp` | bool | `true` | 是否带时间戳 |
| `location` | bool | `true` | 是否带文件:行号 |
| `format` | enum | `json` | 格式：`json`（结构化）/ `plain`（人类可读） |

## llm.brain.<name> 字段

`name` 为脑实例 key（角色通过 `roles.<role>.brain` 引用）。至少配置一个。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `provider` | enum/string | ✅ | — | 服务入口：官方厂商、中转站或 `custom`；不再直接表示消息协议 |
| `protocol` | enum | 条件必填 | 从旧 provider 推断 | `openai-chat-completions` / `openai-responses` / `anthropic-messages` / `ollama-chat` / `mock`；无法从 provider 推断时必填 |
| `model` | string | ✅ | — | 模型 id；初始模板用 `<YOUR_MODEL_NAME>` 占位，保存前必须替换为真实型号 |
| `url` | string | 条件必填 | 服务与协议默认 | API base URL；`fullUrl: true` 或无服务默认地址时必填 |
| `key` | string / `$ENV` | 条件必填 | — | API Key；OpenAI 兼容与 Anthropic 协议必填（`ollama-chat`、`mock` 不要求），`$ENV` 引用保存时必须可解析为非空值 |
| `thinking` | enum | ❌ | `off`（运行默认） | 思考强度；可选档位和请求映射来自 [model-catalog.yaml](model-catalog.md)，仍受全局开关与型号限制 |
| `rpm` | number | ❌ | 不增加本地限流 | 每分钟最大请求数（60s 滑动窗口） |
| `contextLimit` | number (tokens) | ✅ | — | 正整数上下文上限；必须明确填写，目录推荐仅在界面主动点击「采用推荐值」时写入 |
| `capabilities` | object | ❌ | 继承目录或运行默认 | 模型能力覆盖声明（省略时继承目录推荐/事实，媒体未知回退 `unknown`） |
| `mock` | object | ❌ | — | mock 协议专用脚本配置 |
| `hooks` | string | ❌ | — | brain 级 hooks.json 路径（相对 `.chery/`，如 `hooks/anthropic-main.json`）；与全局 `.chery/hooks/hooks.json` 合并（全局在前，brain 级在后；brain 级覆盖全局） |

初始模板仅保留 `default`：在设置页填写地址、模型并选择 `LLM_API_KEY` 后保存，即可使用 cheryNyxus；其他 brain 由设置页或 cheryNyxus 按需创建。

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

## sense_groups.<group> 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sense_groups` | `Record<groupName, senseName[]>` | ✅ | `groupName` 为分组 key（角色通过 `roles.<role>.senseGroup` 引用）；`senseName[]` 为感官名列表，支持 `:level` 后缀覆盖监管等级 |

**senseName 格式：** `<sense>:<level>`，`<level>` 取 `auto` / `smart` / `manual`。优先级：感官配置覆盖 > 感官内置声明 > `global.supervision`。

**内置 Sense：** `read_file` / `write_file` / `execute_command` / `search_codebase` / `spawn_role` / `update_todo` / `skill` / `install_skill` / `config_manage` / `ask_user_question`。

**示例：**

```yaml
sense_groups:
  leader:                    # 纯组长组：不配配置管理感官，配置需交 cheryNyxus
    - read_file
    - skill
    - write_file
    - execute_command
    - search_codebase
    - spawn_role
    - ask_user_question
    - history_recall
  cheryNyxus:                # cheryNyxus 专属组：组长能力 + 配置管理（install_skill/config_manage 独占）
    - read_file
    - skill
    - write_file
    - execute_command
    - search_codebase
    - spawn_role
    - ask_user_question
    - history_recall
    - install_skill                # 技能安装（cheryNyxus 职责）
    - config_manage                # 配置管理（cheryNyxus 独占，.chery/ 路径守卫天然豁免）
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
| `scope` | `public\|private` | ❌ | `private` | 角色归属域：`public` 公共角色全局共享单一源、可被任意预设引用为成员；组长不能是公共角色 |

**校验（启动期）：** `brain` 必须存在；配置了 `systemPrompt` 时文件必须存在；无 Tool Call 能力的 brain 不得配置 `senseGroup` / `mcpServers`。

**公共 / 私有语义：** `scope: 'public'` 表示公共角色——全局共享单一源、不归属任何预设，可被任意预设引用为成员（引用不复制，改动对所有引用预设生效）。缺省或 `private` 为预设内私有角色（归属单一预设、删除连全局删）。**组长（`presets.<name>.leader`）必须是私有角色，不能是公共角色**——这是 `validateRawConfig` 的硬校验，保存时违反会报错。模板中解释角色 `explanation` 是固定预设 `cheryNyxus` 的种子公共角色（由固定预设成员推导，禁止删除）；`curator` / `roleArchitect` / `roleAcceptance` 是**系统锁定角色**（`lock: true`、非公共），供 cheryNyxus 内部流程使用，保留在固定预设成员内以保证 `spawn_role` 可派发。旧配置无 `scope` 字段时，设置页按「固定预设成员（非组长、非锁定）」推导为公共。

## presets.<name> 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ❌ | 稳定身份；改名时必须保留 |
| `leader` | string | ✅ | 主角色名（必须在同预设的 `roles` 内，且存在于 `roles` 顶层；不能是 `scope: 'public'` 的公共角色） |
| `roles` | string[] | ✅ | 该预设启用的角色列表（含 `leader`）；每个角色必须存在于 `roles` 顶层 |
| `detailRole` | string | ❌ | 节点详情解释角色；必须是本预设成员且不能等于 leader |
| `shadows.conversationRouting` | string | ❌ | 会话路由 Shadow；其工具组必须且只能包含 `select_conversation:auto` |
| `workspace` | string | ❌ | 工作目录绝对路径；缺省时不注入 workspace 提示 |
| `schedule` | object | ❌ | 定时任务 `{cron, task, enabled?}` |
| `rule` | string | ❌ | `.chery/rule/` 下的 smart 监管规则覆盖文件名 |

## server 字段

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `port` | number | 8182 | WebSocket 监听端口 |
| `transport` | enum | `binary` | 传输格式：`binary` / `json`（详见 [协议](../../../../docs/shared/protocol/websocket.md)） |
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

> ⚠ `workspace_browse` 是 **server 侧专属**：被 `config.get` 剥离（设置面板不可编辑）、`config.save` 原样保留；改配置需直接编辑 `.chery/config.yaml` 后重启生效。载荷加密为混淆级（协议见 [协议](../../../../docs/shared/protocol/websocket.md) `config.workspace.browse.*`）。

> ⚠ Web 静态服务端口原 `web_port` 已废弃，改由环境变量 `WEB_PORT`（默认 8183）指定。

## manager 字段

本地管理器（`apps/manager/` 独立进程，管理页面端口固定 39980）的监听配置，**server 侧专属**。

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `host` | string | `127.0.0.1` | 管理器监听地址。`0.0.0.0` 或具体内网 IP 开放内网访问；访问需携带启动日志 URL 上的管理密钥（`?token=` / `X-Chery-Manager-Token` 请求头 / 密钥 Cookie） |

> ⚠ `manager` 是 **server 侧专属**：被 `config.get` 剥离（设置面板不可编辑）、`config.save` 原样保留；改配置需直接编辑 `.chery/config.yaml` 后重启管理器生效。监听地址优先级：环境变量 `CHERY_MANAGER_HOST` > `manager.host` > 默认。

> 🔴 **开放内网访问有严重安全风险**：同网段任意设备都可访问管理页（唯一的保护是启动日志里的管理密钥，密钥持久化于 `.chery/manager-token.json`、每 7 天自动轮换），可查看 / 修改后端登录凭据、启停后端与中转。仅在受信任网络使用，用后改回 `127.0.0.1`。

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
2. `presets.*.leader` 必须引用 `roles` 中的角色，并包含于该预设的 `roles`；**且不能是 `scope: 'public'` 的公共角色（组长必须是预设私有角色）**
3. `presets.*.workspace` 可缺省；保存时非绝对路径为错误，不存在或不可访问为告警
4. `global.supervision` 必须是 `auto|smart|manual`
5. `sense_groups.*[]` 的 `:level` 后缀必须合法
6. `llm.brain.*` 的 `model` / `provider` / `contextLimit` 必填；所选协议与连接分支要求的 `url` / `key` 必填
7. 无 Tool Call 能力的 brain 不得配置 `mcpServers`；`senseGroup` 仅允许显式绑定前置理解工具时保留
8. **完整保存与启动读取分离**：启动读取容忍未完成的模板占位以便进入设置修复；完整候选保存（`config.preview` / `config.save` / `config_manage(patch)`）严格检查所选分支必填项及 `$ENV` 引用是否非空，未使用分支的缺失环境变量继续作为软警告提示

## 关联

- 模板加载：[config.ts](../../src/utils/config.ts) `loadConfig()`
- 类型定义：[config.ts](../../src/utils/config.ts)
- 校验逻辑：[config.ts](../../src/utils/config.ts) `validateRawConfig()`
- RPC：`config.get` / `config.save` / `config.workspace.validate`（设置面板读写）
- 同步规则：模板只初始化全新 workspace；已有 `.chery/config.yaml` 不做整文件覆盖
- AI 修改入口：见 [`./README.md`](./README.md)「AI 自动修改配置」章节
