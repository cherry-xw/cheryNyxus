# 文件能力与多模型协作

**文档创建时间：** 2026-09-21T11:22:56+08:00

**状态：** 执行中

**计划形式：** 总任务与专题设计；普通实施入口在本文维护，专题保留尚未完成的需求与判断依据。

## 目标与授权

让 cheryNyxus 的文件配置、保存、模型输入、角色协作与交付遵守同一套规则。Web 与 AI 使用相同配置，历史保留文件，不要求每轮把全部文件发送给模型；文件结果按固定版本返回主会话。

- 原范围 D01—D20、T01—T24 已确认，用户已选择按推荐实施、破坏性替换；一次性迁移保留会话、文件和凭据，不保留旧运行分支。
- 沿用已确认的当前模型；实施复杂度 5/5，需要跨配置、协议、数据库、异步执行与 Web 分析。允许在范围内连续推进，不重复询问已确认决定。
- 图片默认含采用或重新读取在内保留 3 用户轮；到期只改变发给模型的内容，不删除历史和文件；自动补描述可选且默认关闭，详见[图片上下文设计](image-context-design.md)。
- 服务端工具采用用户选择的一方案：保留本地 `senseCalls` / `role: 'sense'`，新增独立 `serverToolCalls` / `executionOwner: 'server'`。不能将云端已完成工具再次送本地审批或执行；ST01—ST13 尚未全部完成。
- **所有已批准的付费批次均已用完或关闭。** 未用余额不得挪用，后续任何真实请求必须先取得新批准，并限定次数、型号、输入和预算。本地代码与离线验证可以继续。
- GLM 图片只复用原图，中性问题为“请描述这张图片的内容。”，不加对象提示或历史；允许相关客户端内置说明和工具定义，但不能整套复制客户端身份。先参考官方资料、公开实现和既有成功记录，再确定请求。
- 不安装额外 MCP，不做直连/代理比较，不排查代理，不猜 IP/域名限制；GPT 云端工具仅继续 Codex 用法的网络搜索，不重测网页读取、Python 或 Shell；视频没有本地素材，明确跳过，不创造素材。
- 不生成新图、不部署或重启生产、不实际向 QQ 发送、不启动浏览器、不截图或由执行助手查看图片。真实界面与图片验收由用户执行。

## 详细设计入口

设计文档是已批准要求及未完成核对的依据，不表示当前产品已经全部可用。

| 文档 | 用途 |
| --- | --- |
| [决定与开发完成条件](design-decisions.md) | D01—D20、T01—T24 的确认与归属 |
| [功能明细](functional-spec.md) | F01—F36 的功能、边界与能力组合 |
| [配置与执行](configuration-runtime.md) | 配置字段、适配器、资产、消息、任务与迁移要求 |
| [前端交互](frontend-ux.md) | 配置、上传、混排、委派、重新引用和失败处理 |
| [界面适配](ui-adaptation.md) | 现有风格、层级与响应式要求 |
| [验收矩阵](acceptance.md) | 可观察结果与需求实现核对 |
| [图片上下文](image-context-design.md) | 保留、描述、重新读取与验收条件 |
| [服务端工具](server-tools-design.md) | ST01—ST13、GLM/GPT 证据、比较、实现缺口与验收 |
| [剩余验证](08-verification.md) | 本任务未通过项、授权及验收准备 |

长期规则归[模型能力](../../backend/agent/model-capabilities.md)、[Provider](../../backend/agent/provider.md)、[消息](../../backend/core/message.md)、[设置](../../frontend/settings.md)、[工作台文件](../../frontend/workbench-files.md)和[QQ 协议](../../shared/protocol/qqbot-plugin.md)；可复用命令归[文件能力验证](../../quality/verification/file-capabilities.md)。

## 完成标准

1. Web 与 AI 配置得到相同的实际能力、缺失原因及生效状态。
2. 主角色可以直接调用文件工具或带文件委派其他角色，不把纯生成模型伪装成聊天角色。
3. 文件保存、历史展示和模型输入分开；工具与子任务返回结构化文件，不从回复 URL 猜文件结果。
4. 上传、下载、固定版本预览、重新引用、重启恢复与权限有效；旧图按轮退出，显式读取可恢复。
5. 服务端工具有独立调用/结果/来源，失败与未知状态不报成功，真实本地调用仍遵守原授权。
6. 配置、模板、正式说明与验证同步。离线通过不代替真实接口、QQ、生产依赖和人工验收。

