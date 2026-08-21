# `.chery.template/` 配置模板文档索引

> 本目录是 `.chery.template/` 的**字段参考手册**——每个子模块（子目录 / 配置文件）对应一份独立文档，按「字段参考表 + 关联」的格式组织，**机器可读**（供 AI 自动解析/修改配置）。
>
> 同步规则：`.chery/config.yaml` 改动必须先在 `.chery.template/` 同步（运行时目录 gitignored）。

## 文件清单

| 子模块 | 文档 | 模板文件 | 一句话 |
|--------|------|----------|--------|
| 主配置 | [./config.md](./config.md) | [../config.yaml](../config.yaml) | LLM brain / sense_groups / roles / presets / server 全字段 |
| 模型思考档位 | [./model-thinking.md](./model-thinking.md) | [../model-thinking.yaml](../model-thinking.yaml) | 模型 → 支持的 ThinkingLevel 子集映射 |
| 事件钩子 | [./hooks.md](./hooks.md) | [../hooks/](../hooks/) | 事件驱动 handler 配置（hooks.json + .sh） |
| 错误排查 | [./error-troubleshooting.md](./error-troubleshooting.md) | — | AI 给用户报错时的「错误消息 → 设置项」对照表 |
| Mock Provider 脚本 | [./mock.md](./mock.md) | [../mock/](../mock/) | 离线 LLM 响应脚本（content + senseCalls） |
| 自定义感官 | [./senses.md](./senses.md) | [../senses/](../senses/) | 外部 .ts 感官开发规范（schema + handler + 测试） |
| 技能包 | [./skills.md](./skills.md) | [../skills/](../skills/) | 可加载提示词片段（SKILL.md frontmatter） |
| 角色提示词 | [./prompt.md](./prompt.md) | [../prompt/](../prompt/) | system.md + 各角色专属提示词 |
| 用户指令 | [./command.md](./command.md) | [../command/](../command/) | `[[command:/名称]]` 触发的内置指令 |

## AI 自动修改配置

Cherry Nexus（`cheryNyxus`）是**唯一**被授权直接管理 `.chery/` 配置的角色，通过 `config_manage` 感官完成（roles / sense_groups / global / llm 等完整配置域）。本目录的字段参考表即是为 AI 自动改配置设计：

### 入口

```
用户：「把 LLM 改为 claude-sonnet-4-5 / 把监管等级改为 manual / 给 coder 加 write_file 感官」
  ↓
主 agent 识别为配置管理需求 → 由 cheryNyxus 直接处理（或移交其接管）
  ↓
cherryNyxus 角色：
  1. config_manage(action="get") 读取当前配置（返回精简摘要：roles 列表 + 锁定状态）
  2. 对照本目录的字段参考表，定位目标字段
  3. 用 ask_user_question 确认变更（含改动前后对比、影响范围）
  4. config_manage(action="save") 落盘 —— saveRawConfig 层自动备份旧配置到 .chery/backups/
  5. 若校验失败（返回 errors）：不落盘，回报错误原文，用 config_manage(action="rollback") 回滚后重试
  6. 提示用户重启（运行时配置不热更）
```

### 必读文档

按修改目标选读：

