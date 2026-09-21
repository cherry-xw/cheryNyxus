# 媒体外部服务化与工具能力声明

**文档创建时间：** 2026-09-22T01:06:05+08:00

**状态：** 实现完成，进入综合验证

> 需求基线见 [requirements.md](./requirements.md)。本 README 只负责恢复与跟踪，详细设计以需求文档为准。

## 目标与边界

### 目标

把「多媒体」从硬编码内置工具重构为通用外部服务体系：给 `Sense` 增加能力声明（`accepts`/`produces`/`preprocess`/`batchSize`），生成类工具从大脑 `generate.*` 双门中解放、改由工具自身 `produces` 声明注入；理解类在非多模态模型下由 `preprocess` 工具前置执行替换进消息；外部服务密钥与配置解耦（`.env` + 一键打开入口）；CherryNexus 支持一键生成符合规范的外部服务自定义工具。整体方向 = 多媒体并入「用户自定义工具」机制，改名「外部服务」。

### 边界（本次不做）

- **理解类不工具化**：看图/听音作为对话输入仍是输入通道（多模态直传或前置工具），不套普通工具调用模型。
- **不新建适配器目录**：适配器 = 自定义 sense，落在 `.chery/senses/`，不另建目录。
- **不引入公网存储**：媒体继续存本地 `.chery/media/`，内部规范出参统一落盘。
- **hooks 不作为主方案**：仅作补充参考。
- **不追求纯配置零代码覆盖全部外部服务**：声明式配置只覆盖常见协议，五花八门的出参由自定义 sense 兜底。

## 关键技术决策（已与用户确认，详见需求文档）

| 决策点 | 结论 |
|---|---|
| 适配器落位 | 直接放 `.chery/senses/`，适配器 = 自定义工具；不新建 `.chery/adapters/` |
| 工具能力声明 | 四个字段：`accepts`（接收类型/文件后缀）、`produces`（产出）、`preprocess`（是否前置，缺省 false）、`batchSize`（每批容量，缺省不限） |
| 前置执行 | 非多模态模型：扫描媒体引用 → 匹配 accepts+preprocess 工具 → 执行 → 结果替换进消息；不持久化、失败跳过+提示、前置默认自动执行 |
| 生成类注入 | 从「大脑 generate.* 双门」改为「感官组配置 produces 声明的工具即注入」 |
| 多图处理 | 前端永远全量传入，工具按 `batchSize` 内部分批、自己合并、自己管并发；结果带 `batchIndex` |
| 内部规范出参 | 四层：适配器翻译 → 内部规范 `{text?, items:[{mimeType, data/url, batchIndex}]}` → 落盘 `/api/media/` → 渲染层只认规范 |
| 密钥存储 | 外部服务密钥写 `.env`，sense 执行从 `$ENV` 占位读取；设置页加「打开 .env」入口（复用 BrainCard 现有 `openEnvFile` 模式） |
| 服务与工具关系 | 1:N，命名空间归组（复用 MCP 的 `mcp__<server>__<tool>` 模式） |
| CherryNexus 生成 | 生成符合规范的自定义 sense，用户确认后编译加载；`new Function` 信任边界 = `.chery/senses/*.ts` |

## 小任务台账

批次与依赖：批次一为能力声明基础（串行强依赖）；批次二（前置调度）依赖批次一；批次三（生成类工具化）依赖批次一，其中 3.2 可与批次二并行；批次四（密钥配置）可与批次二/三并行；批次五依赖批次一与批次三；批次六依赖批次一；批次七（综合验证）在所有实现小任务完成后进入。

