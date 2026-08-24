# AI 配置管理（config_manage 感官 + 自动备份回滚）

> 源码 [src/agent/sense/configManage.ts](../../src/agent/sense/configManage.ts) ｜ [src/utils/config.ts](../../src/utils/config.ts)（`saveRawConfig` 备份）｜ 上级 [agent](./README.md) ｜ 相关 [./skill-install.md](./skill-install.md)（install_skill 感官）、[../core/sense.md](../core/sense.md)（感官注册）、[./middleware.md](./middleware.md)（守卫在 tool middleware）

## 职责

Cherry Nexus（`cheryNyxus`）是**唯一**被授权直接管理 `.chery/` 配置的角色。通过 `config_manage` 感官完成对 `config.yaml` 的读改写（roles / sense_groups / global / llm 等完整配置域），`saveRawConfig` 写盘层统一做历史备份，出错可回滚。

用户诉求（核心定位）：「Cherry Nexus 是一个核心角色，主要任务是管理所有角色配置相关的任务」「在修改完配置并生效之前，需要对历史配置做一份备份。如果修改出错，可以及时回滚到旧的配置项」。

## config_manage 感官（[configManage.ts](../../src/agent/sense/configManage.ts)，smart 监管）

### 与 install_skill 的关系

- `config_manage` 是**结构化感官**：action 参数必填（get / save / rollback），不携带路径 → `extractSensePaths` 对非文件类感官返回 `[]` → **天然不触发 `.chery/` 路径守卫**（[pathGuard.ts](../../src/utils/pathGuard.ts) 只对 write_file/read_file/search_codebase/execute_command 提取路径）。缺/未知 action → fail-loud 返回用法引导，**绝不静默兜底为 rollback**（避免误触无备份回滚、误报"备份目录不存在"）。
- 因此无需修改 `GUARD_EXEMPT` 白名单，`config_manage` 即可读写 `.chery/config.yaml`。
- 仅 Cherry Nexus 的 senseGroup（`chery_nexus`）含 `config_manage` → 其他角色 senseTable 无此感官 → 调不到（角色隔离）。

**工具级读取放行（能力驱动）**：配置管理核心角色（senseTable 含 `config_manage`/`install_skill`）经 [tool.ts doExecuteSense](../../src/agent/middleware/tool.ts) 接线——`authorizeToolCall` 传 `filesystemRead: 'any'`（read_file/search_codebase 读放行，绕过 filesystem workspace 校验）、`checkCheryGuard` 传 `allowConfigRead: true`（读 `.chery/` 全树放行）。唯一拦截点是 [envGuard.ts](../../src/utils/envGuard.ts) 对 `.env` 敏感 key 值的后置遮蔽（key 名保留、值 → `[REDACTED]`）。`write_file` 对 `.chery/` 仍拦、`execute_command` 对 `.chery/` 的**修改**仍拦——写走 `config_manage`（结构化脱敏），`execute_command` 的 `cat .chery/config.yaml` 会泄露非 .env 字面密钥，故不放行；但 `ls/dir/find/stat` 等**信息获取**命令（无文件重定向/命令替换/读写动词）放行，便于目录盘点。

### schema（action 三态）

> **陷阱提醒**：不可用 `z.discriminatedUnion('action', [...])`——其转 JSON Schema 时顶层 `required`/`properties` 丢失（仅 `oneOf` 分支内部有），`senseCreator` 以 `required ?? []` 兜底 → 模型端 tool 定义 `required: []`，action 不再被强制，LLM 会漏传（历史事故见 [prompt-guide.md](./prompt-guide.md) 规范 #3）。必须用普通 object + enum，保证 `toJSONSchema().required` 含 `action`。

```ts
z.object({
  action: z.enum(['get', 'save', 'rollback']).describe('操作类型，必填：get 读取 / save 保存 / rollback 回滚'),
  config: z
    .record(z.unknown())
    .optional()
    .describe('save 用：完整配置对象（roles/sense_groups/global/llm/presets 等 config.yaml 字段；server 段保留不动）。由 config_manage(action="get") 返回的完整脱敏配置改造，未改字段保留原值；敏感 key 字段可原样传回 [REDACTED] 哨兵（自动保留盘上原值）'),
  backup: z.string().optional().describe('rollback 用：回滚目标备份文件名（.chery/backups/ 下，缺省最近一份）'),
})
```

### action 行为

