# 配置修订、上下文纪元与删除生命周期

本文定义配置被创建、修改或删除后，历史会话如何保持可审计、当前会话如何继续安全运行，以及系统如何处理手工修改和损坏配置。实现入口为 [src/db/epoch.ts](../src/db/epoch.ts)、[src/service/config/revision.ts](../src/service/config/revision.ts)、[src/service/config/roleLifecycle.ts](../src/service/config/roleLifecycle.ts) 和 [src/service/config/watcher.ts](../src/service/config/watcher.ts)。

## 核心结论

- 当前运行时可以直接由最新的、通过校验的配置构建，但不能把新配置反向套用到旧历史。
- 每棵根会话节点树同一时刻至多有一个可执行纪元；旧纪元只读。
- 配置、提示词、技能、感官、插件、规则、命令或 Hook 发生语义变化后，系统在安全边界激活新修订，并让后续执行进入新纪元。
- 历史消息不会因为角色或预设删除而消失。旧纪元冻结当时的系统提示词、工具契约、运行选择和资源哈希，不保存密钥或可执行源代码。
- 版本化功能启用前的历史进入 `legacy-0`，质量为 `reconstructed`，只供审计，不能假装是精确快照。

## 数据模型

### `config_revisions`

每个语义配置版本一行，主要字段如下：

| 字段 | 含义 |
|---|---|
| `revision_id` | 不可变修订 ID |
| `fingerprint` | 脱敏配置与资源哈希清单的 SHA-256，唯一 |
| `status` | `candidate` / `active` / `rejected` / `superseded` |
| `source` | `structured` / `manual` / `startup` / `legacy` / `rollback` |
| `snapshot_json` | 脱敏后的结构化配置；不含明文凭据 |
| `resources_json` | `.chery` 运行资源的路径、大小与 SHA-256；不含源文件内容 |
| `validation_error` | 候选被拒绝时的错误 |

### `chat_epochs`

每个根会话拥有一组有序纪元：

| 字段 | 含义 |
|---|---|
| `epoch_id` / `root_chat_id` / `ordinal` | 纪元身份、所属根和序号 |
| `revision_id` | 该纪元使用的配置修订 |
| `status` | `active` / `historical` / `archived` |
| `snapshot_quality` | `exact` / `partial` / `reconstructed` |
| `transition_reason` | 创建、配置变化、运行时变化或遗留迁移原因 |
| `handoff_summary` | 注入新纪元的边界摘要 |

部分唯一索引保证同一根会话最多一个 `active` 纪元。`chats.active_epoch_id`、`messages.epoch_id`、`pending_inputs.epoch_id`、`spawn_tasks.epoch_id` 和 `execution_active_runs.epoch_id` 明确记录所有权，避免旧任务在新纪元恢复。

### `chat_epoch_snapshots`

每个纪元、每个 chat 一份首次构建后不可漂移的快照：

- `prompt_snapshot_json`：完整系统提示词与工具的名称、说明、参数 schema；
- `runtime_snapshot_json`：brain、sense group 和 MCP 选择；
- `resource_manifest_json`：资源哈希清单；
- `role_id` / `role_name`：当时的角色身份；
- `lifecycle` / `invalidation_reason`：`active`、`retired`、`abandoned` 或 `archived` 及原因。

缺失的历史快照绝不由当前配置重建。UI 显示 `partial` 或 `reconstructed` 警告和空工具列表，避免产生伪历史。

## 纪元边界

以下变化产生新纪元：

1. 进程激活了不同的配置修订；
2. `runtime.set` 实际改变主 Agent 的 brain 或工具运行配置；
3. `session.runtime.set` 实际改变主 Agent 或任一子角色的会话级编制。

重复提交完全相同的会话级编制不会切纪元。这一点很重要，因为前端在每次发送前都会提交当前编制；无变化时必须继续使用同一上下文。

新纪元仅加载本纪元消息，并注入持久化的 `<epoch_transition>` 摘要。旧工具调用仍是历史事实，但不证明相关角色或工具在当前纪元存在。

## 删除和语义修改

### 子角色删除或语义修改

