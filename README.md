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

> **新接手项目？先看 [开发环境搭建](docs/guides/setup.md)**（前置依赖、密钥配置、🔧 人工必做 vs 🤖 AI 可执行 分级）。

| 指令 | 功能 |
|------|------|
| `pnpm dev` | 先启动 Manager，再启动 Backend 开发构建与热重载；默认管理端口 39980、后端 WS 8182 |
| `pnpm build` | 后端构建产物到 `apps/backend/dist/` |
| `pnpm manager:cli` | 启动已构建的 Manager，并由它启动 Backend；Backend guardian 管理实际 worker |
| `pnpm compile:senses` | 编译 `.chery/senses/` 下的外部感官 |
| `pnpm test` | 运行测试 |

> 启动时会先全局注册 Provider 并重建 Sense registry（内置感官 + 编译产物）。`compile-senses` 子命令完成后会在当前进程调用一次 `reloadSenses()`；长运行服务的热重载触发机制后续单独实现。

## 开发规范

| 规范 | 说明 |
|------|------|
| **文档影响先判定** | 编码前判断是否改变契约、边界、稳定入口、关键流程、扩展方式或验证入口；有影响时先更新权威文档，无影响时不制造文档改动 |
| **组件化拆分** | 单个组件超过 400 行时，审查是否可抽象优化——从设计模式出发（高内聚低耦合、职责单一），优先拆分而非继续堆砌 |
| **强制开发规范** | 所有开发与评审（含 AI 协作）必须遵守根目录 `AGENTS.md` 和 [docs/standards/](docs/standards/README.md) 下的强制规范；全局硬约束由 `AGENTS.md` 直接提供，详细规则按作用域维护 |
| **验证与手测分工** | 修改者负责运行与风险相称的 lint/type-check/Vitest/build；用户仅负责需要真实桌面环境或主观视觉判断的交互验收 |

## 配置文件

后端的环境、模板与开发运行数据都位于 `apps/backend/`。`pnpm install` 的 [初始化脚本](scripts/setup-env.mjs) 从该目录的 `.env.example` 和 `.chery.template/` 初始化 `.env`、`.chery/`，保留已有配置、用户修改及删除。手动初始化：`node scripts/setup-env.mjs`。Manager 使用同一运行根；部署可通过 `CHERY_DIR` 指定其他数据位置，启动方式见[后端运行](docs/guides/backend-runtime.md)。

| 文件 | 说明 |
|------|------|
| `apps/backend/.env` | Backend 与 Manager 使用的本地环境变量，不入库 |
| `apps/backend/.chery/config.yaml` | 模型、角色、工具、服务端口与 Manager 设置 |
| `apps/backend/.chery/prompt/` | 运行时提示词 |
| `apps/backend/.chery/skills/` | 技能目录 |
| `apps/backend/.chery/senses/` | 自定义感官目录 |
| `apps/backend/.chery/db/` | 默认数据库目录 |

## 文档

详细文档见 [docs/](docs/)，分两类：

**横切主题**（跨模块参考）：

| 文档 | 内容 |
|------|------|
| [协议规范](docs/shared/protocol/README.md) | 传输格式、消息结构、字段定义、方法列表、错误处理 |
| [交互流程示例](docs/shared/protocol/interactions.md) | 各方法完整消息序列、端到端流程、错误路径 |
| [主从 Agent 桌宠系统](docs/frontend/pet/README.md) | pet↔chat 绑定、spawn_subagent 前端驱动、CP0-CP7 分阶段实施（已全部落地） |
| [Mock Provider](docs/quality/testing/mock-provider.md) | 脚本化 LLM 离线测试（send/resume/revoke/loop 流程验证） |

**模块文档**（按源码模块组织的实现细节，AI 知识地图）：

见 [docs/README.md](docs/README.md) 总索引 → core / agent / service / db / utils 各模块的职责、文件清单、核心导出、数据流、依赖关联、扩展点。针对某开发目标时，读对应模块文档的「依赖与关联」即可定位所需最小上下文。
