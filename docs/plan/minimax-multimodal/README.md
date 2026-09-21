# MiniMax 多模态图片能力对接

**文档创建时间：** 2026-09-21T11:22:56+08:00

**状态：** 执行中

## 目标与边界

### 目标

把 MiniMax 的多模态图片能力接入 CheryClaw：图片理解（对话中看图）与图片生成（image-01 文生图/图生图），打通 **上传 → 展示 → 对话携带 → 多轮上下文保留 → 按需回溯** 的完整链路。核心要解决「连续对话中后续轮如何继续带着图片」这一多模态上下文携带问题。

### 边界（本次不做）

- **视频/语音多模态**：MiniMax 视频理解需要 `mm_file://` 文件接口（保留 7 天）、TTS/ASR 均不在本次范围，只记录设计留痕。
- **`recall_media` 模型侧回溯感官**：列为进阶方案，本期只做 UI 基础版回溯。
- **不新增官方 brain 配置**：按现有 brain 的 url 走，通用支持中转与官方端点（验证时另开临时配置即可）。
- **不引入公网存储**：媒体继续存本地 `.chery/media/`，图片进上下文统一用 base64（data URI）。

## 关键技术决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 图片进上下文方式 | 统一 **base64（data URI）**。官方文件接口的用途列表里没有「图片理解」，`mm_file://` 只给视频理解/视频生成素材用 → file_id 对图片不存在，排除 |
| 协议 | 沿用 brain 现有 `openai-chat-completions`（走 `openaiCompat`，其 `image_url` data URI 与 MiniMax 兼容）；`anthropic-messages` / `openai-responses` 路径顺带可用，不改默认 |
| 端点 | 通用支持：按 brain url 请求。中转与官方 `api.minimaxi.com` 都需实测 base64 透传 |
| 预压缩 | **分情况**：超阈值（如最长边 >1280px 或 >1MB）默认压缩（最长边 1280 / 质量 85，JPEG/WebP）；小图直接原图；GIF 动图、透明 PNG 不强制压缩；逐张可切换「原图/压缩图」，**界面显示两种选择的预计 token 消耗** |
| 历史保留窗口 | **近 3 轮**用户消息里的图片全程重发（压缩版，挂回原消息位置）；更早的图片转一行文字占位（模型不再直接看到图，消息历史仍完整可回溯） |
| 上下文图片上限 | 上下文内最多重发 **10 张** / 单轮新增 **≤5 张** / 图片总字节 **≤16MB**（给 64MB 请求体留裕量）；超限把最旧的转占位 |
| 约束方式 | **双重约束叠加**：compact 管 total token（需把图片纳入统计）；图片层单独管数量/字节 |
| token 统计 | **本地公式 + 官方接口**：本地按「压缩后尺寸 + detail」估 token（用于实时进度条、原图/压缩图选择估算）；发送前与 compact 判定调 MiniMax `POST /v1/responses/input_tokens` 或 Anthropic `count_tokens` 预检；实际消耗以响应 usage（含 cache_read_input_tokens）为准 |
| 成本控制 | 利用 MiniMax-M3 **自动缓存**（被动、前缀匹配、优惠价）：图片放在稳定历史位置、内容不变 → 命中缓存，重发边际成本低 |
| 生成图携带 | AI 生成的图（image-01 产物）也纳入可携带体系（补 `[[media:]]` 标记/入口），可被后续引用与回溯 |
| 展示修复 | 一并修复：用户上传的图片在发送后气泡与历史重载时正常显示，不露出 `[[media:]]` 内部标记 |
| 回溯 | 基础版：历史消息图片旁「重新带进上下文」入口，按需把对应图挂进下一轮附件（不占常驻缓存） |

### 现状缺口（本任务的根因）

1. `src/agent/middleware/chat.ts` `enrichMediaInputs` 只处理**最后一条** user 消息的 `[[media:]]` 标记 → 后续轮模型看不到历史图片，还把内部标记原文泄露给模型。
2. `LLMAttachment`（`src/core/message/adapter.ts`）是扁平数组、无消息位置 → 三个 provider 的 `buildMessages` 把全部附件挂到每条 user 消息上，位置错乱。
3. model-catalog 中 `minimax-m3` / `minimax-m2.7` 均 `input.image:false` → MiniMax 目前走媒体网关文本转写旧路径，未启用原生多模态（M2.7 官方不支持图片输入，不可开启）。
4. 前端 `web/src/utils/mediaUrls.ts` 只匹配 `/api/media/<filename>`；用户上传图 content 里是 `[[media:...]]` 标记 → 发送后气泡不显示图，历史重载会露出内部标记文本。
5. `src/utils/token.ts` `estimateTokens` 是本地文本启发式，**不统计图片** → 图片进上下文后进度条/compact 判定低估。