## 实施定位与依赖

| 编号 | 工作与入口 | 依赖 | 状态 | 复杂度及依据 |
| --- | --- | --- | --- | --- |
| 1 | 共享契约：`packages/protocol/src/`、`packages/plugin-api/src/`、`core/message/adapter.ts` | 无 | 已完成 | 5：所有入口及持久数据共用 |
| 2 | [存储与迁移](configuration-runtime.md)：`db/assets.ts`、`db/fileDeliverables.ts`、`service/media/assetStore.ts`、`migration.ts`；原版不可覆盖、授权、引用、去重及有序消息 | 1 | 进行中 | 5：保留历史与跨端文件 |
| 3 | [配置与能力](configuration-runtime.md)：`service/config/operations.ts`、`service/fileServices/capabilityResolver.ts`、`agent/runtimeResolver.ts`；Web/AI 共用校验及版本采用 | 1 | 进行中 | 5：多入口及排队重查 |
| 4 | [执行与交付](configuration-runtime.md)：`agent/middleware/fileInputPlanning.ts`、`service/fileServices/operations.ts`、`service/chat/spawnFinalize.ts`、`wake.ts`；保存重试不重新生成、固定成果与父会话交付 | 2、3 | 进行中 | 5：异步失败与恢复 |
| 5 | [Web 文件](frontend-ux.md)：`FileServicesPanel.vue`、`useAgentDialogOptions.ts`、`useAssetCard.ts`、`application/files/`；草稿、试用、引用、位置撤销及固定版本下载 | 2、3、4 | 进行中 | 4：多会话视图一致性 |
| 6 | [AI 与模板](functional-spec.md)：`configManage.ts`、`skillCapabilities.ts`、`loadSkill.ts`、`apps/backend/.chery.template/`；必需/可选技能依赖分开，不把自然语言自动编译为流程 | 3、4 | 进行中 | 4：发现、配置与检查一致 |
| 7 | [文档与需求核对](acceptance.md#7-需求完成核对)、正式模块说明；删除旧字段、入口和无消费者结构 | 1—6 | 进行中 | 4：多处消费者同步 |
| 8 | [综合验证与用户验收](08-verification.md) | 7 | 进行中 | 5：真实接口与人工结果独立判断 |
| 9 | [服务端工具 §5](server-tools-design.md#5-cherynyxus-当前实现缺口)：配置隔离、设置/目录、图片输入和完整事件恢复 | 1—6 | 进行中 | 4：记录已接通，产品条件与验收仍未完成 |

原范围实现核对继续按 T01—T24 和 F01—F36 执行，不因整理实施笔记而删除要求。普通实施的当前入口并入本表，设计与有效证据仍保留。

## 待处理事项

- 按服务端工具 §5 先补配置独立验证状态、能力来源/已知工具目录展示、完整有序事件保存与恢复；不能把余项仅归为真实调用验证。服务端图片输入开放仍受 S1 自有请求验证限制。
- GLM 图片最小工具条件、自有工具定义、非流式、私有块续接与产品多轮重放未验证；搜索→读取原文→有依据的最终答案尚未完成。
- MiniMax 普通保留图片轮的回答仍失败；明确重新读取成功不代表普通轮问题解决。GPT 严格工具定义修正后的完整历史重放、GLM-5.3-Flash 完整后端多轮仍待验证。
- 其他文件服务的真实输入/生成/编辑/错误/引用、QQ 实发、生产 Sharp 安装和人工界面验收未完成。
- 工作区有登录、中转、ADV、QQ 下载和其他任务的修改。共享文件按段落提交；不回滚或夹带其他任务。目录及启动约定归[后端运行说明](../../guides/backend-runtime.md)，不据此扩大本任务验收。

## 当前恢复检查点

**恢复顺序：** 本文 → [服务端工具 §5](server-tools-design.md#5-cherynyxus-当前实现缺口) → 选定实现与测试 → [剩余验证](08-verification.md)。总任务保持执行中，未获完整验收批准。

- **当前实现**：统一资产及适配版本、授权/引用/迁移、有序消息、排队恢复、六种 HTTP 文件适配器和自定义/MCP 文件工具、部分产出保存与恢复、角色成果、Web 配置/试用/历史/草稿/重新引用、QQ 通用导入与分段读取、NapCat 文件发送均已有代码。Sharp 为后端生产依赖，尚未在生产安装验证。
- **服务端记录**：Anthropic Messages 与 GPT Responses 解析工具事件、结果及引用；显示记录存于 `messages.provider_continuation.serverToolCalls`，不进入本地 `sense_calls`。已处理嵌套凭据、带签名 URL 和 Base64 脱敏、结构化错误、孤立结果未知状态、混合响应审批延迟和完成后跳过伴随本地调用、保存更新/清空及单图观察描述。展示已接通，不表示完整事件顺序与私有续接已完成。
- **当前提交内容的离线验证**（2026-10-17，Linux）：在独立副本中仅放入本任务准备提交的内容，不依赖其他任务未提交的源码。后端 37 文件/455 项、Web 9 文件/33 项、QQ 11 文件/49 项、NapCat 5 文件/32 项、QQ 协议 2 文件/14 项通过；后端/Web/QQ/NapCat 类型检查、相应构建和差异空白检查通过。文档测试 9 项通过，独立副本文档检查仍有 HEAD 已有的链接/目录/计划问题，没有新增；当前完整工作区文档检查退出 0。结果在 `/tmp/opencode/file-capabilities-commit/` 的 `*-final.log`、`docs-check-final.json`、`docs-baseline-comparison.json`。这些不是实际接口、生产或人工验收。
- **独立验证的既有失败**：QQ 全套的 `plugins/qq/test/informationWire.test.ts` 在未包含其他任务测试修正时失败；用 HEAD 和独立副本均复现为通知动作未调用。上述 QQ 49 项结果明确排除这一项，不表示 QQ 全套通过。原始结果为 `qq-information-baseline.log` 和 `qq-tests-final.log`。不为清理提交夹带另一任务的测试修正。
- **实际接口结论**：GLM-5.3 为原生文本模型，Claude Code 2.1.183 完整请求在同一入口产生关联 `analyze_image` 服务端调用/结果；去头或去 system 两组成功，去工具与简化 Read 请求未成功，最小触发条件未知。独立搜索与 `webReader` 已分别成功，搜索结果续接主会话后请求原文，但未给出原问题最终答案。GPT Responses 的 Codex 用法网络搜索成功，含 `web_search_call`、非空来源和有依据回答；独立成功不能代替产品验收。具体样本、哈希、对照和预算归[专题 §2](server-tools-design.md#2-已验证的调用流程与边界)。
- **图片局部结果**：MiniMax 已核对实际携图、3 轮退出、重启计数及明确重新读取回答，但普通保留轮拒答；GPT 基本看图、Gemini 基本看图和历史重放、GLM-5.3-Flash 单次看图有局部成功。GPT 原完整历史因严格工具定义被拒，离线修正后未真实重试。均不等于各型号独立完整多轮验收。
- **原图不变**：资产 `6698a383-d622-4efb-b1a6-4147e63a1699`，版本 `bf5210b4-72e4-4b7c-9e65-9278a6f8dfc3`，SHA-256 `578e5b3c5ef5c49be1cd767fee7af40e68a2e74d039b1443c2feea13c9d1a6a6`。GPT 单张生成与保存仅为已有局部证据，不能再生成；实际尺寸与请求精确尺寸未一致。图片未由执行助手查看。
- **证据与恢复资料**：GLM/GPT 原始结果和批准记录在 `/tmp/opencode/`，GPT 为 `gpt-responses-cloud-tools/`；仍用于剩余条件核对，不能清理。正式脱敏回归样本为 `apps/backend/test/agent/provider/fixtures/server-tools-observed.json`，不依赖临时目录，不含请求头、图片、思考、最终回答或账号信息。MiniMax 脚本保留在 `verify/`，复用前核对新协议并重新取得付费调用批准。
- **下一步与权限**：先完成仍可离线推进的产品缺口；需要真实调用时再申请新限额。没有 QQ 发送、生产部署、浏览器或读图授权，不执行这些动作。完成必要验证后交用户审批，批准前不删除整个任务。