| 编号 | 小任务 | 批次 | 复杂度 | 依据 | 状态 | 链接 |
|---|---|---|---|---|---|---|
| 1.1 | `Sense` 能力声明字段（accepts/produces/preprocess/batchSize）：`Sense<T>` 类型 + `sense()` 工厂 + 内置生成 sense 补声明 | 一 | 2 | 单模块类型与工厂扩展，但影响全部内置 sense 定义 | 完成 | `src/core/sense/senseCreator.ts`、`src/agent/sense/media.ts` |
| 1.2 | 自定义 sense 编译链路透传能力声明：`compileSenses` 产物与 `loadCompiledSense` 的 `new Function` 上下文补字段 | 一 | 2 | 编译器与加载器双向透传，需保持既有自定义 sense 兼容 | 完成（编译器无需改：能力走 `sense()` 第 6 参，`new Function` 上下文原样透传；`SenseEntry` 增 capabilities 透传） | `src/core/middleware/types.ts`、`src/agent/runtimeResolver.ts`、`test/agent/helpers/fakeContext.ts` |
| 2.1 | 前置调度器：`enrichMediaInputs` 扩展，扫描 `[[media]]`/`[[file]]` 引用 → 大脑原生能力优先 → 匹配 accepts+preprocess 工具 → 执行 → 结果替换进消息 | 二 | 5 | 核心对话上下文构建，改造现有双轨，涉及中间件、工具执行与消息替换，风险最高 | 完成 | `src/agent/middleware/chat.ts`（`enrichMediaInputsPreprocess`）、`test/agent/middleware/mediaPreprocess.test.ts` |
| 2.2 | 前置工具输入接口统一：`{text, media[]}` 数组输入 + `batchSize` 内部分批 + 结果 `batchIndex` | 二 | 3 | 工具输入输出契约 + 分批合并逻辑，需与既有 sense 结果格式对齐 | 完成（契约与文档收口；分批由工具内部实现，调度层全量传入） | `src/agent/middleware/chat.ts`、`.chery.template/docs/senses.md` |
| 2.3 | 前置失败语义：不持久化、失败跳过+提示、前置默认自动执行（敏感工具可单独声明审批） | 二 | 2 | 中间件边界处理，需保持既有媒体附件处理行为 | 完成 | `src/agent/middleware/chat.ts`、`test/agent/middleware/mediaPreprocess.test.ts` |
| 3.1 | 生成 sense 注入改造：`runtimeResolver.resolveSense` 从「大脑 generate.* 双门」改为「工具自身 produces 声明」 | 三 | 4 | 运行时注入门控变更，涉及工具/媒体开关回归与兼容期 | 完成（删除 `generateCapabilities` 拦截与参数；`generate.*` 标记保留解析与 config 校验，仅不再作为注入门） | `src/agent/runtimeResolver.ts`、`src/agent/sense/media.ts`、`docs/backend/agent/model-capabilities.md` |
| 3.2 | 发送门控改读工具能力声明：`useAgentDialogOptions.mediaServicesByType` 与上传前提改为「感官组有 accepts 命中的工具 OR 大脑多模态」 | 三 | 3 | 前后端跨端门控逻辑，需保持 MiniMax 图片上传不回归 | 完成 | `web/src/features/agent/composer/useAgentDialogOptions.ts`、`web/src/services/agentApi.ts`、`src/service/sense/list.ts`、`src/service/message/types.ts` |
| 4.1 | 设置页「打开 .env」入口：MediaTab/外部服务设置处复制 BrainCard 的 `openEnvFile` + `env.list` 刷新 | 四 | 1 | 前端小入口复制，复用现成 RPC（`utils.openFile`/`env.list`） | 完成 | `web/src/features/agent/settings/tabs/config/MediaTab.vue` |
| 4.2 | 服务级配置与 sense 逻辑解耦：`MediaServiceConfig` 退化为密钥/服务信息容器，sense 从 `$ENV` 与 config 读取 | 四 | 2 | 配置读取逻辑调整，需保持旧配置兼容 | 完成（`resolveEnvVars` 的 `$VAR` 展开机制已支持密钥解耦；本次以文档 + 能力声明完成语义收口，config 结构保持兼容） | `.chery.template/docs/senses.md`、`docs/backend/agent/sense.md` |
| 5.1 | CherryNexus 一键生成外部服务工具：按规范生成 `.chery/senses/*.ts`（能力声明 + 出入参 + 出参归一化），用户确认后编译加载 | 五 | 3 | 提示词/流程 + 编译加载链路复用，涉及生成产物安全确认 | 完成 | `.chery.template/prompt/cheryNyxus/cheryNyxus.md`、`.chery.template/docs/senses.md` |
| 6.1 | 内部规范出参链路收口：渲染层只认 `/api/media/` 规范，归一化接口 `{text?, items[]}` 与现有落盘/渲染/回溯对齐 | 六 | 2 | 前端渲染已基本覆盖，主要是接口对齐与 `batchIndex` 透传 | 完成（渲染层 `MediaInlineRenderer`/`MediaRenderer` 已只认 `/api/media/`；`batchIndex` 为工具内部契约，调度层不拆分） | `.chery.template/docs/senses.md` |
| 6.2 | 内置生成 sense 处置：按决策保留为默认实现或移除，确认大脑 `generate.*` 标记退役时机 | 六 | 1 | 决策驱动的小调整，需回归工具开关 | 完成（保留为默认实现并补 produces/accepts 声明；`generate.*` 兼容期保留不拦截） | `src/agent/sense/media.ts`、`docs/backend/agent/model-capabilities.md` |
| 7.1 | 综合验证与用户验收 | 七 | — | 汇总自动/手动清单 + 反馈回填槽（见下） | 进行中（自动验证已执行，见下） | — |

