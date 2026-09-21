# 媒体外部服务化与工具能力声明——需求文档

**文档创建时间：** 2026-09-22T01:06:05+08:00

**状态：** 规划中（需求基线，供实现与评审引用）

> 本文档是 [计划 README](./README.md) 的需求基线。实现收口时，有长期价值的结论迁入权威文档（见「迁移路径」），本文档随任务目录删除。

## 1. 背景与动机

当前 CheryClaw 的「多媒体」能力是一套**硬编码、与大脑能力标记强耦合**的体系，存在四个结构性问题：

1. **能力开关放错位置**：`generate_image/video/audio` 是否注入由「大脑 `capabilities.generate.*` + 感官组」双重门决定（[`src/agent/runtimeResolver.ts`](../../../src/agent/runtimeResolver.ts) `resolveSense`）。但生成工具的 `execute` 实际走多媒体网关（[`src/agent/sense/media.ts`](../../../src/agent/sense/media.ts)），**与大脑模型完全无关**。能力声明与执行路径语义混淆。
2. **媒体服务配置粗粒度且写死协议**：`MediaServiceConfig`（[`src/utils/config.ts`](../../../src/utils/config.ts)）只有 `type/url/model/key/enabled/maxUploadMb` 六字段，一个服务 = 一个媒体类型；`operation`（understand/generate/edit）是请求时参数而非配置字段；无 TTS/STT/音色克隆等细分入口。网关协议固定为 JSON POST + 固定出参 `{text, assets}`，**无法适配市面上五花八门的外部服务出参**。
3. **适配能力不存在**：系统不试图覆盖各厂商差异，但当前也没有「用户可自定义出入参处理」的机制——媒体能力被锁死在内置 `generate_*` 里。
4. **发送门控不看工具**：发送弹窗的上传前提是「有媒体服务 OR 大脑 `input.*`」（[`web/src/features/agent/composer/useAgentDialogOptions.ts`](../../../web/src/features/agent/composer/useAgentDialogOptions.ts) `mediaServicesByType`），**不感知感官组里配了什么工具**。工具自身也没有任何「我接收什么、产出什么」的能力声明。

同时，系统**已经具备用户自定义工具机制**（`.chery/senses/*.ts` → 编译 → 动态加载，见 [`src/agent/sense/index.ts`](../../../src/agent/sense/index.ts) `loadCustomSenses` 与 [`src/core/sense/compiler/core.ts`](../../../src/core/sense/compiler/core.ts) `compileSenses`），它的执行 handler 天然支持任意出入参逻辑——这正是「适配器」需要的全部能力。

## 2. 目标

把「多媒体」从硬编码内置工具重构为**通用外部服务体系**，复用并扩展现有自定义工具机制：

1. **工具能力声明**：给 `Sense` 增加能力声明字段（`accepts` / `produces` / `preprocess` / `batchSize`），工具自己声明「接收什么、产出什么、是否前置、每批容量」。
2. **生成类工具化**：`generate_image/video/audio` 从「大脑 `generate.*` 双门」中解放，改由工具自身 `produces` 声明注入；能力开关放工具（感官组），大脑能力标记只保留「多模态模型输入直传」语义。
3. **前置执行调度**：理解类媒体在非多模态模型下，由声明了 `preprocess` 的工具在发请求前执行，结果替换进消息；多模态模型优先直传。
4. **密钥与配置解耦**：外部服务只配关键密钥（`.env`），逻辑全部在自定义工具（sense）内；设置页提供一键打开 `.env` 入口。
5. **CherryNexus 自动生成**：支持一键生成符合规范的外部服务自定义工具（出入参 + 函数由 AI 按需求生成，用户确认后编译加载）。

## 3. 非目标（本次不做）

- **理解类不工具化**：看图/听音作为对话输入**不是工具调用**，是输入通道（多模态直传或前置理解），不套工具模型。详见 §5.4。
- **不新建适配器目录**：适配器就是自定义 sense，落在 `.chery/senses/`，不另建 `.chery/adapters/` 等位置（复用现有编译/加载/监管/渲染链路）。
- **不引入公网存储**：媒体继续存本地 `.chery/media/`，内部规范出参统一落盘为受控资产。
- **hooks 不作为主方案**：`UserPromptSubmit` 等 hooks 是全局事件、无类型匹配与工具绑定，仅作补充参考，不替代声明式前置工具。
- **不追求「纯配置零代码」覆盖全部外部服务**：声明式配置只能覆盖常见协议，五花八门的出参仍由自定义工具（代码级适配器）兜底。