## 小任务台账

批次与依赖：批次一为上下文携带核心（串行强依赖）；批次二、三可并行于批次一之后；批次四依赖批次三的本地公式；批次五依赖批次一的携带机制；批次六依赖批次一；批次七（综合验证）在所有实现小任务完成后进入。

| 编号 | 小任务 | 批次 | 复杂度 | 依据 | 状态 | 链接 |
|---|---|---|---|---|---|---|
| 1.1 | `LLMAttachment` 契约扩展：携带来源消息位置/保留形态 | 一 | 2 | 单文件类型扩展，但影响 3 个 provider 调用点 | 完成 | [adapter.ts 变更](#执行记录) |
| 1.2 | 三 provider `buildMessages` 按消息归属挂图 | 一 | 3 | openaiCompat/anthropic/openaiResponses 三文件同步改，需保持既有文本路径不变 | 完成 | [provider 变更](#执行记录) |
| 1.3 | `enrichMediaInputs` 多轮保留：近 3 轮重发 + 数量/字节上限 + 更早占位 | 一 | 5 | 核心对话上下文构建，涉及保留窗口/上限/占位转换，风险最高 | 完成 | [chat.ts 变更](#执行记录) |
| 2.1 | model-catalog MiniMax-M3 能力开启（input.image / generate.image） | 二 | 1 | 改能力标记（模板+项目同步），需回归工具/媒体开关 | 完成 | [model-catalog 变更](#执行记录) |
| 2.2 | MiniMax 图片协议与端点验证（中转 + 官方 base64 透传） | 二 | 3 | 实测 openai-completions 图片透传，含单图≤10MB/请求≤64MB 边界 | 后置 | 需真实 key，见 7.1 验收清单 |
| 2.3 | 用户上传图片展示修复（气泡 + 历史重载） | 二 | 3 | 前后端展示链路（后端 marker→展示 URL 或前端认 marker），跨端 | 完成 | [mediaUrls/MessageBubble 变更](#执行记录) |
| 3.1 | 本地图片 token 估算公式（按压缩后尺寸 + detail） | 三 | 2 | `utils/token.ts` 扩展，不调网络 | 完成 | [token.ts 变更](#执行记录) |
| 3.2 | 官方 token 估算接口接入 + compact 判定纳入图片 | 三 | 3 | 接 MiniMax `input_tokens`/`count_tokens`，改造 compact 判定 | 部分 | compact 判定纳入图片由 3.1 达成；官方预检接口后置实测 |
| 4.1 | 预压缩与 token 选择 UX（分情况压缩 + 原图/压缩切换 + 估算展示） | 四 | 4 | 前端 canvas 压缩 + 逐张切换 + 估算展示，交互复杂 | 完成 | [预压缩 UX](#执行记录)；canvas 路径手动验收 |
| 5.1 | image-01 文生图/图生图接入 `generate_image` sense | 五 | 3 | MiniMax 图片生成调用（base64 输出/参考图 data URL） | 完成 | [generate_image 扩展](#执行记录)；真实调用后置 |
| 5.2 | 生成图落库/展示/可携带标记 | 五 | 3 | 生成图走 media 链路 + 补 `[[media:]]` 纳入携带 | 部分 | 落库/展示已有；可携带经 6.1 前端带回；真实调用后置 |
| 6.1 | 历史图片「重新带进上下文」入口（基础版） | 六 | 2 | 按需挂载入口，不占常驻缓存 | 完成 | [回溯入口](#执行记录)；UI 手动验收 |
| 7.1 | 综合验证与用户验收 | 七 | — | 汇总自动/手动清单 + 反馈回填槽（见下） | 进行中 | [最终综合验证](#最终综合验证) |

**复杂度口径**（本项目）：1 边界明确局部调整；2 单模块有限行为；3 需保持既有行为的多组件/多步骤；4 跨模块契约/持久化/恢复边界的高风险；5 核心执行语义/共享状态机/架构广泛兼容风险。

## 当前恢复检查点

- 批次一（1.1-1.3）已完成并验证（typecheck 通过；相关 392 测试零回归；新增 `test/agent/middleware/mediaRetention.test.ts` 6 用例覆盖保留窗口/占位/总数/单轮/字节/资产缺失）。
- 实现要点回写：`LLMAttachment` 新增 `messageId`（按消息归属挂图），`groupAttachmentsByMessage` 共享分组工具；三 provider 只把归属附件挂到对应消息；`enrichMediaInputs` 多模态旁路全历史解析，近 3 轮重发 + 更早占位，超限按「新→旧」保留最新、最旧转占位（总数≤10/单轮≤5/字节≤16MB）。
- 批次二（2.1/2.3）、批次三 3.1、批次四（4.1）、批次五 5.1、批次六（6.1）代码完成并自动验证；2.2（端点实测）与 3.2 官方预检接口、5.1/5.2 真实 image-01 调用依赖真实 key，后置到 7.1 验收。
- 下次恢复：7.1 综合验证（创建自动/手动验收清单 + 真实 key 脚本）。

## 执行记录

- 1.1-1.3 于 2026-09-21 完成：`src/core/message/adapter.ts`（LLMAttachment + groupAttachmentsByMessage）、`src/agent/provider/openaiCompat.ts`、`src/agent/provider/anthropic.ts`、`src/agent/provider/openaiResponses.ts`（按 messageId 归属挂图）、`src/agent/middleware/chat.ts`（多模态旁路多轮保留）。
- 2.1：`.chery.template/model-catalog.yaml` + `.chery/model-catalog.yaml` 的 `minimax-m3` facts/recommend 开启 `input.image: true`、`generate.image: true`（M2.7 保持关闭）。
- 2.3：`web/src/utils/mediaUrls.ts` `extractMediaUrls` 兼容 `[[media:filename]]` 标记（按出现位置排序）+ 新增 `stripMediaMarkers`；`web/src/features/agent/chat/MessageBubble.vue` 展示前剥离 media 标记；新增 `web/test/utils/mediaUrls.test.ts`（9 用例）。
- 3.1：`src/utils/token.ts` 新增 `estimateImageTokens`（OpenAI 兼容 tile 公式，low/default/high）、`src/service/media/index.ts` 新增 `readImageDimensionsSync`（PNG/JPEG/GIF/WebP 头部解析）；`sumRowTokens`/`sumChatConversationTokens` 把 content 里 `[[media:...]]` 图片纳入 token 统计（compact 判定由此纳入图片）；新增 `test/utils/tokenImages.test.ts`（9 用例）。
- 4.1：新增 `web/src/utils/imageCompress.ts`（shouldCompressImage/loadImageDims/compressImage，最长边 1280/质量 0.85，GIF 不压；另含「原图」版常量 2048/质量 0.9）+ `web/src/utils/mediaTokens.ts`（前端 token 公式镜像后端）；`MediaAttachment` 加压缩版/尺寸/useCompressed；`onMediaSelected` 需压时上传「原图版(2048/90) + 压缩版(1280/85)」双版本；`handleSend` 按选择携带；后续 UI 收口：原 `MediaPreviewBar` 大卡片条改为 `MediaThumbStrip` 小缩略图 + 「原图」tag（hover 说明 + token 估算）+ 同批次多图预览弹窗（对话/精简在输入框上方、树/对话面板在下方，三输入区统一）；新增 `web/test/utils/imageCompress.test.ts`（8 用例）。
- 5.1：`src/agent/sense/media.ts` `generate_*` schema 加可选 `reference`（图生图参考图），`src/service/media/index.ts` 新增 `resolveMediaAsset` 并按参考图解析透传给网关；`web/.../renderers/types.ts` `GenerateMediaArgs` 加 `reference`；`test/agent/sense/media.test.ts` 增 3 用例。
- 6.1：新增 `web/src/features/agent/chat/bringMediaEvent.ts`（window CustomEvent 广播）；`useAgentDialogOptions.addMediaAttachment`（历史图加入待发送，去重）；AgentDialog 监听带入；`MediaInlineRenderer` 图缩略图加「重新带进上下文」按钮；`MessageBubble` 启用 bringBack。

## 影响文档（收口时回写权威文档）

已同步更新：`docs/backend/agent/model-capabilities.md`（双轨策略多轮保留 + MiniMax 图片协议）、`docs/backend/core/message.md`（LLMAttachment 契约：`messageId` + 多轮保留形态）、`docs/backend/agent/provider.md`（anthropic 图片附件按 messageId 归属）、`docs/backend/agent/prompt.md`（conversation 段图片 token）、`docs/shared/architecture/agent-orchestration.md`（context usage 图片 token）。`docs/backend/service/http.md` 无契约变化（媒体仍走 `/api/media/`），不改。

## 最终综合验证

7.1 于 2026-09-21 完成代码阶段：自动验证全部通过；手动项与真实 key 项见下方清单。

**自动验证清单（已执行通过）：**

| # | 目标 | 命令 | 退出码 | 关键断言行 |
|---|------|------|--------|-----------|
| T1 | 后端类型门控 | `pnpm type-check` | 0 | 0 错误 |
| T2 | 前端类型门控 | `pnpm web:type-check` | 0 | 0 错误（另修一处他人 relay 在途改动暴露的 `platform.ts` port 判空潜伏错） |
| T3 | 批次一多轮保留 | `pnpm vitest run test/agent/middleware/mediaRetention.test.ts` | 0 | 6 用例：近 3 轮重发/更早占位/10 张上限/单轮 5 张/16MB 字节/资产缺失 |
| T4 | 批次一既有回归 | `pnpm vitest run test/agent/middleware test/agent/provider test/core/message` | 0 | 392 用例零回归 |
| T5 | 批次二展示 | `pnpm vitest run --config web/vitest.config.ts web/test/utils/mediaUrls.test.ts` | 0 | 9 用例：marker/URL 识别、排序、剥离、不误伤 command |
| T6 | 批次三 token | `pnpm vitest run test/utils/tokenImages.test.ts` | 0 | 9 用例：公式三档 + PNG/JPEG/GIF/WebP 头解析 |
| T7 | 批次五图生图透传 | `pnpm vitest run test/agent/sense/media.test.ts` | 0 | 11 用例：reference 两种形态透传/资产缺失 |
| T8 | 批次四压缩工具 | `pnpm vitest run --config web/vitest.config.ts web/test/utils/imageCompress.test.ts` | 0 | 8 用例：压缩判定/GIF 不压/前端 token 公式 |
| T9 | 全量后端相关回归 | `pnpm vitest run test/agent/middleware test/agent/sense test/agent/provider test/core/message test/utils` 等 | 0 | 518 用例零回归（`deleteChat`/`deleteLifecycle` 5 例为既有 DB 并发失败，与本任务无关，已用 git stash 对比确认） |
| T10 | 前端相关回归 | `pnpm vitest run --config web/vitest.config.ts web/test/utils web/test/agents web/test/chats web/test/composer` | 0 | 198 用例零回归 |

**真实 key 验证**（无法离线完成，供用户/验收执行）：`verify/minimax-image-e2e.mjs` — 设置 `MINIMAX_API_KEY`（与可选 `MINIMAX_BASE_URL`/`MINIMAX_MODEL`）后运行，覆盖：2.2 图片理解 base64 透传（中转/官方）、3.2 `responses/input_tokens` 含图预检、5.1 image-01 文生图 base64 输出。

**手动验证清单**：`verify/manual-final.md`（A 上传展示 / B 预压缩与 token 选择 / C 多轮保留 / D 生成图 / E 历史回溯 / F 边界，每项 ≤1 分钟）。

**反馈回填槽**（阶段一内登记，收口前清零）：

- canvas 压缩路径（`compressImage`）依赖浏览器环境，自动测试只覆盖判定与公式，真实压缩由手动 B1-B4 验收。
- 透明 PNG 无像素级检测，采用「PNG 且体积超 1MB 才压」的近似（小体积透明 PNG 不压），已写入 `imageCompress.ts` 注释与手动验收项。
- 「重新带进上下文」经 window CustomEvent 广播，同一事件多个 AgentDialog 实例各自去重添加；极端同屏双 composer 场景由手动 E3 复核。
- `deleteChat`/`deleteLifecycle` 5 个既有失败（DB `CONFLICT`/`Chat not found`）非本任务引入，建议另起任务排查测试隔离。

## 用户审批

最终综合验证三阶段完成后进入 `待用户审批`；用户明确批准后按计划规范收口（迁移长期证据到 `docs/quality/verification/` 并删除任务目录）。
