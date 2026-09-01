# 配置修订、上下文纪元与删除生命周期

本文定义配置被创建、修改或删除后，历史会话如何保持可审计、当前会话如何继续安全运行，以及系统如何处理手工修改和损坏配置。实现入口为 [src/db/epoch.ts](../src/db/epoch.ts)、[src/service/config/revision.ts](../src/service/config/revision.ts)、[src/service/config/roleLifecycle.ts](../src/service/config/roleLifecycle.ts) 和 [src/service/config/watcher.ts](../src/service/config/watcher.ts)。

## 核心结论

- 当前运行时可以直接由最新的、通过校验的配置构建，但不能把新配置反向套用到旧历史。
- 每棵根会话节点树同一时刻至多有一个可执行纪元；旧纪元只读。
- **纪元是配置快照/审计边界，不是消息上下文边界**：纪元记录"该段历史产生于什么配置"，但历史消息跨纪元完整保留、完整进入后续 LLM 上下文。配置变更（语义面或运行时切换）只更换系统提示词与工具契约，**对话内容一个字不动**；旧纪元消息进入 LLM 上下文前剥离模型绑定物（thinking 签名等，见「历史连续性与兼容投影」）。
- 配置修订的 fingerprint 只覆盖**语义面**——影响系统提示词、工具契约或角色编制的字段与资源；**连接面**变更（url/key/超时等）仅热更新运行配置，不产生新修订、不切纪元。语义变化后系统在安全边界激活新修订，并让后续执行进入新纪元（仅快照与提示词切换）。
- 历史消息不会因为角色或预设删除而消失。旧纪元冻结当时的系统提示词、工具契约、运行选择和资源哈希，不保存密钥或可执行源代码。
- 版本化功能启用前的历史进入 `legacy-0`，质量为 `reconstructed`，只供审计，不能假装是精确快照。

## 数据模型

### `config_revisions`

每个语义配置版本一行，主要字段如下：

| 字段 | 含义 |
|---|---|
| `revision_id` | 不可变修订 ID |
| `fingerprint` | 脱敏配置**语义面**与资源哈希清单的 SHA-256，唯一（见下「语义面与连接面」） |
| `status` | `candidate` / `active` / `rejected` / `superseded` |
| `source` | `structured` / `manual` / `startup` / `legacy` / `rollback` |
| `snapshot_json` | 脱敏后的结构化配置；不含明文凭据 |
| `resources_json` | `.chery` 运行资源的路径、大小与 SHA-256；不含源文件内容 |
| `validation_error` | 候选被拒绝时的错误 |

### 配置修订的语义面与连接面

fingerprint 分两面，只有语义面参与指纹计算；连接面变更不产生新修订：

| 面 | 字段（config.yaml）与资源 | 变更后果 |
|---|---|---|
| **语义面**（参与 fingerprint） | `roles.*` / `presets.*` / `sense_groups.*`；`llm.brain.<n>.provider / model / capabilities`；`prompt/ skills/ senses/ plugins/ rule/ command/ hooks/` 目录内容；`model-catalog.yaml` | 激活新修订 → 翻转纪元快照（仅系统提示词/工具契约切换，历史完整保留） |
| **连接面**（不参与 fingerprint） | `llm.brain.<n>.url / key / rpm / fullUrl / contextLimit / thinking / anthropicCompat`；`global.supervision / stream / sense_execute_timeout / approval_* / disconnect_grace_ms / watchdog / history_recall / bash_log_retention_hours / textEditor / file_compression / logger.*`；`memory.* / media` | 热更新运行配置，会话无感 |

归属裁决原则：**影响发往 LLM 的消息内容或工具契约的字段属语义面；只影响请求目标、请求参数或执行策略的字段属连接面**。`global.thinking` 总闸与 `global.stream` 属连接面（请求参数）；`brain.thinking` 档位随连接面。新增配置字段时必须在此表登记归属，未登记的字段默认按语义面处理（保守兜底）。

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

以下变化产生新纪元（**仅切换配置快照、系统提示词与工具契约；历史消息完整保留并继续参与上下文**）：

1. 进程激活了**语义面**不同的配置修订（连接面变更仅热更新运行配置，见上表）；
2. `runtime.set` 实际改变主 Agent 的 brain 或工具运行配置（brain **名称**属语义面——切换人格/编制，但对话历史原样延续）；
3. `session.runtime.set` 实际改变主 Agent 或任一子角色的会话级编制。

重复提交完全相同的会话级编制不会切纪元。这一点很重要，因为前端在每次发送前都会提交当前编制；无变化时必须继续使用同一上下文。

