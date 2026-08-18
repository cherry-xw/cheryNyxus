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

管家角色（`housekeeper`）是**唯一**被授权管理 `.chery/` 配置的角色。本目录的字段参考表即是为 AI 自动改配置设计：

### 入口

```
用户：「把 LLM 改为 claude-sonnet-4-5 / 把监管等级改为 manual / 给 housekeeper 加 write_file 感官」
  ↓
主 agent → spawn_role(type: "housekeeper") → 转述修改需求
  ↓
housekeeper 角色：
  1. read_file 读取当前配置（路径守卫已豁免）
  2. 对照本目录的字段参考表，定位目标字段
  3. 用 spawn_role 派出 leader 角色分析变更影响（跨字段校验）
  4. 用 ask_user_question 确认变更
  5. write_file 落盘（路径守卫已豁免）
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

1. **`housekeeper` 角色的 `senseGroup` 含 `write_file`**（当前模板只含 `read_file` / `search_codebase` / `ask_user_question` / `install_skill`；如未加，先改 [`config.yaml`](../config.yaml) 的 `sense_groups.housekeeper`）
2. **`write_file` 路径守卫豁免 `.chery/`**（`GUARD_EXEMPT` 加 `config.yaml` / `model-thinking.yaml` / `hooks/hooks.json` 等白名单路径）
3. **housekeeper 提示词已加载配置管理章节**（当前模板的 [../prompt/housekeeper/housekeeper.md](../prompt/housekeeper/housekeeper.md) 已包含）

### 失败处理

- **校验失败**（`validateRawConfig` 返回错误数组）：把错误原文回报主 agent，由主 agent 转述用户，**不**落盘
- **跨字段影响未知**：先 spawn leader 分析，再决定；不要直接写
- **路径守卫拦截**：未配置豁免 → 报错而非绕过；提示用户调整 `GUARD_EXEMPT`

### 写入流程规范

1. **读全文**（不要 patch）：`read_file(.chery/config.yaml)` 拿原文
2. **校验当前状态**：对照字段参考表确认字段存在 / 类型正确
3. **构造新内容**：保留未改字段原样、注释、字段顺序（`saveRawConfig` 会丢注释，但模板注释可帮助理解）
4. **预校验**：本地 `js-yaml.load` 解析新内容，捕获语法错误
5. **落盘**：`write_file(.chery/config.yaml, newContent)`
6. **重启提示**：配置不热更，必须告诉用户重启

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