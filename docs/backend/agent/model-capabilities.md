# 模型能力与媒体处理

> 配置 [apps/backend/src/utils/config.ts](../../../apps/backend/src/utils/config.ts) ｜ 运行时 [apps/backend/src/agent/runtimeResolver.ts](../../../apps/backend/src/agent/runtimeResolver.ts) ｜ 文件仓库 [assetStore.ts](../../../apps/backend/src/service/media/assetStore.ts) ｜ 前端 [apps/web/src/features/agent/chat/AgentDialog.vue](../../../apps/web/src/features/agent/chat/AgentDialog.vue)

## 目标

模型原生能力（`llm.brain.<name>.capabilities`）与工具/角色文件操作（`file_services`、`roles.<name>.fileCapabilities`、`presets.<name>.roleOverrides`、`files`）分别声明与组合。大脑能力仅描述所选模型与协议的原生能力；文件生成、图像理解、文档提取等能力可通过原生支持、文件服务工具（`file_services`）或角色委派（`spawn_role`）完成。

```yaml
llm:
  brain:
    vision-agent:
      provider: openai
      protocol: openai-responses
      model: gpt-5.4
      capabilities:
        toolCall: true
        input:
          image: supported
          video: unsupported
          audio: unsupported
          pdf: supported
        output:
          image: supported
          audio: unsupported
          video: unsupported
file_services:
  svc_image_b:
    name: 图片生成服务
    enabled: true
    adapter: minimax-images
    connection:
      baseUrl: https://api.minimax.cn
      model: image-01
      keyRef: $IMAGE_API_KEY
    operations: [image.generate, image.reference]
    defaults:
      n: 1
      aspect_ratio: '1:1'
    timeoutMs: 600000
    queueTimeoutMs: 600000
    maxConcurrent: 2
roles:
  coordinator:
    id: role-coordinator01
    brain: vision-agent
    senseGroup: leader
    fileCapabilities:
      image.generate:
        mode: role
        targetId: role-illustrator01
```

## Brain 能力契约

QQ 历史图片沿已选背景窗口进入有序资产部分。统一文件能力解析器复用本次 `RuntimeConfig.configSnapshot`、实际运行选择、角色派发名单与临时角色覆盖；`IngressRequestView.fileCapabilities` 向插件提供解析结果，不新增预设 `hasVision`。明确不支持与协议不支持为 unavailable，未知保持 unknown。注册工具不等于本请求可调用：请求身份过滤后的工具表还要约束解析，真正执行继续检查参数、角色策略、审批和 PreToolUse。主模型仅在 available/native 时接收原生图片；role/tool 保留固定版本与关系供模型按需调用，不自动派发。历史 `inputOrigin: history` 使用第一次采用轮数，不因新消息重复带入而刷新；`quote` 只在当前明确引用轮刷新。轮数及来源按会话和所有者持久保存，工具循环不推进。

### 图片格式与每图硬上限

`capabilities.imageInput` 与 `input.image` 配合使用：`formats` 为模型实际接受的 MIME 列表（JPEG/PNG/WebP/GIF），`animation` 为 `supported / first-frame / unsupported / unknown`，可独立声明服务的 `maxBytes`（原始字节）和 `maxBase64Bytes`（编码后字节）。各字段按用户覆盖、模型目录、未知的顺序解析。协议格式表仅说明传输能力，不能充当模型支持证明；未知模型必须配置格式列表，空列表表示不接受图片。Web 模型设置及 Manager 设置模块均可编辑。

`files.imageAdaptation.maxBytes` 默认 **5 MB = 5,000,000 字节**，是每张模型输入的最大值，不是每图目标大小，也不改变上传上限或其他文件策略。`imageAdaptation.quality` 是转换或压缩时的 **JPEG/WebP 编码质量上限**（默认 85，保留用户显式值），不是原图视觉质量的估计或保证；不同格式的相同质量值不代表视觉效果相同。PNG 使用无损压缩，没有对应的有损 quality 参数。通过真实格式、完整解码、模型格式与动画支持、最长边和服务额外限制检查的原图直接复用原字节，不生成新版本；只有需要转换、缩小或压缩时才编码。编码先使用质量上限，仍超限时进一步降低编码质量或等比缩小；不读取原图质量估计，不按像素预算或小图曲线降低质量，不统一重编码合规原图，也不放大或补足体积。

