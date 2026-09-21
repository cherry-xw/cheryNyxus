# 模型能力与媒体处理

> 配置 [src/utils/config.ts](../../../src/utils/config.ts) ｜ 运行时 [src/agent/runtimeResolver.ts](../../../src/agent/runtimeResolver.ts) ｜ 媒体服务 [src/service/media/index.ts](../../../src/service/media/index.ts) ｜ 前端 [web/src/features/agent/chat/AgentDialog.vue](../../../web/src/features/agent/chat/AgentDialog.vue)

## 目标

模型能力是 `llm.brain.<name>` 的唯一来源：角色只继承、展示并受其约束。能力同时影响设置页、会话内临时换模型、`runtime.set` / `session.runtime.set` 校验、LLM 请求参数以及可见的媒体工具。

```yaml
llm:
  brain:
    vision-agent:
      provider: openai
      model: example-model
      capabilities:
        toolCall: true
        input: { image: true, video: true, audio: true }
        generate: { image: true, video: false, audio: false }

media:
  maxUploadMb: 100
  image:
    enabled: true
    url: https://media-gateway.example/image
    model: image-model
    key: $MEDIA_API_KEY
```

## Brain 能力契约

`BrainCapabilities`：

| 字段 | 缺省 | 含义 |
|---|---:|---|
| `toolCall` | `true` | 是否可向模型传递 function/tool schema、接收并执行 sense call |
| `input.image/video/audio` | `false` | 是否可接受对应上传媒体的理解结果 |
| `generate.image/video/audio` | `false` | 是否可调用对应媒体生成 sense |

兼容策略：旧 brain 未配置 `capabilities` 时仍视为支持 Tool Call，媒体能力均关闭。`generate.*=true` 时不得设置 `toolCall=false`。

## Tool Call 降级与角色约束

无 Tool Call 的 brain 是“仅对话”模型：

- 配置保存拒绝角色为它配置非空 `senseGroup` 或 `mcpServers`。
- `chat.create`、`runtime.set`、`session.runtime.set` 均经过 `parseRuntimeSelection()` 二次校验；客户端绕过 UI 也会被拒绝。
- runtime 使用空 `senseGroup`、空 `mcpServers`，`RuntimeResolver` 生成空 `builtSenses/senseTable`；provider 不发送 `tools` 参数。
- 设置页切换角色 brain 时会清空并禁用感官/MCP；会话发送弹窗临时切换到无工具 brain 时同样清空工具选择。切回支持工具的 brain 后才可再次选择感官组。

`generate_image`、`generate_video`、`generate_audio` 是内置 sense，各自声明 `capabilities.produces`（生成类型）与 `accepts`（图生图参考图）。**注入不再受大脑 `capabilities.generate.*` 双门限制**：感官组配置了对应工具即注入；`generate.*` 标记仅作兼容期保留（config 校验仍要求其与 Tool Call 兼容），不再作为注入门。全部按 `smart` 监管级别执行（敏感操作，规则表判定为需确认）。

## 媒体资产与输入理解

上传资产保存在 `.chery/media/`，文件名为 UUID 加原始安全扩展名。允许的 MIME 类型为 PNG/JPEG/WebP/GIF、MP4/WebM/MOV、MP3/WAV/OGG/M4A/WebM；单文件大小由 `media.maxUploadMb` 控制，缺省 100 MiB。

| HTTP 接口 | 认证 | 行为 |
|---|---|---|
| `POST /api/media/upload` | OAuth 会话；本地模式为 `X-Chery-Session-Token` | 原始二进制 body 上传；`Content-Type` 为 MIME，`X-Filename` 为文件名；返回资产 ID、分类、文件名和读取 URL |
| `GET /api/media/:filename` | 同上 | 读取受控本地资产 |

发送弹窗仅允许上传当前临时 brain 的 `input.*` 已开启类型。上传完成后消息正文追加 `[[media:<filename>]]` 引用；该引用是内部协议，不应手工伪造。

`chatMiddleware` 在构造 provider 消息前解析引用：对允许的类别调用媒体网关的 `understand` 操作，把文本分析以“媒体附件理解结果”补充到**本轮内存请求**。持久化的原始用户消息不被改写；服务不可用、资产失效或模型未声明对应输入能力时，向模型显式注入失败/未启用说明，而不是静默忽略。

### 双轨策略（enrichMediaInputs，P5b）

按 brain `capabilities.input` 任一 kind 为 true 即走多模态旁路（旁路内按 kind 过滤）：

| 脑声明 | 行为 | provider 调用 |
|---|---|---|
| `input.*` 任一为 true | 多模态旁路：解析**全历史** `[[media:]]` 标记 → 近 3 轮用户消息的图片全程重发（压缩版，挂回原消息位置）→ 更早图片转一行文字占位；超上限（总数≤10/单轮≤5/字节≤16MB）按「新→旧」保留最新、最旧转占位 → 临时 `attachments` 数组（仅脑支持的 kind，每项带 `messageId` 归属） | openai adapter `buildMessages` 据 `messageId` 把附件只挂到对应消息，产对应 content part：image→`image_url`、video→`video_url`、audio→`input_audio`（均为 data URI base64） |
| `input.*` 全 false 或缺省，且有前置工具 | 前置调度：扫描最后一条 user 消息的 `[[media:]]` 引用 → 按 kind 匹配感官组中 `capabilities.preprocess=true` 且 `accepts` 命中该 kind 的工具 → 执行（输入 `{text, media[]}`，工具内部按 `batchSize` 分批）→ 产出替换进消息；执行失败替换为「[媒体附件处理失败，已跳过]」；未命中 kind 收集进 `<self-capabilities>` 委派建议 | 文本消息（工具产出的理解/转换结果已替换 marker） |
| `input.*` 全 false 或缺省，且无前置工具 | 旧路径：仅最后一条 user 消息，媒体网关 `understand` → 文本理解结果拼到 `last.content` | 文本消息，仅 `[{type:"text",text:"... [媒体附件理解结果]..."}]` |

