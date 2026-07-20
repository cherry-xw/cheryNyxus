# error-troubleshooting — 错误排查指引

> 给 AI 看的「错误 → 设置项」对照表。
> 当 AI 把后端抛出的错误信息呈现给用户（toast / banner / 聊天流）时，按本文档的分类定位**该让用户改哪个设置**。
>
> **Why**：错误信息按 [docs/error-conventions.md](../../docs/error-conventions.md) 只带 `tracingId` + 一行中文，用户无法仅凭消息字面知道去哪个面板改什么。本文档维护**唯一权威映射**——AI 不要凭直觉给建议，先查这里。
>
> **How to apply**：
> 1. 看到错误信息 → 在下表**按消息片段**或 `[tracingId]` 反查
> 2. 告知用户「去 `[设置入口]` 改 `[字段]`」——参考原文措辞，避免乱造
> 3. 用户报 `[tracingId]` 时按 [§日志检索](#日志检索) 查完整上下文

## 文档约定

- **错误信息**：直接抄自源码 `throwUserFacing` / `ClassifiedError.userMessage`，保证匹配命中
- **消息前缀**：用户面消息**以 `[8 位 hex] ` 开头**（`COMPLIANT_TRACE_PATTERN = /^\[[0-9a-f]{8}\] /`）——8 位是 UUID v4 前 8 截取
- **设置项**：标注 `.chery/config.yaml` 中的字段路径、对应 RPC（如 `config.save`）、或前端入口
- **状态枚举**：`✓ 已实施`（源码已 throw 该消息）/ `审视`（路径存在但未覆盖，临时可能裸抛）

## 总表：错误消息 → 设置项

按**来源（source）**分组，组内按**配置相关性**倒序排。

### 来源：brain（LLM 大脑）

最常见，几乎全部与 `llm.brain.<name>` 配置相关。

| 用户面消息（含 `[tracingId]` 前缀示例） | 触发条件 | 设置项 / 排查 | 状态 |
|---------------------------------|----------|--------------|------|
| `[xxxxxxxx] 大脑没配好（缺 model 或地址），请在设置里检查` | brain 缺 `model` 或 `url` | `llm.brain.<name>.model` / `.url`；切换/新建 brain 见 [./config.md#llmbrain-name-字段](./config.md#llmbrain-name-字段) | ✓ |
| `[xxxxxxxx] 大脑的钥匙没配好（<model>），请在设置里检查` | brain 缺 `key` 或 `key` 仍是 `$ENV` 占位符（环境变量未注入） | `llm.brain.<name>.key`——支持 `$VAR` 从环境注入；查进程 env 或 `.env` 是否设置；详见 [./config.md#env-占位符](./config.md#env-占位符) | ✓ |
| `[xxxxxxxx] 大脑的钥匙不对，请在设置里检查 key` | 上游返回 HTTP 401/403（OpenAI / Anthropic / BigModel / 兼容聚合） | `llm.brain.<name>.key`——可能 key 失效、过期、被吊销、或填到了错的 brain；同 key 在 OpenAI 控制台自测 | ✓ |
| `[xxxxxxxx] 脑子忙不过来了，稍后再试` | 上游返回 HTTP 429（限流）或上游 provider 类错误 | `llm.brain.<name>.rpm`——降低或留空；切到备用 brain；等待上游恢复 | ✓ |
| `[xxxxxxxx] 脑子出了点状况，稍后再试` | 上游返回 HTTP 5xx（服务端故障） | 稍后重试；持续失败则检查上游状态页或切换 brain | ✓ |
| `[xxxxxxxx] 脑子回话不太对` | 上游返回其他非 2xx（如 400 业务错误） | 检查 `model` 拼写是否被上游识别；查上游返回详情（日志 `req.no_schema` / 上游 snippet） | ✓ |
| `[xxxxxxxx] 连不上我的脑子了` | DNS / TCP / TLS 连接失败（ECONNREFUSED / ENOTFOUND / fetch failed） | `llm.brain.<name>.url`——自测 `curl <url>`；Ollama 场景确认 `ollama serve` 已启动并监听 | ✓ |
| `[xxxxxxxx] 脑子反应太慢了` | 网络或上游超时（`timeout` / `timed out` 关键词命中） | 调大 `global.sense_execute_timeout`（不直接治大脑，仅放宽感受官超时）；排查网络链路；切换 brain | ✓ |
| `[xxxxxxxx] 脑子没听懂这个请求` | provider 返回 4xx 校验类错误（schema / 参数非法） | 检查 `model` 是否支持当前 thinking 档位（[./model-thinking.md](./model-thinking.md)）；某些 o1 系模型不接 `tools` 时降级或换 brain | ✓ |
| `[xxxxxxxx] 脑子出了点小问题` | 兜底（`unknown` 分类） | 看日志 `compose.unhandled` 还原上下文；必要时切换 brain | ✓ |

### 来源：system（compose 兜底 / RPC router）

来自中间件链顶层 catch 与 RPC 路由校验。

| 用户面消息 | 触发条件 | 设置项 / 排查 | 状态 |
|----------|----------|--------------|------|
| `[xxxxxxxx] 系统连不上了` | `compose.unhandled` 兜底命中 `network` 关键词 | 网络层故障；查 `.chery/logs/` 当天文件；按 tracingId 还原 | ✓ |
| `[xxxxxxxx] 系统等太久了` | `compose.unhandled` 兜底命中 `timeout` | 调大 `global.sense_execute_timeout` / `global.approval_timeout`；切更快的 brain | ✓ |
| `[xxxxxxxx] 系统出了点状况` | `compose.unhandled` 兜底命中 `provider` | 同 `provider` 类——多为上游 5xx；查上游状态 | ✓ |
| `[xxxxxxxx] 系统没听懂这个请求` | `compose.unhandled` 兜底命中 `validation` | Zod 校验或参数非法；通常为前端发参 bug；查 `req.invalid_params` 日志 | ✓ |
| `[xxxxxxxx] 系统出了点小问题` | `compose.unhandled` 兜底 `unknown` | 未知错误；查 `compose.unhandled` 日志 `cause` 链 | ✓ |
| `[xxxxxxxx] 系统出了点小问题` | RPC router 无 schema 覆盖（`req.no_schema`） | **代码缺失**——非用户可修；记 tracingId 上报 | ✓ |
| `[xxxxxxxx] 当前版本不支持此操作，请更新后重试` | 前端调了未注册的 RPC `method` | 前端版本过旧或不匹配——升级前端 / 重启后端对齐 | ✓ |

### 来源：chat（会话生命周期）

chat.send 路径前置校验。

| 用户面消息 | 触发条件 | 设置项 / 排查 | 状态 |
|----------|----------|--------------|------|
| `这个会话不见了` | `chat.send` 收到不存在的 `chatId` | 前端重连后丢失本地状态——刷新页面 / 新建 chat | ✓（未走 throwUserFacing，文案以 message 形式抛到 handler，streamMapper 仍前置 tracingId） |
| `操作的目标已改变` | `chat.send` 绑定 chatId 时检测到当前活跃 runtime 与该 chat 不匹配 | 中断当前 chat，重发消息 | ✓ |

### 来源：hook（钩子系统）

钩子 handler 抛错或显式阻断。**唯一会让用户「被 hook 拦截」感受的来源**——message 直接来自 handler 的 `reason` 字段。

| 用户面消息 | 触发条件 | 设置项 / 排查 | 状态 |
|----------|----------|--------------|------|
| `[xxxxxxxx] <reason 由 hook 脚本提供>` | hook handler exit 2 + stderr 写入 reason，或 `decision: "block"` + `reason` | 检查 `.chery/hooks/hooks.json` 对应事件下的 handler；临时关闭 hook：`mv .chery/hooks/hooks.json .chery/hooks/hooks.json.bak` 然后重启 | ✓ |
| `[xxxxxxxx] 钩子启动失败` | hook 进程 spawn 失败（sh 不存在 / 权限不足） | 检查 handler `command` 字段；确保 `sh` 可用且 `.chery/hooks/*.sh` 有执行权限 | ✓ |
| `[xxxxxxxx] 钩子执行超时` | handler 超过 `timeout`（默认 10s） | 调高 `handler.timeout`；优化脚本逻辑 | ✓ |
| `[xxxxxxxx] 钩子执行失败` | handler spawn 阶段非零退出（非 2） | 看 `.chery/logs/` 中 `hook.failed` 日志（含 `stderr` 截断）；修脚本 | ✓ |

> hook 阻断是**预期功能**——若配置 hook 是为审计/限流，告诉用户这是策略生效而非 bug。

### 来源：sense（感官）

感官执行错误。当前 `ClassifiedError` 路径由各感官直接抛；`source: "sense"` 经 compose catch 走 `friendlyMessage("感官...")` 兜底映射。

| 用户面消息 | 触发条件 | 设置项 / 排查 | 状态 |
|----------|----------|--------------|------|
| `[xxxxxxxx] 感官连不上了` | 感官网络类错误（如 `execute_command` 启动子进程失败） | 查感官配置（`.chery/senses/*.ts`）；调高 `global.sense_execute_timeout` | 审视 |
| `[xxxxxxxx] 感官反应太慢了` | 感官超时（命中 `global.sense_execute_timeout`） | `global.sense_execute_timeout` 调大；优化感官 handler | 审视 |
| `[xxxxxxxx] 感官出了点状况` | 感官 provider 类错误 | 查感官实现；通常为脚本 bug | 审视 |
| `[xxxxxxxx] 感官没听懂这个请求` | 感官参数校验失败（Zod schema 不通过） | 检查感官调用参数；常见为 LLM 生成参数不合规 | 审视 |
| `[xxxxxxxx] 感官出了点小问题` | 感官兜底 `unknown` | 查日志 `sense.*` scope | 审视 |
| `审批等待超时` | 用户长时间未在 `confirm` / `manual` 监管下点确认 | 调高 `global.approval_timeout`；或降低 `global.supervision` 等级（auto 静默 / confirm 弹一次） | 审视 |

### 来源：media / mcp（占位）

当前模板未启用，留作扩展。

| 用户面消息 | 触发条件 | 设置项 / 排查 | 状态 |
|----------|----------|--------------|------|
| `[xxxxxxxx] 媒体出了点状况` | 媒体网关错误（未来扩展） | `.chery/config.yaml` 中 `media.*` 段（当前未启用） | TODO |
| `[xxxxxxxx] 扩展工具出了点小问题` | MCP server 异常 | `roles.<role>.mcpServers`（当前为空数组） | TODO |

## 错误分类到设置的快查树

按用户报错的**场景**倒推，不查表也能覆盖 80% 场景：

```
用户报"X 出问题了"
  ├─ X = "脑子" / 提到 AI / 提到模型 → brain（看 brain 表）
  │    ├─ 401/403 / "钥匙不对"     → 检查 llm.brain.<name>.key
  │    ├─ "没配好"                  → 检查 llm.brain.<name>.model / .url / .key
  │    ├─ 429 / "忙不过来"          → 调低 llm.brain.<name>.rpm 或换 brain
  │    ├─ "连不上"                  → 检查 llm.brain.<name>.url + 网络
  │    └─ "反应太慢"                → 调 sense_execute_timeout / 换脑
  ├─ X = "感官"                    → sense（看 sense 表）
  │    ├─ "超时"                    → global.sense_execute_timeout
  │    ├─ "审批超时"                → global.approval_timeout / supervision 等级
  │    └─ "没听懂"                  → 感官 schema / LLM 调参问题
  ├─ X = "钩子" / "被拦截"          → hook（看 hook 表）
  │    └─ 看 .chery/hooks/hooks.json + log hook.failed
  ├─ X = "会话" / "chat 不见了"     → chat（看 chat 表）
  │    └─ 刷新页面 / 新建 chat
  ├─ X = "系统"                    → system（看 system 表）
  │    └─ 多为上游/前端/网络问题；按 tracingId 查日志
  └─ 无 X 前缀（裸 "[xxxxxxxx] X"）
       └─ 仍是合规错误（throwUserFacing 出口），按 X 关键词查上方分类
```

## 日志检索

收到用户报 `[tracingId]` 时，按 8 位 hex 还原日志：

```bash
# 项目根
grep "1c538629" .chery/logs/

# 全局更稳（tracingId 在日志 JSON 事件 data.tracingId）
grep -r '"tracingId":"1c538629"' .chery/

# 按 logger scope 过滤（推荐先定位 scope）
grep -r "compose.unhandled\|llm.key.missing\|req.invalid_params" .chery/logs/ | grep "1c538629"
```

日志格式与查询详见 [../../docs/utils/logger.md](../../docs/utils/logger.md)。

**让用户提供 tracingId 的标准话术**：

> 「请把完整错误信息（含 `[xxxxxxxx]` 那段）发我，我帮你查日志。」

## 用户改设置前的提示模板

按设置面板入口给出指向性话术：

### 改 LLM brain

> 「去 **设置 → 大脑** 页，[找/新建/切换] `<brain 名>`，检查：
> - **模型** 字段填对（如 `claude-sonnet-4-5` / `gpt-4o`）
> - **地址** 字段（OpenAI 兼容通常不用填；Ollama 填 `http://localhost:11434/v1`）
> - **钥匙** 字段：直接填 key 或用 `$ENV_VAR` 形式（确认环境变量已注入）
>
> 改完点保存，**重启后端生效**（配置不热更）。」

### 改感官监管等级

> 「去 **设置 → 感官 / 监管** 页，把 `global.supervision` 从 `confirm` 降到 `auto`（或反之），或为具体感官配置 `:level` 后缀。改完保存，**重启生效**。」

### 关闭 hook 临时排查

> 「临时把 `.chery/hooks/hooks.json` 改名为 `hooks.json.bak`，重启后端。如果错误消失，问题在 hook handler 脚本；修脚本后改回。」

### 调高超时

> 「去 **设置 → 全局** 页，把 `sense_execute_timeout`（默认 10000ms）和 `approval_timeout`（默认 30000ms）调大。改完保存重启。」

### 让用户提供日志

> 「如果你想自己看日志，错误带 `[xxxxxxxx]` 那 8 位是 tracingId。在项目根跑：
> ```
> grep 'xxxxxxxx' .chery/logs/
> ```
> 把命中的几行发我，我能更准确定位。」

## 实施原则

1. **不创造新错误出口**——新错误遵循 [../../docs/error-conventions.md](../../docs/error-conventions.md)（throwUserFacing / ClassifiedError），本表随源更新
2. **不向用户暴露技术字段**——错误信息禁止带 HTTP status / request id / 栈帧；引导改设置而非"反馈开发"
3. **advice 不超出本表**——AI 给用户的设置项建议必须能映射到上表某行；映射不到的转人工
4. **更新本文档**：任何 throwUserFacing / ClassifiedError.userMessage 新增 / 修改 → 同步本表对应行
5. **状态标注**：`✓ 已实施` 来自源码确认；`审视` 表示路径存在但未全覆盖；`TODO` 表示模块未启用——`审视`/`TODO` 行发生概率较低，给用户建议前先验证

## 关联

- 错误分层规范（必读）：[../../docs/error-conventions.md](../../docs/error-conventions.md)
- 主配置字段：[./config.md](./config.md)
- 模型思考档位：[./model-thinking.md](./model-thinking.md)
- 钩子配置：[./hooks.md](./hooks.md)
- 自定义感官：[./senses.md](./senses.md)
- 索引：[./README.md](./README.md)