- 未完成分支：从命中的子 chat 开始，整棵子树变为 `abandoned`；待处理输入、提问、交互、运行、唤醒链和 spawn task 全部关闭。
- 已完成分支：整棵已完成子树变为 `retired`，历史可读但不可恢复。
- 同名重建角色不复用旧子树；主 Agent 必须发起新的 `spawn_role`，创建新子会话。

### 主 Agent 修改

主 Agent 正在运行时拒绝修改。空闲时修改会切换整棵根会话的纪元；旧委派不继承到新的主 Agent 语义中。后续工作由新主 Agent 重新派发。

### 预设删除

使用该稳定 `presetId` 创建的根会话及后代转为 `archived`。所有纪元归档、所有活动关闭、历史保留。归档会话没有可执行纪元，UI 只能查看。

### 物理删除会话

这是与归档不同的显式用户操作。运行中的目标会被拒绝删除；根会话删除按后序级联后代，并清理消息、spawn task、root event、节点树控制行、交互、执行图、执行事实、纪元快照和纪元记录。

## 配置监控与维护模式

监控范围包括 `config.yaml`、`model-thinking.yaml`、`prompt/`、`skills/`、`senses/`、`plugins/`、`rule/`、`command/` 和 `hooks/`。

1. 文件事件经过静默窗口合并；结构化保存的指纹会被一次性确认，避免同一次写盘再被当作手工候选重复执行生命周期操作。
2. 有效手工修改生成 `manual` 候选，在所有 Agent 空闲后重启激活。
3. 无效的结构化保存不落盘，生成 `rejected` 修订。
4. 运行中出现不可解析的手工配置时，系统立即中止 Agent、保全坏文件到 `.chery/backups/rejected-manual-*.yaml`、恢复最后一次可解析文本，并保持 fail-closed 维护模式，直到用户确认保存有效配置。
5. 冷启动时配置无法加载，Guardian 保全坏文件为 `rejected-startup-*.yaml`，从最近 `config-*.yaml` 恢复后启动维护 worker。修复保存成功后清除维护状态并在安全边界重启。

维护模式下普通 Agent 的 `ensureChat` 会抛出 `MAINTENANCE_MODE`。设置与配置修复通道仍可用。

## RPC

### `chat.epoch.list`

请求：`{ chatId }`。

响应包含 `rootChatId`、可选 `activeEpochId` 和按序排列的 `epochs[]`。每项包含 `epochId`、`ordinal`、`label`、`status`、`snapshotQuality`、`transitionReason`、可选 `handoffSummary`、`executable`、时间字段。归档或退役会话不返回 `activeEpochId`，所有项 `executable=false`。

### `chat.promptSnapshot`

请求：`{ chatId, epochId? }`。省略 `epochId` 时，活动会话选择当前纪元；非活动会话选择最近可用的冻结历史快照。

响应在原有 `systemPrompt`、`tools` 外增加 `epochId`、`epochOrdinal`、`epochStatus` 和 `snapshotQuality`。历史纪元只读；缺失精确快照时返回明确警告，不使用当前配置代填。

### `chat.list`

每项增加 `activeEpochId?`、`epochCount` 和 `lifecycle`，供目录与工作台区分活动、退役、废弃和归档记录。

## Nexus 配置和资产操作

`config_manage` 支持：

- 配置：`get`、`save`、`rollback`；
- 资产：`asset_get`、`asset_save`、`asset_archive`。

资产只允许 `prompt/*.md`、`skills/<name>/**` 和 `rule/*.yaml`。保存使用候选文件替换，并把旧文件移入 `.chery/backups/assets/`；归档前检查活动配置引用，仍被引用时严格拒绝。归档是可恢复移动，不是永久删除。

当前实现和验收只落在工作区 `.chery` 与隔离测试 fixture；在验收通过前不复制到 `.chery.template`。

## 验收原则

默认预设的删除与重建通过临时 `CHERY_DIR` fixture 进行：先创建旧预设与历史节点树，再删除旧稳定 ID、验证归档与旧纪元只读，最后创建具有新稳定 ID 的同名默认预设，并验证新根会话只使用新角色、提示词与运行时。真实 `.chery` 默认预设不作为自动测试的破坏性目标。