| action | 行为 | 返回 |
|--------|------|------|
| `get` | `readRawConfig()` 读盘（剥离 server 段），经 `redactConfigSecrets` 脱敏后返回**完整配置** | 完整 `config.yaml`（key 为 `$ENV` 占位符原样 / `[REDACTED]` 哨兵）+ `backups` 回滚点；可直接 round-trip 传回 save |
| `save` | 先 `readRawConfig()` 读盘 → `restoreRedactedSecrets` 还原 `[REDACTED]` 为盘上原值 → 复用 `saveRawConfig()`（校验 + 锁角色/固定预设编辑校验 + 写回） | `ok` / `errors`+`warnings`（失败不落盘） |
| `rollback` | 从 `.chery/backups/` 恢复指定/最近备份到 `config.yaml` | 恢复的文件名 + 时间；**无备份**时自愈创建备份目录并返回可行动报错（"尚无可用备份，首次 action='save' 后才会生成"），不抛异常 |
| （缺/未知 action） | 不执行任何操作，返回用法引导 | `config_manage` 必须显式指定 action（get / save / rollback）；请先调用 `action="get"` |

### 敏感字段脱敏（round-trip 契约）

配置中 `llm.brain.*.key`、`media.*.key`、`mcp_servers.*.env`（子进程环境变量值）等字段含密钥/令牌，不随 `get` 原文暴露给模型：

> **两层脱敏的区别**：本节 `redactConfigSecrets`/`restoreRedactedSecrets` 是 **config_manage 结构化脱敏**（配置对象级：`$ENV` 占位符保留、明文 key → `[REDACTED]`，save 可 round-trip 还原）；另有 **envGuard 工具输出层脱敏**（`redactEnvKeys`，[tool.ts doExecuteSense](../../src/agent/middleware/tool.ts) L474）——对 read_file/search_codebase/execute_command 等所有工具输出统一遮蔽 `.env` 敏感 key 的值（key 名保留、值 → `[REDACTED]`），防 `.env` 原文经普通文件读取泄露。两者互补：`read_file('.env')` 过 envGuard 值遮蔽；`read_file('.chery/config.yaml')` 会拿到字面密钥（未过 `redactConfigSecrets`）——设计内接受，建议优先 `config_manage(action="get")`（结构化脱敏）。

- **`$ENV` 占位符**（值形如 `$OPENAI_KEY`，匹配 `/^\$[A-Z_][A-Z0-9_]*$/`）**原样保留**——运行时由 `replaceEnvVars` 从进程环境注入，占位符本身非敏感。
- **明文密钥** → 替换为 `[REDACTED]` 哨兵。
- **save 还原**：`restoreRedactedSecrets(partial, disk)` 将 partial 中值为 `[REDACTED]` 的敏感字段用盘上原值替换，再走 `saveRawConfig`。因此模型 get → 改无关字段 → save 传回 `[REDACTED]` 不会覆盖真实 key；若模型显式给出**新明文值**（非 `[REDACTED]`），则以新值为准（允许换 key）。
- 实现：[redactConfigSecrets](../../src/utils/config.ts) / [restoreRedactedSecrets](../../src/utils/config.ts)（均深拷贝，不改入参）。

### 使用流程（提示词约束）

1. **get**：读完整脱敏配置（roles/sense_groups/global/llm/presets 全量，key 为 `$ENV`/`[REDACTED]`），对照 `.chery.template/docs/` 字段参考表定位目标字段
2. **确认**：用 `ask_user_question` 把变更呈现给用户确认（含改动前后对比、影响范围）
3. **save**：基于 get 返回对象改动目标字段后整体传回（未改字段保留原值；`[REDACTED]` 原样保留即可），`saveRawConfig` 层自动备份旧配置
4. **失败处理**：校验失败 → 不落盘，回报错误原文；已落盘但发现问题 → `rollback` 回滚后基于旧配置 + 报错信息重试
5. **重启提示**：配置不热更（运行时内存单例），必须告诉用户重启；重启前系统会做 dry-run 预检（见下），通过才重启，失败自动回滚不重启

### 重启前预检（dry-run）

配置保存后不立即重启：`restartCoordinator` 通知守护进程替换 worker 前，先跑 [validateLoadable](../../src/utils/config.ts) 预检——

- 读盘 `config.yaml` → 深拷贝模拟 `loadConfig` 校验：`validateRawConfig` 全量业务校验（`loadConfig` 阶段 throw 的唯一来源，硬错误；**含 `roles.*.systemPrompt` 文件存在性**——缺失会导致 loadConfig throw）→ 结构硬错误，阻塞重启。
- `$ENV` 占位符指向缺失变量 → **软警告，不阻塞**（与启动期 `loadConfig` 一致只 warn）：缺失 key 不破坏配置结构，运行期实际调用该 brain 时由 `assertChatOptions` 抛用户可见的 `llm.key.missing`；未使用的 brain key 缺失更不应卡住整个保存/重启流程。软警告随保存成功响应（`warnings`）与日志（`config.save.warnings` / `config.restart.warnings`）带出，仅提示。
- 预检通过 → 正常重启；预检失败（仅结构硬错误）→ **自动回滚最近备份 + 通知前端 toast「配置预检未通过，已回滚，未重启」**，进程保持运行（避免坏配置 crash-loop 永不恢复）。
- 被"提问挂起 / 审批挂起 / running"中断的任务，重启后由 `reconcileOrphanedExecutionRuns` 恢复为 paused（可经现有「继续」按钮续跑）。

