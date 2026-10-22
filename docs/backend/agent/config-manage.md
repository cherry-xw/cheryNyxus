# AI 配置管理（config_manage 感官 + 自动备份回滚）

> 源码 [apps/backend/src/agent/sense/configManage.ts](../../../apps/backend/src/agent/sense/configManage.ts) ｜ [apps/backend/src/service/config/operations.ts](../../../apps/backend/src/service/config/operations.ts)（强类型操作）｜ [apps/backend/src/service/config/commit.ts](../../../apps/backend/src/service/config/commit.ts)（候选提交）｜ 上级 [agent](README.md)

## 职责

原始读取、必填字段与完整候选保存遵守[设置保存契约](../../shared/protocol/websocket.md#设置原始值与保存校验)。大脑容量由用户明确设置，目录推荐不自动写入；省略可选字段恢复缺省，显式值即使等于默认也保留。必填环境引用必须能解析为非空值，错误返回字段路径，不泄露值。当前同步实施状态见[设置修复方案](../../plan/file-capabilities-and-model-collaboration/settings-defaults-design.md)。

cheryNyxus（`cheryNyxus`）是**唯一**被授权直接管理 `.chery/` 配置的角色。AI 不再回传整份配置，而是提交带 `baseRevision` 的强类型资源级增量操作。服务端从当前磁盘快照构造候选，完成全量校验后才备份、写盘，再由统一协调器按资源边界采用；只有进程级影响才进入受控重启流程。

用户诉求（核心定位）：「cheryNyxus 是一个核心角色，主要任务是管理所有角色配置相关的任务」「在修改完配置并生效之前，需要对历史配置做一份备份。如果修改出错，可以及时回滚到旧的配置项」。

## config_manage 感官（[configManage.ts](../../../apps/backend/src/agent/sense/configManage.ts)，smart 监管）

### 与 install_skill 的关系

- `config_manage` 是**结构化感官**：action 参数必填（get / patch / rollback；旧 save 仅用于返回迁移错误），不携带路径 → `extractSensePaths` 对非文件类感官返回 `[]` → **天然不触发 `.chery/` 路径守卫**。缺/未知 action → fail-loud 返回用法引导，绝不静默兜底。
- 因此无需修改 `GUARD_EXEMPT` 白名单，`config_manage` 即可读写 `.chery/config.yaml`。
- 仅 cheryNyxus 的 senseGroup（`cheryNyxus`）含 `config_manage` → 其他角色 senseTable 无此感官 → 调不到（角色隔离）。

**工具级读取放行（能力驱动）**：配置管理核心角色（senseTable 含 `config_manage`/`install_skill`）经 [tool.ts doExecuteSense](../../../apps/backend/src/agent/middleware/tool.ts) 接线——`authorizeToolCall` 传 `filesystemRead: 'any'`（read_file/search_codebase 读放行，绕过 filesystem workspace 校验）、`checkCheryGuard` 传 `allowConfigRead: true`（读 `.chery/` 全树放行）。唯一拦截点是 [envGuard.ts](../../../apps/backend/src/utils/envGuard.ts) 对 `.env` 敏感 key 值的后置遮蔽（key 名保留、值 → `[REDACTED]`）。`write_file` 对 `.chery/` 仍拦、`execute_command` 对 `.chery/` 的**修改**仍拦——写走 `config_manage`（结构化脱敏），`execute_command` 的 `cat .chery/config.yaml` 会泄露非 .env 字面密钥，故不放行；但 `ls/dir/find/stat` 等**信息获取**命令（无文件重定向/命令替换/读写动词）放行，便于目录盘点。

### schema（顶层普通 object + 嵌套强类型操作）

> **陷阱提醒**：不可用 `z.discriminatedUnion('action', [...])`——其转 JSON Schema 时顶层 `required`/`properties` 丢失（仅 `oneOf` 分支内部有），`senseCreator` 以 `required ?? []` 兜底 → 模型端 tool 定义 `required: []`，action 不再被强制，LLM 会漏传（历史事故见 [prompt-guide.md](prompt-guide.md) 规范 #3）。必须用普通 object + enum，保证 `toJSONSchema().required` 含 `action`。

```ts
z.object({
  action: z.enum(['get', 'patch', 'save', 'rollback' /* asset actions */]),
  baseRevision: z.string().optional(),
  operations: z
    .array(
      z.discriminatedUnion('op', [
        putBrainSchema,
        removeBrainSchema,
        putRoleSchema,
        removeRoleSchema,
        putPresetSchema,
        removePresetSchema,
        putSenseGroupSchema,
        removeSenseGroupSchema,
        putFileServiceSchema,
        removeFileServiceSchema,
        setFilePolicySchema,
      ]),
    )
    .optional(),
  backup: z
    .string()
    .optional()
    .describe('rollback 用：回滚目标备份文件名（.chery/backups/ 下，缺省最近一份）'),
})
```

顶层仍使用普通 object，确保 JSON Schema 的 `required` 明确包含 `action`。嵌套 operation 可使用 discriminated union；每个资源字段均有 number/boolean/string/array/object 的明确约束，不再使用 `z.unknown()`。运行时再做操作与参数的交叉必填校验。

### action 行为

| action             | 行为                                                                                                                 | 返回                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `get`              | 读盘并脱敏                                                                                                           | 完整配置（只用于定位资源）+ 覆盖全部可编辑字段的 `baseRevision` + 回滚点 + 各大脑只读能力来源与服务端工具观察 |
| `patch`            | 校验 revision → 在磁盘副本上应用 1–50 个资源操作 → 全量校验候选 → 备份并写盘 → 提交统一生效协调器 | 候选修订号、新 baseRevision、生效状态/影响项与软警告；任一步失败均不落盘 |
| `save`             | 不执行                                                                                                               | 明确说明全量 save 已停用，要求重新 get 后改用 patch                      |
| `rollback`         | 校验 baseRevision → 将指定/最近备份作为候选全量校验 → 通过统一提交入口保存与应用                                      | 恢复文件名、新 baseRevision 与实际生效状态                               |
| （缺/未知 action） | 不执行任何操作                                                                                                       | get/patch/rollback 用法引导                                              |

### 敏感字段脱敏

大脑能力说明与 Web 共用查询，规则见[当前连接的能力来源](model-capabilities.md#当前连接的能力来源)。目录推荐、实际工具观察与完整任务验证分开，读取说明不会发起模型请求。

配置中 `llm.brain.*.key`、`media.*.key`、`mcp_servers.*.env`（子进程环境变量值）等字段含密钥/令牌，不随 `get` 原文暴露给模型：

> **两层脱敏的区别**：本节 `redactConfigSecrets`/`restoreRedactedSecrets` 是 **config_manage 结构化脱敏**（配置对象级：`$ENV` 占位符保留、明文 key → `[REDACTED]`，patch 目标资源时可还原）；另有 **envGuard 工具输出层脱敏**（`redactEnvKeys`，[tool.ts doExecuteSense](../../../apps/backend/src/agent/middleware/tool.ts) L474）——对 read_file/search_codebase/execute_command 等所有工具输出统一遮蔽 `.env` 敏感 key 的值（key 名保留、值 → `[REDACTED]`），防 `.env` 原文经普通文件读取泄露。两者互补：`read_file('.env')` 过 envGuard 值遮蔽；`read_file('.chery/config.yaml')` 会拿到字面密钥（未过 `redactConfigSecrets`）——设计内接受，建议优先 `config_manage(action="get")`（结构化脱敏）。

- **`$ENV` 占位符**（值形如 `$OPENAI_KEY`，匹配 `/^\$[A-Z_][A-Z0-9_]*$/`）**原样保留**——运行时由 `replaceEnvVars` 从进程环境注入，占位符本身非敏感。
- **明文密钥** → 替换为 `[REDACTED]` 哨兵。
- **patch 还原**：当 `putBrain` 等目标资源携带 `[REDACTED]` 时，提交边界用盘上原值还原；显式给出新明文值才会替换。未被操作触及的资源天然保持不变。
- 实现：[redactConfigSecrets](../../../apps/backend/src/utils/config.ts) / [restoreRedactedSecrets](../../../apps/backend/src/utils/config.ts)（均深拷贝，不改入参）。

### 使用流程（提示词约束）

1. **get**：读完整脱敏配置并记录 `baseRevision`，对照字段参考定位目标资源
2. **确认**：用 `ask_user_question` 把变更呈现给用户确认（含改动前后对比、影响范围）
3. **patch**：原样传回 revision，只提交目标资源的 `put/remove`；删除 role/preset 时带 `expectedId`
4. **失败处理**：类型/引用/锁定/workspace/revision 任一失败均不落盘；revision 过期重新 get 后重新核对
5. **生效提示**：局部设置按操作/运行/资源边界应用；语义变化等待受影响节点树安全边界；只有进程级影响显示重启待办

### 保存结果与失败边界

`patch` 和 `rollback` 的成功结果同时包含 `baseRevision`（已保存候选）、`candidateRevisionId`、`savedRevision`、`appliedRevision`、逐项 `impacts` 与 `warnings`。不得把 `ok: true` 简化为“全部已生效”：

- `status=applied` 表示所有已登记资源已采用候选；`pending` 表示至少一项仍在等待安全边界；`failed` 表示至少一项未采用。
- 每项 impact 的 `boundary` 表示采用位置：`operation`、`run`、`resource`、`tree`、`restart` 或 `unsupported`；`reason` 和 `affectedRootChatIds` 解释等待或失败的对象。
- 校验、过期 revision、预览令牌、写盘失败会使请求失败且不应宣称保存成功。写盘后审计登记或资源应用失败则可能出现“已保存但未生效”；旧运行态仍可用，不伪造整体回滚。
- 删除 role 或 preset 前必须先用 preview 获得未过期令牌，并采用 `wait` 策略。AI 不得为了尽快生效自动取消提问、审批、子任务或后台命令。

收到 revision 过期响应时，重新执行 `get`，重新展示当前状态与预期变更，再由用户确认后提交；不得用旧 `baseRevision` 重试覆盖其他窗口或手工编辑。

### 重启前预检（dry-run）

候选写盘前由 [commit.ts](../../../apps/backend/src/service/config/commit.ts) 完成两层预检——

- 读盘 `config.yaml` → 深拷贝模拟 `loadConfig` 校验：`validateRawConfig` 全量业务校验（`loadConfig` 阶段 throw 的唯一来源，硬错误；**含 `roles.*.systemPrompt` 文件存在性**——缺失会导致 loadConfig throw）→ 结构硬错误，阻塞重启。
- `$ENV` 占位符指向缺失变量 → **软警告，不阻塞**（与启动期 `loadConfig` 一致只 warn）：缺失 key 不破坏配置结构，运行期实际调用该 brain 时由 `assertChatOptions` 抛用户可见的 `llm.key.missing`；未使用的 brain key 缺失更不应卡住整个保存/重启流程。软警告随保存成功响应（`warnings`）与日志（`config.save.warnings` / `config.restart.warnings`）带出，仅提示。
- `validateConfigCandidate` 校验结构、凭证占位符、workspace、锁定角色和固定预设；`validateLoadable` 模拟启动加载。两者都在备份/写盘之前运行。
- 预检通过才写盘；结构失败不需要回滚，因为候选从未替换活动配置。
- 被"提问挂起 / 审批挂起 / running"中断的任务，重启后由 `reconcileOrphanedExecutionRuns` 恢复为 paused（可经现有「继续」按钮续跑）。后台 shell/MCP 子进程不承诺被透明重新接管；它们仍存活时会成为重启 blocker，必须结束、终止或由用户自行管理。

## 自动备份回滚（[saveRawConfig](../../../apps/backend/src/utils/config.ts) 写盘层）

### 备份时机

`saveRawConfig` 是最终配置写盘入口；前端 `config.save` 与 AI `config_manage(patch)` 均先经过共享 `commitConfigCandidate`。写盘前将当前盘上 `config.yaml` 复制到备份目录：

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
  leader: # 纯组长组（coordinator 等）：不配配置管理感官，配置需交 cheryNyxus
    - read_file
    - skill
    - write_file
    - execute_command
    - search_codebase
    - spawn_role
    - ask_user_question
    - history_recall
  cheryNyxus: # cheryNyxus 专属组：组长能力 + 配置管理（install_skill/config_manage 独占）
    - read_file
    - skill
    - write_file
    - execute_command
    - search_codebase
    - spawn_role
    - ask_user_question
    - history_recall
    - install_skill # 技能安装（cheryNyxus 职责）
    - config_manage # 配置管理（cheryNyxus 独占）
roles:
  cheryNyxus:
    brain: my-brain
    senseGroup: cheryNyxus
    mcpServers: []
    systemPrompt: prompt/cheryNyxus/cheryNyxus.md
    lock: true # 锁定禁止前端删除/改名（保护配置管理能力）
```

persona [默认提示词](../../../apps/backend/.chery.template/prompt/cheryNyxus/cheryNyxus.md)：配置管理核心角色 + 桌宠组长。核心任务 = 管理所有角色配置相关任务；也作为组长派发业务子任务。

## 文件清单

图片保留策略可通过 `config_manage` 的 `files.imageContext` 修改，与 Web 共用 `SettingsFilesPolicySchema` 及服务可用性校验；字段、默认和自动补描述费用规则见[模型与文件能力](model-capabilities.md)。其他文件仍用 `files.context.recentUserTurns`。保存配置不执行识图，实际采用时间沿用配置提交结果。

| 文件                                                                                                     | 职责                                                                                                               |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [apps/backend/src/agent/sense/configManage.ts](../../../apps/backend/src/agent/sense/configManage.ts)                                 | `config_manage` 感官（get/patch/rollback，拒绝旧 save）                                                            |
| [apps/backend/src/service/config/operations.ts](../../../apps/backend/src/service/config/operations.ts)                               | 强类型资源 schema、操作应用、全字段 baseRevision                                                                   |
| [apps/backend/src/service/config/commit.ts](../../../apps/backend/src/service/config/commit.ts)                                       | AI 与前端共享候选校验、生命周期和空闲重启边界                                                                      |
| [apps/backend/src/agent/sense/index.ts](../../../apps/backend/src/agent/sense/index.ts)                                               | import + `registerBuiltinSenses` + `BUILTIN_SENSE_TOOLS`                                                           |
| [apps/backend/src/utils/config.ts](../../../apps/backend/src/utils/config.ts)                                                         | `saveRawConfig` 写盘前自动备份（保留最近 10 份）+ `redactConfigSecrets`/`restoreRedactedSecrets` 敏感字段脱敏/还原 |
| [apps/backend/test/utils/configSecretRedact.test.ts](../../../apps/backend/test/utils/configSecretRedact.test.ts)                     | 脱敏（`$ENV` 保留 / 明文→`[REDACTED]`）与还原（`[REDACTED]`→盘上原值 / 新明文覆盖）测试                            |
| [默认提示词](../../../apps/backend/.chery.template/prompt/cheryNyxus/cheryNyxus.md) | cheryNyxus persona |
| [默认配置](../../../apps/backend/.chery.template/config.yaml) | sense_groups.cheryNyxus（含 config_manage）+ roles.cheryNyxus |

## 依赖与关联

| 依赖                                                            | 用途                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [utils/config](../../../apps/backend/src/utils/config.ts)                       | `readRawConfig` / `validateConfigCandidate` / `saveRawConfig` / 脱敏还原 |
| [core/sense/senseCreator](../../../apps/backend/src/core/sense/senseCreator.ts) | `sense()` 工厂（name/description/schema/handler/supervisionLevel）       |
| [utils/pathGuard](../../../apps/backend/src/utils/pathGuard.ts)                 | `extractSensePaths` 对非文件感官返回空 → 天然豁免                        |

## 扩展点

### 备份保留份数

`apps/backend/src/utils/config.ts` 的备份清理常量（`BACKUP_KEEP`，默认 10）。改小 → 少占磁盘；改大 → 更多回滚点。

### 新增配置域

新增 AI 可写配置域时必须同时扩展资源级 Zod schema、operation 应用逻辑、业务校验和字段文档。强类型 schema 是模型输入约束，`validateConfigCandidate` 是最终服务端强校验；两者缺一不可。

### 其他配置文件的备份

`config_manage` 的配置动作管理 `config.yaml`；资产动作 `asset_get` / `asset_save` / `asset_archive` 另外管理 `prompt/*.md`、`skills/<name>/**` 和 `rule/*.yaml`。资产保存会把旧版本移到 `.chery/backups/assets/`，归档前检查当前配置引用并采用可恢复移动。`model-catalog.yaml` / `hooks/hooks.json` 当前由配置修订监控器纳入指纹与重启边界，但尚未作为 `config_manage` 资产写入目标。

配置修订、历史上下文纪元、角色/预设删除和维护模式的完整语义见 [配置修订、上下文纪元与删除生命周期](../../shared/architecture/context-epochs.md)。
