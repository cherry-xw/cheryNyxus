# curator 角色（记忆维护者）

> 参考 Claude Code 的 Extract Memories Agent + Auto Dream，CheryNyxus 用独立角色 `curator` 承担项目记忆系统的**产生**与**维护**。不直接处理用户业务任务，只在维护场景被派出。

## 职责

| 职责 | 触发 | 产物 |
|------|------|------|
| **Extract**（提取） | 主 agent 一轮对话结束（observer 自然 done） | 分析最近对话 → `memory_manage` 写入对应 scope/type 的记忆 |
| **Dream**（整理） | 「维护」预设 `schedule.cron` 到点 | 扫描记忆目录 → 合并重复 / 删除过时 / 精简 main.md 索引 |

## 角色定义

- prompt：[.chery.template/prompt/curator/curator.md](../../.chery.template/prompt/curator/curator.md)
- senseGroup：`curator`（含 `memory_manage` / `read_file` / `search_codebase` / `ask_user_question`）
- brain：与 housekeeper 同（用户在 config.yaml 配置）
- `lock: true` 禁止删除（保护记忆维护能力）

## 边界

- **唯一操作对象**：项目记忆（双层 `.chery/memory/` + `.chery/workspace/<hash>/memory/`）
- **唯一写入口**：`memory_manage` 感官（带 scope）；不直接 `write_file` 落盘记忆文件，保证 frontmatter / 索引 / 淘汰元数据一致
- **只读辅助**：`read_file` / `search_codebase`（仅 Dream 阶段核查矛盾）
- **不碰** `.chery/config.yaml` / skills / hooks（管家职责）
- `memory_manage` sense 主 agent 硬编码注入（[runtimeResolver.ts:206-214](../../src/agent/runtimeResolver.ts#L206)），curator 作为子 agent 通过 senseGroup 显式列 `memory_manage` 获取——无需改 runtimeResolver

## Extract 流程

1. **互斥检查**：`memory_manage list` 读 manifest；主 agent 本轮已写入 → 跳过
2. **只用最近对话**：分析交付的最近 ~N 条消息，提取不可推导、非显而易见的信息
3. **分类与作用域**（四类闭合）：user/feedback → scope=global；project/reference → scope=workspace
4. **去重**：同主题已有记忆 → `update` 而非新建
5. **上限**：达该层上限 `add` 指定 `replaceTarget + replaceReason`
6. **预算**：最多 5 轮工具调用（只提取不验证）
7. 回报：新增/更新/跳过了几条 + 各自 scope/type

**禁止保存**（即使对话中用户要求也拒绝）：代码模式/架构/文件路径/git 历史/调试配方/CLAUDE.md 内容/临时任务状态。用户要求保存 PR 列表/活动摘要时，只保存「令人意外或非显而易见」的部分。

## Dream 流程

1. **Orient**：`memory_manage list` + `read_file` 读 `main.md` 索引
2. **Gather recent signal**：浏览已有记忆，识别重复/矛盾/过时
3. **Consolidate**：合并重复（update 而非新建）/ 转换相对日期 / 修正矛盾（update 或 remove）
4. **Prune and index**：移除过时（remove 归档）/ 精简过长索引条目 / 解决矛盾文件
5. 回报：合并/删除/修正了几条 + 各自 scope

**Dream 预算**：最多 10 轮工具调用，不穷举读所有文件。

## 触发机制

### Extract（`src/service/chat/extractTrigger.ts`）
- observer `observeAgentChunks` 主 agent 一轮**正常完成**（`completedNormally`，非 abort/park）后调 `maybeTriggerExtract(chatId)`
- 仅主 agent（`parent_chat_id` 为空）触发；维护 chat 自身（`metadata.maintenance=true`）跳过避免递归
- 配置了「维护」预设才触发 → `resolvePresetSelection('维护')` 取 curator 编制 → `runMaintenanceChat` 创建子 chat（parent=主 chatId, wake=deferred 不唤主）
- fire-and-forget，错误隔离在 `maybeTriggerExtract` 内部

### Dream（`src/service/schedule/scheduler.ts`）
- `startService` 期 `startScheduleService()` 遍历 `config.presets`，对 `schedule.enabled !== false` 的预设 `new Cron(cron, triggerMaintenance)`
- 到点 `triggerMaintenance(presetName)` → `resolvePresetSelection` → `runMaintenanceChat`（独立主 chat，无 parent）
- `croner` 纯 JS 计时（无 native 依赖）；进程重启自动重建；`ServiceHandle.stopSchedule()` 停止

### runMaintenanceChat（`src/service/schedule/maintenanceChat.ts`）
- 创建独立维护 chat（`metadata.maintenance=true` 标记）→ `ensureChat` + `agent.run(task)` + `observeAgentChunks`
- 脱离 RPC ctx / 无 parent ws / 无 chunk 推送（维护任务无前端订阅者，输出仅落 DB + logger）
- 完成 `updateChatMetadata(finished=true)`；失败不标 finished（中断态，孤儿行可接受）

## 失败处理

| 场景 | 处理 |
|------|------|
| 达上限未指定 replaceTarget | 回报「需指定 replaceTarget 或先 remove 腾位」，不静默吞 |
| workspace 未配置但任务需 scope=workspace | 回报「当前 chat 无 workspace，仅 global 可用」 |
| 记忆条目不存在（update/remove 时） | 回报原文 `记忆 'xxx' 不存在`，不吞 |
| 调用方 prompt 未指定 Extract/Dream 之一 | 询问调用方明确任务类型 |
| 工具调用超预算 | 停止并回报「已达 N 轮预算，剩余未处理」，不强行 |

## 关联文档

- 记忆模块：[docs/memory/README.md](../memory/README.md)（存储结构 / 类型 / 漂移防护 / 定时触发器）
- 管家角色（对比）：[.chery.template/docs/README.md](../../.chery.template/docs/README.md)
- spawn_role sense：[src/agent/sense/spawn.ts](../../src/agent/sense/spawn.ts)