约束：

- **不持久化**：`attachments` 仅在 chat middleware 调用 provider 时构造，**不**进 `LLMResponse`、**不**进 DB；provider 调用后丢弃。原始 `[[media:...]]` 标记留在 `LLMResponse.content` 不动，跨模型回放可重 enrich。
- **provider 范围**：`src/agent/provider/openaiCompat.ts`（openai-chat-completions，MiniMax 默认）、`anthropic.ts`、`openaiResponses.ts` 均实现多模态并支持按 `messageId` 归属挂图；`mock.ts`/`ollama.ts` 签名对齐接口但忽略 `attachments`（provider 内部注释说明）。
- **入口**：[src/agent/middleware/chat.ts](../../../src/agent/middleware/chat.ts) `enrichMediaInputs`（多模态旁路 `enrichMediaInputsMultimodal` + 旧路径 `enrichMediaInputsLegacy`）；adapter 接口见 [src/core/message/adapter.ts](../../../src/core/message/adapter.ts) `LLMAttachment` / `groupAttachmentsByMessage` / `buildMessages(history, attachments?)`。
- **MiniMax 图片协议**：走 `openaiCompat` 的 `image_url` data URI base64 透传；单图≤10MB、请求≤64MB。image-01 文生图/图生图经媒体网关（`generate_image` sense 支持可选 `reference` 参考图透传，网关侧转 `subject_reference`）。token 预检可调 MiniMax `POST /v1/responses/input_tokens` 或 Anthropic `count_tokens`（见 3.2）。

**图片进上下文的官方形态（调研结论，后续方案直接引用）**：MiniMax-M3 的对话接口中，图片输入**只有「URL 或 base64」两种形态，没有 file_id 方案**——OpenAI 兼容（`image_url` 内容块）与 Anthropic 兼容（`type="image"` 内容块）两套接口均如此（见官方 [OpenAI SDK 文档](https://platform.minimaxi.com/docs/api-reference/text-openai-api) 与 [Anthropic SDK 文档](https://platform.minimaxi.com/docs/api-reference/text-anthropic-api) 的多模态输入段）。`mm_file://{file_id}` 只出现在**视频**的说明里。官方文件上传接口 `POST /v1/files/upload`（[官方文档](https://platform.minimaxi.com/docs/api-reference/file-management-upload)）的 `purpose` 合法值仅 5 个：`voice_clone`、`prompt_audio`、`t2a_async_input`、`video_understanding`（视频理解，`mm_file://` 引用，保留 7 天）、`video_generation_input`（视频生成素材，可含图片 ≤30MB，但只喂视频生成接口，不进对话上下文）。**没有「图片理解」用途，因此图片不存在 file_id 方案**。项目媒体存本地 `.chery/media/`、无公网 URL，故 base64 是本地存储约束下的唯一正确选择；URL 形态要求公网可达地址，与「不引入公网存储」决策冲突。未来接入**视频理解**（单视频 >50MB 无法 base64）时才需引入 Files API + `mm_file://{file_id}` 方案。

## 媒体网关协议

图片、视频、音频分别使用 `media.<kind>` 配置的 URL、模型和密钥。后端以 JSON POST 调用：

```json
{
  "operation": "understand | generate | edit",
  "model": "optional-configured-model",
  "prompt": "generation prompt when applicable",
  "assets": [{ "filename": "...", "mimeType": "...", "data": "base64" }]
}
```

网关至少返回 `{ "text": "..." }`（理解）或 `{ "text": "...", "assets": [{ "mimeType": "...", "data": "base64", "filename": "optional" }] }`（生成/编辑）。生成 sense 将返回资产落回 `.chery/media/`，并把 `/api/media/<filename>` 写入 sense 结果。

## 界面与接口影响

- **AI 大脑设置**：可编辑 Tool Call、三类输入理解、三类生成/编辑能力，并配置三类媒体网关与上传上限。
- **角色设置**：角色没有能力覆写；根据 brain 动态禁用工具/MCP，并在不兼容时清空配置。
- **发送弹窗**：显示 Tool Call 与媒体徽标；临时换模型即时重新约束 sense；提供图片/视频/音频上传入口。
- **`brain.list`**：返回 `capabilities`，供前端展示和运行期选择。
- **配置保存**：Zod schema 与 `validateRawConfig` 同时覆盖能力和媒体配置，保存后按既有规则重启生效。

## 验收要点

1. `toolCall:false` 的角色无法保存 sense/MCP；临时换到该模型后请求不携带 `tools`。
2. 生成 sense 只要感官组配置即注入（不再依赖大脑 `generate.*` 标记）。
3. 上传不支持的 MIME、超出限制的文件或当前模型不支持的类别均被拒绝或提示；感官组工具 `accepts` 命中某媒体类型时该类型可上传（由工具前置处理）。
4. 已启用的媒体输入会先请求网关 `understand`，其返回文本进入该轮模型上下文；若感官组配置了 `preprocess` 工具则优先走前置调度。
5. 媒体服务生成结果可通过受控 `/api/media/:filename` 读取。