## 4. 现状盘点（代码事实）

| 事实 | 位置 |
|---|---|
| 内置生成 sense：`generate_image/video/audio`，schema 固定 `{prompt, reference?}` | [`src/agent/sense/index.ts`](../../../src/agent/sense/index.ts)（第 168-199 行） |
| 生成执行：固定调媒体网关 `callMediaService(kind, 'generate', ...)`，结果 `saveMediaAsset` 落盘 | [`src/agent/sense/media.ts`](../../../src/agent/sense/media.ts) |
| 双重门注入：`generateCapabilities` 拦截，需「感官组配置 + brain.generate[kind]=true」 | [`src/agent/runtimeResolver.ts`](../../../src/agent/runtimeResolver.ts) `resolveSense` |
| 输入双轨：多模态旁路（全历史解析、近 3 轮重发、数量/字节上限）vs 旧路径（最后一条 user 消息调网关 `understand` 转文字） | [`src/agent/middleware/chat.ts`](../../../src/agent/middleware/chat.ts) `enrichMediaInputs` / `enrichMediaInputsMultimodal` / `enrichMediaInputsLegacy` |
| 媒体网关协议：JSON POST `{operation, model, prompt, assets}`，返回 `{text}` 或 `{text, assets}` | [`src/service/media/index.ts`](../../../src/service/media/index.ts) `callMediaService` / `findMediaService` / `understandMediaReference` |
| 媒体配置：`MediaServiceConfig` 六字段，一个服务 = 一个媒体类型，无操作/子任务细分 | [`src/utils/config.ts`](../../../src/utils/config.ts)（第 142-151 行） |
| 发送门控：媒体服务 OR 大脑 input 能力，不看工具 | [`web/src/features/agent/composer/useAgentDialogOptions.ts`](../../../web/src/features/agent/composer/useAgentDialogOptions.ts)（第 1394-1408 行） |
| 自定义工具机制：`.chery/senses/*.ts` → `compile:senses` → `loadCompiledSense`（`new Function`）→ 注册 | [`src/agent/sense/index.ts`](../../../src/agent/sense/index.ts) `loadCustomSenses`（第 386 行）、[`src/core/sense/compiler/core.ts`](../../../src/core/sense/compiler/core.ts) `compileSenses` |
| Sense 定义结构：`definition / executor / supervisionLevel`，**无能力声明字段** | [`src/core/sense/senseCreator.ts`](../../../src/core/sense/senseCreator.ts) `Sense<T>` / `sense()` |
| env 入口：大脑 Tab 有「打开 .env」按钮（`openEnvFile`）+ 密钥下拉（`env.list`）+ 刷新 | [`web/src/features/agent/settings/tabs/brain/BrainCard.vue`](../../../web/src/features/agent/settings/tabs/brain/BrainCard.vue) `openEnvFile`（第 453 行） |
| 多媒体 Tab：只有密钥下拉，**无「打开 .env」按钮** | [`web/src/features/agent/settings/tabs/config/MediaTab.vue`](../../../web/src/features/agent/settings/tabs/config/MediaTab.vue) |
| 历史图带回：`bringBack` 事件把历史媒体挂进待发送 | [`web/src/features/agent/chat/bringMediaEvent.ts`](../../../web/src/features/agent/chat/bringMediaEvent.ts) |

## 5. 目标设计

### 5.1 工具能力声明（核心契约）

给 `Sense` 增加能力声明，工具自己描述「接收什么、产出什么、是否前置、每批容量」：

```ts
sense('generate_image_v2', '生成图片', schema, handler, {
  accepts: ['image'],      // 接收什么：媒体类型 image/audio/video 或文件后缀 doc/docx/pdf
  produces: ['image'],     // 产出什么：媒体类型或 text
  preprocess: false,       // 是否前置执行；缺省 false = 普通后置工具
  batchSize: 3,            // 每批最多几张；缺省 = 一次性全量处理
})
```

