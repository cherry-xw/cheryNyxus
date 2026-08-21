# AI 配置管理（config_manage 感官 + 自动备份回滚）

> 源码 [src/agent/sense/configManage.ts](../../src/agent/sense/configManage.ts) ｜ [src/utils/config.ts](../../src/utils/config.ts)（`saveRawConfig` 备份）｜ 上级 [agent](./README.md) ｜ 相关 [./skill-install.md](./skill-install.md)（install_skill 感官）、[../core/sense.md](../core/sense.md)（感官注册）、[./middleware.md](./middleware.md)（守卫在 tool middleware）

## 职责

Cherry Nexus（`cheryNyxus`）是**唯一**被授权直接管理 `.chery/` 配置的角色。通过 `config_manage` 感官完成对 `config.yaml` 的读改写（roles / sense_groups / global / llm 等完整配置域），`saveRawConfig` 写盘层统一做历史备份，出错可回滚。

用户诉求（核心定位）：「Cherry Nexus 是一个核心角色，主要任务是管理所有角色配置相关的任务」「在修改完配置并生效之前，需要对历史配置做一份备份。如果修改出错，可以及时回滚到旧的配置项」。

## config_manage 感官（[configManage.ts](../../src/agent/sense/configManage.ts)，smart 监管）

### 与 install_skill 的关系

- `config_manage` 是**结构化感官**：action 参数不携带路径，`extractSensePaths` 对非文件类感官返回 `[]` → **天然不触发 `.chery/` 路径守卫**（[pathGuard.ts](../../src/utils/pathGuard.ts) 只对 write_file/read_file/search_codebase/execute_command 提取路径）。
- 因此无需修改 `GUARD_EXEMPT` 白名单，`config_manage` 即可读写 `.chery/config.yaml`。
- 仅 Cherry Nexus 的 senseGroup（`chery_nexus`）含 `config_manage` → 其他角色 senseTable 无此感官 → 调不到（角色隔离）。

### schema（action 三态）

```ts
z.discriminatedUnion('action', [
  z.object({
    action: z.literal('get'),
  }),
  z.object({
    action: z.literal('save'),
    config: z.record(z.unknown()).describe('完整配置对象（roles/sense_groups/global/llm 等）'),
  }),
  z.object({
    action: z.literal('rollback'),
    // 可选：指定备份文件名（.chery/backups/ 下）；缺省用最近一份
    backup: z.string().optional().describe('回滚目标备份文件名（缺省最近一份）'),
  }),
])
```

### action 行为

| action | 行为 | 返回 |
|--------|------|------|
| `get` | `readRawConfig()` 读盘（剥离 server 段），返回精简摘要 | roles 列表 + 锁定状态 + 各字段是否存在 |
| `save` | 复用 `saveRawConfig()`（校验 + 锁角色/固定预设编辑校验 + 写回） | `ok` / `errors`+`warnings`（失败不落盘） |
| `rollback` | 从 `.chery/backups/` 恢复指定/最近备份到 `config.yaml` | 恢复的文件名 + 时间 |

### 使用流程（提示词约束）

1. **get**：先读配置摘要（roles 列表 + 锁定状态），对照 `.chery.template/docs/` 字段参考表定位目标字段
2. **确认**：用 `ask_user_question` 把变更呈现给用户确认（含改动前后对比、影响范围）
3. **save**：传完整配置对象落盘（`saveRawConfig` 层自动备份旧配置）
4. **失败处理**：校验失败 → 不落盘，回报错误原文；已落盘但发现问题 → `rollback` 回滚后基于旧配置 + 报错信息重试
5. **重启提示**：配置不热更（运行时内存单例），必须告诉用户重启

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
| [src/utils/config.ts](../../src/utils/config.ts) | `saveRawConfig` 写盘前自动备份（保留最近 10 份） |
| [.chery.template/prompt/cheryNyxus/cheryNyxus.md](../../.chery.template/prompt/cheryNyxus/cheryNyxus.md) | Cherry Nexus persona |
| [.chery.template/config.yaml](../../.chery.template/config.yaml) | sense_groups.chery_nexus（含 config_manage）+ roles.cheryNyxus |

## 依赖与关联

| 依赖 | 用途 |
|------|------|
| [utils/config](../../src/utils/config.ts) | `readRawConfig` / `saveRawConfig` / `ConfigRaw` |
| [core/sense/senseCreator](../../src/core/sense/senseCreator.ts) | `sense()` 工厂（name/description/schema/handler/supervisionLevel） |
| [utils/pathGuard](../../src/utils/pathGuard.ts) | `extractSensePaths` 对非文件感官返回空 → 天然豁免 |

## 扩展点

### 备份保留份数

`src/utils/config.ts` 的备份清理常量（`BACKUP_KEEP`，默认 10）。改小 → 少占磁盘；改大 → 更多回滚点。

### 新增配置域

`config_manage` 的 save 复用 `saveRawConfig`，覆盖 `config.yaml` 全部字段（roles/sense_groups/global/llm/presets）。未来新增配置域只需扩展字段参考表（`.chery.template/docs/config.md`），感官无需改。

### 其他配置文件的备份

`config_manage` 目前只管 `config.yaml`。`model-thinking.yaml` / `hooks/hooks.json` 的备份如需统一，可在备份函数中扩展文件清单。