| 修改目标 | 必读 | 关联 |
|----------|------|------|
| 改 LLM brain | [./config.md#llmbrain-name-字段](./config.md#llmbrain-name-字段) + [./model-thinking.md](./model-thinking.md) | [../../docs/agent/provider.md](../../docs/agent/provider.md) |
| 改感官监管等级 | [./config.md#sense_groupsgroup-字段](./config.md#sense_groupsgroup-字段) | [../../docs/core/sense.md](../../docs/core/sense.md) |
| 加 / 改角色 | [./config.md#rolesrole-字段](./config.md#rolesrole-字段) + [./prompt.md](./prompt.md) | [../../docs/system-prompt.md](../../docs/system-prompt.md) |
| 改预设 | [./config.md#presetsname-字段](./config.md#presetsname-字段) | — |
| 改服务端口 | [./config.md#server-字段](./config.md#server-字段) | [../../docs/protocol.md](../../docs/protocol.md) |
| 改文件夹浏览白名单 / 文件可见性 | [./config.md#workspace_browse-字段文件夹浏览协议](./config.md#workspace_browse-字段文件夹浏览协议) | [../../docs/protocol.md](../../docs/protocol.md) |
| 加 model 档位映射 | [./model-thinking.md](./model-thinking.md) | — |
| 加 / 改钩子 | [./hooks.md](./hooks.md) | [../../docs/agent/hooks.md](../../docs/agent/hooks.md) |
| 排查错误 / 用户报错 | [./error-troubleshooting.md](./error-troubleshooting.md) | [../../docs/error-conventions.md](../../docs/error-conventions.md) |
| 加 mock 脚本 | [./mock.md](./mock.md) | [../../docs/mock.md](../../docs/mock.md) |
| 加自定义感官 | [./senses.md](./senses.md) | [../../docs/core/sense.md](../../docs/core/sense.md) + [../../docs/core/compiler.md](../../docs/core/compiler.md) |
| 加 / 改技能 | [./skills.md](./skills.md) | [../../docs/agent/prompt.md](../../docs/agent/prompt.md) |
| 加 / 改指令 | [./command.md](./command.md) | [../../docs/system-prompt.md](../../docs/system-prompt.md) |

### 前置条件

启用 AI 自动改配置，需满足：

1. **`cheryNyxus` 角色的 `senseGroup` 含 `config_manage`**（当前模板的 `sense_groups.chery_nexus` 已包含；`config_manage` 是结构化感官，天然不触发 `.chery/` 路径守卫）
2. **自动备份已启用**（`saveRawConfig` 写盘前自动备份 config.yaml 到 `.chery/backups/config-<timestamp>.yaml`，保留最近 10 份）
3. **cheryNyxus 提示词已加载配置管理章节**（当前模板的 [../prompt/cheryNyxus/cheryNyxus.md](../prompt/cheryNyxus/cheryNyxus.md) 已包含）

### 失败处理

- **校验失败**（`validateRawConfig` 返回错误数组）：不落盘，把错误原文回报用户，说明可回滚
- **落盘后发现问题**：用 `config_manage(action="rollback")` 回滚到 `.chery/backups/` 中最近的备份，基于旧配置 + 报错信息调整重试
- **备份自动清理**：`backups/` 目录只保留最近 10 份，超出的自动删除

### 写入流程规范

1. **读摘要**（不要 patch）：`config_manage(action="get")` 拿精简配置摘要（roles 列表 + 锁定状态）
2. **校验当前状态**：对照字段参考表确认字段存在 / 类型正确
3. **构造变更**：`config_manage(action="save")` 传完整配置对象（缺省字段按默认值补齐；server 段保留不动）
4. **落盘**：`saveRawConfig` 层校验 + 自动备份 + 写回（含锁角色 / 固定预设编辑校验）
5. **重启提示**：配置不热更，必须告诉用户重启

## 文档约定

每份文档遵循统一结构：

1. **顶部**：模板路径 / 运行位置 / 加载入口（源码） / 相关文档
2. **用途**：一段话说明
3. **字段参考表**：`字段 | 类型 | 必填 | 默认 | 说明 | 示例` 列
4. **细节 / 注意事项**
5. **示例**（YAML / JSON / TS / Markdown）
6. **关联**：相关文档链接

## 关联

- 项目根：[../README.md](../README.md)
- 配置加载：[../../docs/utils/config.md](../../docs/utils/config.md)
- 提示词系统：[../../docs/system-prompt.md](../../docs/system-prompt.md)
- 同步规则：[.chery/config.yaml](../../.chery/config.yaml) 改动 → [.chery.template/](../)