**设计要点：**

- **`accepts` 用一套统一表达**：媒体类型（`image`/`audio`/`video`）与文件后缀（`doc`/`docx`/`pdf`）都只是「类型标签」，同一套匹配逻辑。前置执行时按文件实际类型（MIME 或后缀）匹配。
- **`preprocess` 缺省 false**：绝大多数工具是普通后置工具（模型按需调用），前置是显式 opt-in，零成本默认。
- **`batchSize` 是「每批上限」不是「必须满批」**：前端/前置层永远一次性全量传入，工具内部自己分批、自己合并、自己管并发。多图融合类工具（如多图生一张）的 `batchSize` 语义是「每批最多融合几张」，由工具作者自定。
- **服务与工具是 1:N**：一个外部服务 = 一组带命名空间的 sense（如 `audio-tts` / `audio-stt` / `audio-clone`），复用 MCP 现有 `mcp__<server>__<tool>` 命名模式。

### 5.2 前置执行调度（preprocess）

理解类媒体在**非多模态模型**下的流程：

```
收到用户消息，扫描媒体/文件引用（[[media:xxx]] / [[file:xxx]]）
   ↓
① 当前大脑对该类型有原生理解能力？（input.*）
     有 → 直传，模型自己看，不触发任何前置工具
     没有 → 进入②
   ↓
② 有没有 accepts 命中该类型 且 preprocess=true 的工具？
     有 → 前置执行，把结果替换进消息（[media] → 工具产出）
     没有 → 无法理解，按现有逻辑提示或跳过
   ↓
③ 替换后的消息 → 交给模型分析
```

**边界语义（必须保持）：**

- **不持久化**：前置结果仅替换本轮内存请求的消息，不改写 DB 原始消息（与现有 `enrichMediaInputs` 一致）。
- **失败跳过 + 明确提示**：前置工具执行报错时不阻断整轮发送，跳过并把提示带进上下文。
- **前置默认自动执行**：用户已明确上传文件，意图清晰，前置工具不进入 smart 审批流；特殊敏感工具可单独声明审批。

### 5.3 生成类工具化

- `generate_image/video/audio` 的注入判断从「大脑 `generate.*` 双门」改为**工具自身 `produces` 声明**：感官组里配置了 `produces: ['image']` 的工具即注入。
- 大脑 `generate.*` 标记退役（兼容期保留但不作为注入门），`input.*` 保留为「多模态模型输入直传」声明。
- 内置生成 sense 保留为可卸载的默认实现，用户可用自定义 sense 替换或扩展（命名空间归组）。

### 5.4 理解类输入通道（不工具化）

**工具调用 = 模型的「手」；媒体理解输入 = 模型的「眼」**。两者本质区别：

| 维度 | 生成类（工具调用） | 理解类（输入通道） |
|---|---|---|
| 谁发起 | 模型主动决定 | 用户上传即触发，系统必须处理 |
| 是否可选 | 模型可不用 | 必须生效，否则图就丢了 |
| 时序 | 对话推进中决定 | 必须在模型回答前完成 |
| 结果去向 | 产生新资产进对话 | 修正输入本身，让模型看到 |

因此理解类**不能 sense 化**为普通工具（会引入「模型自觉调用」的不可靠性）。正确形态是**双轨**：

- 多模态模型 → 直传（现有旁路）
- 非多模态模型 → 前置工具兜底（§5.2）保证图片必生效 + 可选理解工具供模型按需二次细看

### 5.5 内部规范出参（适配外部多样化出参）

不试图让系统覆盖所有厂商，而是**在外部与内部之间加一层翻译**，内部永远只认一种规范：

```
外部服务（出参五花八门：URL / base64 / JSON 数组 / 二进制……）
        ↓ 第①层：适配器（自定义 sense 的执行 handler）
          把外部出参翻译成内部规范
        ↓ 第②层：内部规范出参（系统唯一认的格式）
          { text?, items: [{ mimeType, data(base64) | url, batchIndex }] }
        ↓ 第③层：资产落盘
          转成受控本地资产 /api/media/<filename>
        ↓ 第④层：渲染层（只认规范）
          图片→img、视频→video、音频→audio
```