## 自动备份回滚（[saveRawConfig](../../src/utils/config.ts) 写盘层）

### 备份时机

`saveRawConfig` 是配置写盘**唯一入口**（前端 config.save RPC 与 `config_manage` 感官 save 均走此）。写盘前将当前盘上 `config.yaml` 复制到备份目录：

```
.chery/backups/config-<YYYYMMDD-HHmmss>.yaml
```

### 保留策略

- 备份目录：`.chery/backups/`（自动创建）
- 只保留**最近 10 份**：写入新备份后清掉最旧的超出部分
- 回滚：`config_manage(action="rollback")` 或手动从 backups/ 恢复

### 边界

- 备份是**写盘前快照**（保存的是修改前的旧配置），回滚即恢复到修改前状态
- `validateRawConfig` / `validateLockedRoleEdits` / `validateFixedPresetEdits` 校验失败时**不写盘、不产生备份**
- 备份与配置同目录族（`.chery/`），天然被 pathGuard 保护（config_manage 之外的角色无法直接读写）

## 角色配置（.chery.template/config.yaml）

```yaml
sense_groups:
  leader:              # 纯组长组（coordinator 等）：不配配置管理感官，配置需交 Cherry Nexus
    - read_file
    - skill
    - write_file
    - execute_command
    - search_codebase
    - spawn_role
    - ask_user_question
    - history_recall
  chery_nexus:         # Cherry Nexus 专属组：组长能力 + 配置管理（install_skill/config_manage 独占）
    - read_file
    - skill
    - write_file
    - execute_command
    - search_codebase
    - spawn_role
    - ask_user_question
    - history_recall
    - install_skill             # 技能安装（Cherry Nexus 职责）
    - config_manage             # 配置管理（Cherry Nexus 独占）
roles:
  cheryNyxus:
    brain: my-brain
    senseGroup: chery_nexus
    mcpServers: []
    systemPrompt: prompt/cheryNyxus/cheryNyxus.md
    lock: true                  # 锁定禁止前端删除/改名（保护配置管理能力）
```

persona [`.chery.template/prompt/cheryNyxus/cheryNyxus.md`](../../.chery.template/prompt/cheryNyxus/cheryNyxus.md)：配置管理核心角色 + 桌宠组长。核心任务 = 管理所有角色配置相关任务；也作为组长派发业务子任务。

## 文件清单

| 文件 | 职责 |
|------|------|
| [src/agent/sense/configManage.ts](../../src/agent/sense/configManage.ts) | `config_manage` 感官（get/save/rollback） |
| [src/agent/sense/index.ts](../../src/agent/sense/index.ts) | import + `registerBuiltinSenses` + `BUILTIN_SENSE_TOOLS` |
| [src/utils/config.ts](../../src/utils/config.ts) | `saveRawConfig` 写盘前自动备份（保留最近 10 份）+ `redactConfigSecrets`/`restoreRedactedSecrets` 敏感字段脱敏/还原 |
| [test/utils/configSecretRedact.test.ts](../../test/utils/configSecretRedact.test.ts) | 脱敏（`$ENV` 保留 / 明文→`[REDACTED]`）与还原（`[REDACTED]`→盘上原值 / 新明文覆盖）测试 |
| [.chery.template/prompt/cheryNyxus/cheryNyxus.md](../../.chery.template/prompt/cheryNyxus/cheryNyxus.md) | Cherry Nexus persona |
| [.chery.template/config.yaml](../../.chery.template/config.yaml) | sense_groups.chery_nexus（含 config_manage）+ roles.cheryNyxus |

## 依赖与关联

| 依赖 | 用途 |
|------|------|
| [utils/config](../../src/utils/config.ts) | `readRawConfig` / `saveRawConfig` / `redactConfigSecrets` / `restoreRedactedSecrets` / `ConfigRaw` |
| [core/sense/senseCreator](../../src/core/sense/senseCreator.ts) | `sense()` 工厂（name/description/schema/handler/supervisionLevel） |
| [utils/pathGuard](../../src/utils/pathGuard.ts) | `extractSensePaths` 对非文件感官返回空 → 天然豁免 |

## 扩展点

### 备份保留份数

`src/utils/config.ts` 的备份清理常量（`BACKUP_KEEP`，默认 10）。改小 → 少占磁盘；改大 → 更多回滚点。

### 新增配置域

`config_manage` 的 save 复用 `saveRawConfig`，覆盖 `config.yaml` 全部字段（roles/sense_groups/global/llm/presets）。未来新增配置域只需扩展字段参考表（`.chery.template/docs/config.md`），感官无需改。

### 其他配置文件的备份

`config_manage` 目前只管 `config.yaml`。`model-thinking.yaml` / `hooks/hooks.json` 的备份如需统一，可在备份函数中扩展文件清单。