运行输入先通过 `service/media/prepareImage.ts` 验证、适配，再按处理后的字节做本次会话去重与总附件预算检查。解码可用但格式不在模型列表时，自动选择列表内可编码格式，保留透明通道。超过硬上限时在有限次数内调整编码和等比缩小，实际 buffer 达标才可使用或保存派生版本；失败不会回退超限原件。原件、发送者、权限与固定引用保持不变；压缩与缩小可能损失细节。每图服务限制、Base64 限制、整次附件预算分别检查。

动画不自动取首帧或丢帧；服务仅首帧、明确不支持或未知时不携带，附原因并保留原件。完整动画支持需明确声明，重新编码后检查帧数、延时和循环次数；当前不能保证 APNG 保留动画，拒绝转换。MiniMax 文档列出的 GIF 格式不等于保证理解完整动画。

格式来源：[OpenAI](https://developers.openai.com/api/docs/guides/images-vision)（JPEG/PNG/WebP/非动画 GIF）、[Claude](https://platform.claude.com/docs/en/build-with-claude/vision)（JPEG/PNG/GIF/WebP，动画只首帧，大小需区分 Base64 和原始字节）、[MiniMax](https://platform.minimax.io/docs/api-reference/text-openai-api)（M3 图片格式和 10 MB；动画语义未说明）。这些说明不是任意兼容地址的实测结论，未知型号不从协议或名称臆测限制。

Web 的“文件与上下文 → 图片适配”和 Manager 设置模块的“图片输入设置”共用后端 `files`。Manager 经受保护的设置管理路由读取、校验、预览、按 revision 保存并回读，不维护第二份配置。

`BrainCapabilities`（[packages/plugin-api/src/config.ts](../../../packages/plugin-api/src/config.ts)）：

| 字段 | 缺省 | 含义 |
|---|---:|---|
| `toolCall` | `true` | 是否可向模型传递 function/tool schema、接收并执行 sense call |
| `input.image/audio/video/pdf` | 省略继承目录推荐，未知回退 `unknown`（兼容读取布尔值：`true`→`supported`，`false`→`unsupported`） | 模型协议原生可接收的输入文件类型 |
| `output.image/audio/video` | 省略继承目录推荐，未知回退 `unknown`（兼容读取布尔值） | 模型响应原生可直接输出的媒体类型（不代表能否调用外部工具） |

- **三态与继承**：媒体能力项取值 `'supported' | 'unsupported' | 'unknown'`。配置省略某项表示继承模型目录推荐（`source: 'catalog'`），显式填写 `'unknown'` 表示未确认，显式填写 `'supported' | 'unsupported'` 表示用户覆盖（`source: 'user'`）。协议适配器不支持的类别在最终解析中被限制（`source: 'adapter'`）。
- **原生媒体能力与服务端内置工具分离**：模型目录按模型与协议分别记录原生媒体能力（`input` / `output`）和服务端内置工具能力（`serverTools.webSearch`、`serverTools.webReader`、`serverTools.imageInspect`）。例如 GLM-5.3 原生为纯文本模型（`input.image: false`），在 `anthropic-messages` 协议下可通过服务端工具 `analyze_image` 辅助看图，不能因此将所有 GLM-5.3 配置标为原生视觉模型；切回 `openai-chat-completions` 或 `openai-responses` 时不会沿用另一协议的成功结论。
- **移除 `generate`**：旧 `capabilities.generate` 已移除，不再将“可调用外部生图工具”混同为大脑原生输出能力。关闭 `toolCall` 不会清除模型原生 `input` / `output` 声明。

### 当前连接的能力来源

`utils.modelRecommendation` 可携带 `connection`（当前草稿的地址、密钥引用及完整地址开关），返回 `serviceCapabilities`；`config_manage.get` 使用同一查询生成各大脑的能力说明。查询只读，不测试连接、不请求模型、不发现 MCP 工具。

原生媒体及服务端能力的目录值保留来源，不代表当前连接已经验证。`knownTools` 分开记录目录说明和当前连接响应中观察到的真实名称；`catalogComplete=false` 表示完整列表未知，不把 MCP 列表混入模型服务目录。目录可以通过 `capabilities.serverToolDefinitions` 提供名称、说明和文档链接；不从调用参数猜输入结构。

观察按服务、有效协议、地址、完整地址开关、请求模型、凭据引用及解析后的凭据隔离。更换任一项后不借用其他连接的记录；密钥轮换也不沿用旧记录。数据库只保存连接摘要和工具名称、最近状态及时间，不保存密钥、参数、图片、正文或结果。记录失败不改变模型执行结果，但读取失败必须显示为记录不可用，不能当作空目录。

`verification.status=not-verified` 表示尚无当前配置完整任务验证；已观察到工具、工具 `completed`、普通连接成功和离线测试均不会将其改成验证通过。真实任务验证与 GLM 服务端图片输入开放仍须按[当前任务](../../plan/file-capabilities-and-model-collaboration/README.md)的授权和条件完成。

## 文件服务与适配器契约（`file_services`）

多图响应按原顺序保留已取得的文字和文件。单项被服务商拒绝、内容无效或后续下载失败时，整批不能标为完整成功；已有文件照常保存和交付。下载未完成而原响应仍在本地时，“重试保存”只重新解析原响应并下载缺失结果，不调用生成接口。已保存的前序文件沿用固定版本；服务商拒绝的单项不能通过保存重试变成新一轮生成。

`file_services.<serviceId>` 将连接、认证与可执行的文件操作组合成可配置资源，开启的操作生成稳定工具名 `file_<serviceId>_<operation_with_underscores>`（仅含字母、数字、下划线），通过 `sense_groups` 授权给角色。

支持的操作 ID（`FileCapabilityOperation`）：
- `image.inspect`：回答关于选定图像的问题（输出带来源文字观察）
- `image.generate`：根据文字生成图像（输出一个或多个图像资产）
- `image.reference`：根据文字和参考图生成新图（输出新图像资产）
- `image.edit`：按接口支持的编辑方式修改图像（输出新图像资产）
- `document.extract`：提取文档文字或结构
- `audio.transcribe` / `video.inspect`：转写音频或理解视频

已登记适配器（`FileServiceAdapterId`）与官方协议依据：
- `vision-brain`：复用已有 `llm.brain.<name>`（`connection.brainRef`）执行独立 `image.inspect`，不替换主角色 brain，也不开启工具/委派循环。此服务只接收图片；会话模型原生 PDF 输入由文件输入处理单独判断。
- `minimax-images`：MiniMax 图像 API（`POST /v1/image_generation`，代表型号 `image-01`、`image-01-live`），支持 `image.generate`、`image.reference`；校验 `base_resp.status_code`，尺寸支持 `aspect_ratio` 或 `width`/`height`（512–2048 且为 8 的倍数）二选一，`image-01-live` 支持 `style`，响应优先 base64 或立即下载保存。
- `openai-images`：OpenAI Images 兼容 API（`/v1/images/generations`、`/v1/images/edits`，代表型号 `gpt-image-1`、`gpt-image-1-mini`、`gpt-image-1.5`），支持 `image.generate`、`image.reference`、`image.edit`；参数含 `size`、`quality`、`background`、`output_format`、`output_compression`、`moderation`、`input_fidelity` 及可选 `mask`。
- `openai-responses-image`：OpenAI Responses API 内置 `image_generation` 工具，解析 `image_generation_call` 输出项与多轮续接上下文。
- `google-gemini-image`：Google Gemini 原生图像生成与编辑（`models/{model}:generateContent`，代表型号 `gemini-2.5-flash-image`、`gemini-3-pro-image`、`gemini-3.1-flash-image`、`gemini-3.1-flash-lite-image`），配置 `responseModalities` 与 `imageConfig`（`aspectRatio`、`imageSize`），按序解析返回的文本与 `inlineData` 图像 part。
- `google-imagen`：Google Imagen 专用文生图接口（`models/{model}:predict`，代表型号 `imagen-4.0-generate-001`、`imagen-4.0-fast-generate-001`、`imagen-4.0-ultra-generate-001`），参数含 `sampleCount`、`aspectRatio`、`personGeneration`、`outputOptions`。
- `doubao-seedream`：火山方舟豆包 Seedream 图像生成接口（`POST /api/v3/images/generations`，代表型号 `doubao-seedream-5-0-pro-260628`、`doubao-seedream-5-0-flash-260915`），支持文生图、单/多参考图与组图生成（`size`、`response_format`、`output_format`、`watermark`、`sequential_image_generation`）。
- `custom-sense-mcp`：现有自定义工具或 MCP 工具的结构化映射（`SenseFileOperationMapping`），声明输入资产/问题字段、传输方式（`base64` / `data-url` / `local-path` / `asset-id`）与输出提取路径。

## 角色文件能力关联与 Tool Call 降级

`roles.<name>.fileCapabilities` 与 `presets.<name>.roleOverrides.<roleName>.fileCapabilities` 定义各操作的处理方式：
- `mode`: `'auto' | 'native' | 'tool' | 'role' | 'disabled'`（缺省 `'auto'`；`'tool'` / `'role'` 必填稳定 `targetId`；`'disabled'` 禁止该角色通过原生、工具或委派执行该操作）。
- 优先级：本次调用显式指定 → 当前预设成员覆盖 → 角色默认配置 → `auto`（理解优先 `native`，否则唯一可用对象）。

无 Tool Call（`capabilities.toolCall === false`）的角色约束：
- 模型请求完全不注入 `tools`，且禁止配置 `mcpServers`。
- 允许保留 `senseGroup` 仅用于系统前置理解：当且仅当该角色显式将 `image.inspect`、`document.extract`、`audio.transcribe` 或 `video.inspect` 绑定为 `mode: 'tool'` 且目标工具属于其 `senseGroup` 时，运行层可在输入预处理阶段代为执行该工具；`auto` 不会为无工具模型自动调用外部工具，生成、编辑和委派也不会因保留 `senseGroup` 而开放。

## 全局文件与上下文策略（`files`）

`files` 配置维护上传、上下文携带、图片适配与未引用清理默认值（[packages/plugin-api/src/config.ts](../../../packages/plugin-api/src/config.ts) `FilesConfig`）：
- `maxUploadBytes`：默认 100 MiB
- `context.recentUserTurns`：其他文件默认 3（非负整数，0 表示仅携带当前显式内容引用）；图片独立使用 `imageContext`，不叠加此轮数。
- `imageContext.mode`：`current / recent / unlimited`，默认 `recent`；`recentUserTurns` 默认 1，含首次采用图片的用户轮。合并 QQ 消息算一个用户轮，工具循环不推进；下一次用户输入被采用后改为既有描述或无描述占位，明确引用或重读可恢复。仅当前轮和不按轮过滤仍受请求预算限制。
- `imageContext.replacement`：`description / keywords`，默认描述与关键词；`missingDescription`：`existing / inspect`，默认仅复用已有信息。自动补描述必须选择启用的图片理解 `serviceId`，且通过本角色工具授权；仅保存设置不发起调用。
- 图片在当前有效会话候选内先按 SHA 精确去重，再用感知哈希与颜色/细节差异检查静态图高相似；仅与稳定代表比较，不沿相似链扩展。优先像素较大的版本，再以固定 ID 排序，预算在分组后计算；所有原发言、位置和资产关联保留。GIF 与多帧图仅精确去重，解码失败回到普通文件处理。相似识别最多处理 64 个候选、单图 2400 万像素及 16 MiB、并发解码最多 2；没有全局图片候选或跨会话缓存。相似判断可能误合并细小文字变化，不能当作逐像素相同或转移视觉证据。入口为 `service/fileServices/imageSimilarity.ts`，验证为 `test/service/imageSimilarity.test.ts`。
- `imageContext.maxDescriptionChars / maxTotalDescriptionChars`：默认 600 / 6000，单图与单次请求描述字符上限；分别允许 100–4000 / 100–40000，总上限不能小于单图上限。图片的基本标识单独受整体请求大小限制。
- 自动补描述单次请求准备最多补一张，仅处理已到期用户内容图片；固定版本、服务配置及描述规则相同时不自动重试。失败或未知结果不阻断普通对话，可在图片说明详情查询状态；明确重新读图继续按权限执行。
- 图片计数和读取记录由 `service/fileServices/imageContext.ts` 保存；准备和草稿不提交计数，provider 正式请求开始时采用。已采用的用户轮后来隐藏或撤回不让其他图片变年轻，来源撤回则不再复用其图片或描述。
- `file_images_find` 查询本会话描述，`file_assets_list` 查询有权访问的版本；`file_image_read` 明确安排固定版本重新读取。仅工具成功文字不代表已看图，接下来仍须通过 `planFileInputs` 实际纳入原生附件或真实理解观察。每次请求（含请求内工具循环）根据实际准备结果更新文件提示，区分已附原图、工具文字观察和未携图；“本次请求”指整组消息，不只指最新用户消息，保留在历史消息原位置的实际图片仍属于本次输入，旧回答不能覆盖当前文件状态。准备状态不是要求用户再发一轮的理由，也不表示模型一定完成了视觉理解。压缩不清除持久记录，也不把全部描述自动塞回上下文。
- 图片说明查询为 `POST /api/assets/image-descriptions`（会话及固定版本列表），不读取图片内容、不调用模型。最近文件请求仅保存一条，按请求 ID 更新准备/发送/完成/未知结果状态；查询再次检查文件及描述来源权限。
- `context.maxAssets`：默认 10（单次请求不同资产版本上限）
- `context.maxBinaryBytes`：默认 16 MiB
- `context.maxExtractedCharsPerAsset` / `context.maxExtractedChars`：默认 20000 / 80000
- `context.defaultImageVariant`：默认 `'adapted'`
- `imageAdaptation.maxEdge` / `imageAdaptation.quality`：默认 2048 / 85（保持透明度与 GIF 动画，不放大小图）
- `unreferencedUploadRetentionHours` / `unreferencedAssetRetentionHours`：默认 24 小时

## 资产、有序消息 Parts 与当前实现状态

生成工具的 `requireInspection:true` 把本次操作标为待检查，不自动发起额外模型请求。调用理解工具读取本次全部输出的固定版本后，使用 `file_operation` 的 `record-inspection` 提交检查操作 ID、是否符合要求及结论。服务核对同会话、同所有者、全部版本及理解操作状态；生成、保存与检查仍独立。缺少检查或检查未通过的必需成果不能把角色任务标为完整成功。此处记录调用者的检查结论，不代表系统自行证明视觉质量。

文件输入由 `planFileInputs` 按固定资产版本生成本次请求，持久历史不被改写；正文不再承担媒体标记解析。前置理解记录按用户问题、文件版本、处理对象、权限与截至最新真实用户输入的上下文复用。同一问题中的工具循环不因追加工具消息而重复理解；新的用户问题重新计算，不能用旧观察冒充对新细节的读取。

1. **有序消息 `parts`**：消息协议与 `LLMResponse` 支持有序 `parts`（`text`、`asset`、`directive`、`role_mention`、`workspace_ref`），其中 `asset` part 携带 `assetId`、`assetVersionId`、`variant ('original' | 'adapted')` 与 `usage ('content' | 'reference-only')`。`content` 字符串作为文本边界的派生投影保留。
2. **输入理解与多轮保留**：图片按独立策略，其他文件按 `context.recentUserTurns` 进入模型上下文（上限 10 个不同资产版本、累计二进制 ≤ 16 MiB）；到期不删除原件或持久消息。描述必须标来源和固定版本，无视觉观察时明确暂无视觉描述，不能用生成提示词冒充成图内容。`usage='reference-only'` 只保存展示，不触发自动读取或补描述。图片上下文补充实现和验收状态见[当前任务](../../plan/file-capabilities-and-model-collaboration/README.md)。
3. **MiniMax 对话图片输入形态**：MiniMax 对话接口仅支持 `image_url`（base64 data URI 或 URL），不支持对话图片 `file_id`；本地资产统一经 base64 注入模型请求。