**复杂度口径**（本项目）：1 边界明确局部调整；2 单模块有限行为；3 需保持既有行为的多组件/多步骤；4 跨模块契约/持久化/恢复边界的高风险；5 核心执行语义/共享状态机/架构广泛兼容风险。

## 当前恢复检查点

- 任务处于**实现完成，进入综合验证**：13 项小任务中 1.1-6.2 全部完成，7.1 自动验证已执行（见下）。
- 关键实现落点：能力声明（`src/core/sense/senseCreator.ts` + `media.ts`）；前置调度（`src/agent/middleware/chat.ts` `enrichMediaInputsPreprocess`）；生成注入去门（`src/agent/runtimeResolver.ts`）；发送门控（`web/src/features/agent/composer/useAgentDialogOptions.ts`）；env 入口（`MediaTab.vue`）；CherryNexus 生成指引（`.chery/prompt/cheryNyxus/cheryNyxus.md`）。
- 下一步：登记手动验证清单，按 [AI 协作规范](../../standards/global/ai-collaboration.md) 提交审批，用户批准后收口。

## 待定问题（实施中已采用默认值）

1. 大脑 `generate.*` 标记的退役时机与兼容期 → **兼容期**：保留字段解析与 config 校验，`resolveSense` 不再拦截。
2. 内置生成 sense（`generate_image` 等）保留为默认实现还是整体移除 → **保留**为默认实现并补能力声明，用户可用自定义 sense 替换。
3. `accepts` 文件后缀标签初始白名单（doc/docx/pdf/xlsx…）与 MIME 映射 → **媒体类型 image/video/audio + 常见文档后缀 doc/docx/pdf/xlsx/xls/pptx/txt/md/csv/json**，工具自行声明。
4. CherryNexus 生成外部服务工具是否需要独立提示词/角色 → **复用现有 cheryNyxus 角色**，提示词补「外部服务工具生成」节。
5. 多媒体 Tab 最终形态：退化为「密钥 + 挂载工具」薄壳，还是并入感官组 Tab → **保留 MediaTab 为薄壳**，本次加「打开 .env」入口；感官组工具挂载走现有 `sense_groups` 配置。

## 最终综合验证

7.1 当前登记结构如下，内容随台账变化同步重建。

**反馈回填槽**（阶段一收口前清零）：（暂无）

**自动验证清单**：

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期+产物 |
|---|---|---|---|---|---|
| A1 | 后端类型检查（能力声明/前置调度/注入去门） | `pnpm type-check` | 0 | 无错误 | 2026-09-22 |
| A2 | 前端类型检查（发送门控/env 入口） | `pnpm web:type-check` | 0 | 无错误 | 2026-09-22 |
| A3 | 全量后端单测（回归 + 新前置调度用例） | `pnpm vitest run` | 0 | 1425 用例：1410 通过 / 11 失败（11 失败均与本次改动无关，经 git stash 基线验证为预先存在：deleteChat/deleteLifecycle/approvalPresentation/approvalSurfaces/commandRisk/workerContinuity） | 2026-09-22 |
| A4 | 前置调度定向测试 | `pnpm vitest run test/agent/middleware/mediaPreprocess.test.ts` | 0 | 5/5 通过（匹配执行替换 / 失败跳过 / 无工具回退旧路径 / 多 kind 独立匹配 / capabilities 透传） | 2026-09-22 |
| A5 | 媒体/运行时/中间件相关定向回归 | `pnpm vitest run test/agent/sense/media.test.ts test/agent/sense/index.test.ts test/agent/runtimeResolver.test.ts test/agent/middleware/mediaRetention.test.ts` | 0 | 4 文件 38/38 通过 | 2026-09-22 |

**手动验证清单**：（待登记，只保留四类：真实视觉与交互 / 主观 UX 判断 / 跨设备·窗口·无障碍 / 性能体验；操作卡见 `verify/manual-final.md`）

## 用户审批

最终综合验证三阶段完成后进入 `待用户审批`；用户明确批准后按计划规范收口（迁移长期证据到 `docs/quality/verification/` 并删除任务目录）。