**要点：**

- 翻译责任在适配器，不在系统；新增厂商 = 新增一个自定义 sense，不动系统。
- 内部规范要小、要稳定：「文字 + 一批媒体文件（类型/数据/可选地址）」装得下所有类型。
- `batchIndex` 标记结果所属批次，下游（落盘/渲染/上下文）不猜。
- 落盘后一切统一：渲染、对话携带、回溯、参考图引用全部复用现有 `/api/media/` 链路。

### 5.6 密钥与配置解耦

- 外部服务密钥写 `.env`（密文/变量），sense 执行时从 `$ENV` 占位读取（现有机制已支持）。
- 设置页「打开 .env」入口：把大脑 Tab 的 `openEnvFile` 模式复制到多媒体/外部服务设置处（当前 MediaTab 只有密钥下拉，无打开按钮）。
- 服务级信息（url/key/model）放 config，逻辑（出入参翻译）放 sense，实现「解耦配置」。

### 5.7 CherryNexus 自动生成外部服务工具

CherryNexus 是系统固定预设，具备 `write_file`/`execute_command` 能力，可生成符合规范的自定义 sense：

```
用户：「帮我接一个能生成图片的外部服务」
   ↓
CherryNexus 按规范生成 .chery/senses/*.ts（accepts/produces/preprocess/batchSize
  + 出入参 schema + 调用外部 API + 内部规范出参归一化）
   ↓
用户查看确认 → compile:senses 编译 → 加载 → 进感官组
```

**安全边界（必须保持）**：自定义 sense 用 `new Function` 执行，信任边界 = `.chery/senses/*.ts`。AI 生成的代码**必须经用户查看确认后才能编译加载**，不能静默生效（与技能导入确认同一心智）。

## 6. 验收标准（需求层面）

1. 用户可在 `.chery/senses/` 定义带能力声明的工具，声明后发送弹窗、注入、前置调度自动识别，无需改系统代码。
2. 非多模态模型上传图片时，`preprocess` 工具自动执行并把结果替换进消息；多模态模型仍直传。
3. 生成类工具不再依赖大脑 `generate.*` 双门；感官组配置 `produces: ['image']` 的工具即注入。
4. 外部服务出参（URL/base64/JSON）经自定义 sense 翻译后统一落盘为 `/api/media/`，前端正常渲染。
5. 多图输入：前端全量传入，工具按 `batchSize` 内部分批处理并返回 `batchIndex` 标记的结果。
6. 设置页可一键打开 `.env`；外部服务密钥经 env 占位读取，不硬编码进 sense 代码。
7. CherryNexus 可一键生成符合规范的外部服务工具，生成产物需用户确认后编译加载。
8. 现有 MiniMax 图片理解/生成、多轮保留、历史回溯等功能不回归（回归见计划 README 综合验证）。

## 7. 迁移路径（收口时）

实现完成后，以下有长期价值的内容迁入权威文档（本文档不作为唯一副本）：

| 结论 | 迁入位置 |
|---|---|
| 工具能力声明契约（accepts/produces/preprocess/batchSize） | `docs/backend/core/sense.md`（Sense 契约） |
| 媒体外部服务架构、内部规范出参四层协议 | `docs/backend/agent/model-capabilities.md` 或新建 `docs/backend/agent/external-service.md` |
| 前置执行调度与理解类双轨策略 | `docs/backend/agent/model-capabilities.md` |
| 发送门控、env 密钥入口 | `docs/frontend/settings.md` |

## 8. 待定问题（需后续决策）

1. 大脑 `generate.*` 标记的退役时机与兼容期（是否先保留字段、标记 deprecated）。
2. 内置生成 sense（`generate_image` 等）在 sense 化后是保留为默认实现还是整体移除。
3. `accepts` 文件后缀标签的初始白名单（doc/docx/pdf/xlsx…）与 MIME 映射表。
4. CherryNexus 生成外部服务工具是否需要独立的专用提示词/角色，还是复用现有角色。
5. 多媒体 Tab 的最终形态：退化为「密钥 + 挂载工具」薄壳，还是并入感官组 Tab。