新纪元加载**全部历史消息**（跨纪元，含旧纪元只读消息），并注入轻量 `<epoch_transition>` 说明。历史中的旧工具调用仍是历史事实，但不得假定相关角色或工具在当前纪元存在。

## 历史连续性与兼容投影

**原则**：对话历史是会话的完整事实，任何配置变更都不得丢弃、重置或以摘要替代历史消息。系统提示词、工具契约随当前纪元更换；消息序列原样延续。

**跨纪元加载规则**（`loadHistory`）：

1. 加载该会话**全部**历史消息（不按 `epoch_id` 过滤）；本纪元与旧纪元消息按时间序拼接。
2. **兼容投影**（进入 LLM 上下文前，对旧纪元消息）：剥离 thinking blocks 与模型签名（DB 加载路径本就不带 `thinkingBlocks`，签名绑定模型的回传风险天然消除）；文本 `content`/`thinking`/工具调用记录原样保留。
3. **过渡期产物过滤**：v1 纪元隔离实现落库的 `<epoch_carryover>` 消息在加载时过滤（其内容是旧纪元投影摘要，跨纪元全量加载后与原文冗余）；DB 行保留供审计。
4. `<epoch_transition>` handoff 说明仍注入（system 消息）：声明配置快照已切换、历史完整保留、不得假定历史角色/工具当前仍存在。
5. **空上下文守卫**：若因任何原因（历史数据损坏、`legacy-0` 无快照等）构建的消息列表仍无 user 内容，chat middleware 在 `buildMessages` 后直接抛 `validation` 类错误：「该会话当前纪元没有可延续的用户消息，请重新发送」，**不得**把纯 system 消息列表发往 LLM。该守卫为防御性兜底，正常路径不触发。

> **v1「初始上下文重构」已废除**：早期实现按 `epoch_id` 隔离加载（新纪元 0 条消息），以 `<epoch_carryover>` 文本投影重构上下文——该方案把配置快照边界错误强化为对话断裂，与本原则冲突，已移除。仅过渡期落库的 carryover 消息按第 3 条过滤。

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

这是与归档不同的显式用户操作。运行中的目标会被拒绝删除；根会话删除按后序级联后代，并清理消息、spawn task、root event、节点树控制行、交互、执行图、执行事实、纪元快照和纪元记录。属分支链路（`conversation_branches.task_id`）的根会话被删时，同 task 下所有分支根（continuation/detail）一并级联删除并同样清理。

## 配置监控与维护模式

监控范围包括 `config.yaml`、`model-catalog.yaml`、`prompt/`、`skills/`、`senses/`、`plugins/`、`rule/`、`command/` 和 `hooks/`。

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

- 配置：`get`、强类型增量 `patch`、`rollback`；旧全量 `save` 被拒绝并返回迁移指引；
- 资产：`asset_get`、`asset_save`、`asset_archive`。

资产只允许 `prompt/*.md`、`skills/<name>/**` 和 `rule/*.yaml`。保存使用候选文件替换，并把旧文件移入 `.chery/backups/assets/`；归档前检查活动配置引用，仍被引用时严格拒绝。归档是可恢复移动，不是永久删除。

`patch` 必须携带 get 返回的全配置 `baseRevision`。服务端基于当前磁盘状态构造候选，完整验证后写盘并登记候选修订；所有会话任务空闲后才通知 guardian 替换 worker。重启恢复不会自动重放模型运行，孤儿 run 进入 paused 等待用户继续。

## 验收原则

默认预设的删除与重建通过临时 `CHERY_DIR` fixture 进行：先创建旧预设与历史节点树，再删除旧稳定 ID、验证归档与旧纪元只读，最后创建具有新稳定 ID 的同名默认预设，并验证新根会话只使用新角色、提示词与运行时。真实 `.chery` 默认预设不作为自动测试的破坏性目标。

纪元相关验收另含两条固定用例：

1. **连接面热更新不切纪元**：修改 brain 的 `url`/`key` 后，活跃会话 `epochId` 不变、历史消息仍在本纪元可见，下一次发送使用新连接值。
2. **语义面/运行时切换不丢历史**：修改系统提示词或临时切换大脑翻转纪元后，新纪元加载的消息列表必须**完整包含旧纪元全部历史消息**（仅系统提示词与工具契约更换），LLM 请求携带完整对话序列与 user 内容；旧纪元消息行保持原样可审计；不出现 `<epoch_carryover>` 新增消息（过渡期遗留的 carryover 行被加载过滤）。
