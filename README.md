# CheryNyxus

多 LLM Brain 框架，支持 Ollama、OpenAI 等提供商。核心特性：Sense 调用监管、流式响应、两阶段执行。

## 隐喻体系

CheryNyxus 采用拟人化隐喻设计：

| 概念 | 隐喻 | 说明 |
|------|------|------|
| Brain | 大脑 | AI 服务核心，负责思考决策 |
| Sense | 感官 | 感知操作，神经手脚，与世界交互 |
| Chat | 聊天 | 交互通道，承载消息历史 |

**交互流程：** `chat.create`（携带 brain + senseGroup）→ `chat.send` → 触发感官 → 大脑思考（中途可用 `runtime.set` 更换 Brain/Sense）

> Brain 与 Sense Group 在每轮对话开始时可更换，不与 Chat 锁定。Chat 仅承载消息历史。

## 启动指令

> **新接手项目？先看 [开发环境搭建](docs/setup.md)**（前置依赖、密钥配置、🔧 人工必做 vs 🤖 AI 可执行 分级）。

| 指令 | 功能 |
|------|------|
| `pnpm dev` | 开发模式，热重载，监听 `ws://localhost:8182` |
| `pnpm build` | 构建产物到 `dist/` |
| `node dist/index.js` | 运行守护进程；它管理实际后端 worker，并在配置保存后空闲重启 worker。 |
| `pnpm compile:senses` | 编译 `.chery/senses/` 下的外部感官 |
| `pnpm test` | 运行测试 |

> 启动时会先全局注册 Provider 并重建 Sense registry（内置感官 + 编译产物）。`compile-senses` 子命令完成后会在当前进程调用一次 `reloadSenses()`；长运行服务的热重载触发机制后续单独实现。

## 开发规范

| 规范 | 说明 |
|------|------|
| **文档先行** | 编码前先更新涉及的 `docs/` 模块文档，保证文档先于实现。先改代码后补文档视为违规（纯重构、格式化、修复 typo 可豁免） |
| **组件化拆分** | 单个组件超过 400 行时，审查是否可抽象优化——从设计模式出发（高内聚低耦合、职责单一），优先拆分而非继续堆砌 |
| **强制开发规范** | 所有开发与评审（含 AI 协作）必须遵守 [docs/standards/](docs/standards/README.md) 下的强制规范；目录/依赖与 Vue 视图规范分开维护，先落文档后改代码 |
| **验证与手测分工** | 修改者负责运行与风险相称的 lint/type-check/Vitest/build；用户仅负责需要真实桌面环境或主观视觉判断的交互验收 |

## 配置文件

`.env` 与 `.chery/` 由 `pnpm install` 的 `postinstall` 钩子（[scripts/setup-env.mjs](scripts/setup-env.mjs)）自动从仓库内的 `.env.example` / `.chery.template/` 拷贝初始化；目标已存在则跳过，不覆盖用户编辑。手动初始化：`node scripts/setup-env.mjs`。

| 文件 | 说明 |
|------|------|
| `.env` | 环境变量：API Key（`OLLAMA_HOST`、`OPENAI_API_KEY` 等） |
| [.chery/config.yaml](.chery/config.yaml) | LLM 客户端配置、Sense 分组、全局配置、服务端口（`server.port`/`server.web_port`/`server.transport`） |
| [.chery/prompt/system.md](.chery/prompt/system.md) | 系统 prompt 模板（全局 base） |
| [.chery/skills/](.chery/skills/) | 技能定义目录，每个技能包含 `SKILL.md` |
| [.chery/senses/](.chery/senses/) | 外部自定义感官目录，`.ts` 文件自动编译注入 |
| [.chery/db/](.chery/db/) | 数据库存储目录（自动创建） |

## 文档

详细文档见 [docs/](docs/)，分两类：

**横切主题**（跨模块参考）：

| 文档 | 内容 |
|------|------|
| [协议规范](docs/protocol.md) | 传输格式、消息结构、字段定义、方法列表、错误处理 |
| [交互流程示例](docs/interaction.md) | 各方法完整消息序列、端到端流程、错误路径 |
| [主从 Agent 桌宠系统](docs/agent-pet.md) | pet↔chat 绑定、spawn_subagent 前端驱动、CP0-CP7 分阶段实施（已全部落地） |
| [Mock Provider](docs/mock.md) | 脚本化 LLM 离线测试（send/resume/revoke/loop 流程验证） |

**模块文档**（按源码模块组织的实现细节，AI 知识地图）：

见 [docs/README.md](docs/README.md) 总索引 → core / agent / service / db / utils 各模块的职责、文件清单、核心导出、数据流、依赖关联、扩展点。针对某开发目标时，读对应模块文档的「依赖与关联」即可定位所需最小上下文。
