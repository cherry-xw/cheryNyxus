# 配置、接口与执行细节

**文档创建时间：** 2026-10-15T15:26:44+08:00

**用途：** 用户已确认的实施设计，规划结束、进入开发；不表示当前运行版本已实现。本文拥有字段含义、处理顺序、失败与迁移规则。功能编号见[功能清单](functional-spec.md)，交互见[UX](frontend-ux.md)，开发完成条件见[集中决策](design-decisions.md)。

## 对象含义

| 对象 | 职责 |
| --- | --- |
| 模型 | 执行理解、生成或对话的具体型号；名字不能证明接口支持 |
| 连接 | 保存地址、认证引用及模型/接入点，已有连接可复用 |
| 接口适配器 | 定义请求格式、认证方式、参数、响应解析、查询与取消能力 |
| 文件服务 | 将连接与可执行的文件操作组合成可配置资源 |
| 工具 | 模型或系统实际调用文件服务的入口；工具组管理分配与权限 |
| 角色 | 使用对话模型和已授权工具，负责规划、执行和任务分工 |
| 厂商预设 | 提供连接/适配器的推荐值，不额外决定协议或能力 |

## 1. 当前证据与改动理由

| 当前入口 | 已核对事实 | 实施要求 |
| --- | --- | --- |
| [config.ts](../../../packages/plugin-api/src/config.ts#L52) `BrainCapabilities`；[brainFormHelpers.ts](../../../apps/web/src/features/agent/settings/tabs/brain/brainFormHelpers.ts#L35) | 输入与 generate 布尔值混用，关闭工具调用清空 generate | 拆开模型原生输出与工具可完成的操作；删除失效开关及其消费者 |
| [operations.ts](../../../apps/backend/src/service/config/operations.ts#L9) 与 [settings.ts](../../../packages/protocol/src/settings.ts#L14) | AI 和设置分别声明能力字段 | 共享字段 schema 和核心校验，补齐所有配置读写入口 |
| [mediaEnrichment.ts](../../../apps/backend/src/agent/middleware/mediaEnrichment.ts#L87) `enrichMediaInputs` | 任意原生能力开启即整轮进入原生分支；前置工具直接 execute | 逐文件计划，经统一执行与记录；处理失败不丢资产 |
| [assetStore.ts](../../../apps/backend/src/service/media/assetStore.ts) `AssetStore` | 统一资产及固定版本读写，文件头元信息与所有者授权独立保存 | 核对全部调用方与引用释放 |
| [adapter.ts](../../../apps/backend/src/core/message/adapter.ts#L58) `LLMResponse` | 正文是 string，临时附件不进入持久消息 | 持久 parts + 临时请求计划；文字投影为派生值，不双写两份内容 |
| [loop.ts](../../../apps/backend/src/agent/middleware/loop.ts#L197)；[wake.ts](../../../apps/backend/src/service/chat/wake.ts#L58) | child_done 与父回复主要只携带末条文字 | 输出资产登记与任务结果一起持久化、回写 |
| [spawnEager.ts](../../../apps/backend/src/service/chat/spawnEager.ts#L70) | 缺父连接时跳过后台启动 | 任务执行身份与 WebSocket 投递目标分开 |

## 2. 配置结构

### C01 模型能力

`llm.brain.<name>.capabilities` 只声明所选模型/接口的原生能力：`toolCall`、`input`、`output`。媒体项采用 `supported / unsupported / unknown` 三态；`input` 区分 `image / audio / video / pdf`，普通文本是对话模型基础要求。`output` 描述原生返回的文件类别，不表示可以调用某工具。旧 `generate` 一次性移除，不能直接映射成原生 output。

模型目录事实与用户配置分别保存，解析结果包括 `source: catalog/user/adapter`、依据及限制。省略能力项表示继承推荐，显式 unknown 表示未确认；读取不能把继承结果写成用户覆盖。toolCall 使用已实现工具协议的能力规则。用户明确覆盖推荐时保留覆盖来源；接口适配器未实现的类别仍不可执行。关闭工具调用不清除原生输入/输出能力。未知配置可保存但不能当作原生文件可读。

允许手填目录之外的模型 ID，使用已实现协议和适配器定义的参数；界面标为手动声明/未验证。新型号不要求重做文件和角色协议，新协议必须开发适配。目录随版本更新，不静默覆盖用户配置或把用户口述简称当作 API ID。

功能点：F01。交互：大脑页能力行。开发：目录推荐、API 返回、运行解析和临时切换共用解析器。易错：未知被布尔 false 永久盖掉，或手工 true 绕过协议支持判断。

### C02 文件服务

新增 `file_services` 资源，以稳定服务 ID 为键，用户可改显示名。服务可用性、上次试用、错误和生成工具列表是运行查询结果，不写回配置。

| 字段 | 类型 / 缺省 | 配置与交互约束 |
| --- | --- | --- |
| `name` | 非空字符串，必填 | 可重名显示但列表补充模型区分；ID 不随名称变化 |
| `enabled` | boolean，默认 true | 关闭后停止新增调用；排队未执行操作启动前重查；已启动操作沿原版本完成或由用户停止 |
| `adapter` | 已注册适配器 ID，必填 | 决定输入表单、操作和参数定义，未知 ID 保存失败 |
| `connection` | 类型化对象，必填 | 引用已有连接/大脑配置键，或独立填写地址、model/接入点、适配器定义的认证引用；引用与独立配置互斥 |
| `operations` | 已实现操作的子集，必填 | 不能填适配器未实现操作；关闭一个操作保留其他操作 |
| `defaults` | 适配器对应的类型化参数 | 图片数量、尺寸/比例、质量、格式等；未知参数报错，不静默透传 |
| `timeoutMs` | 正整数，默认 600000 | 单次外部操作总时限；UI 用分钟，传输/持久化用毫秒 |
| `queueTimeoutMs` | 正整数，默认 600000 | 排队最长等待；与开始执行后的 timeoutMs 分开，超时未调用远端 |
| `maxConcurrent` | 正整数，默认 2 | 服务级并发，排队等待单独可见，不把排队当远端生成 |

密钥引用使用现有 `$ENV` 机制，认证由适配器提供类型化配置，本地服务可明确无需认证，不接受任意请求脚本。地址支持基础地址模式及高级完整端点覆盖；覆盖按操作配置，明确不再拼接路径。界面展示实际端点，不能只因有 `/models` 就声明图片接口存在。adapter 是协议的唯一配置来源，厂商只是预设；界面的协议选择映射 adapter，不另存可冲突的 protocol 值。

每个开启的操作产生稳定、可查询的工具标识；界面展示“服务名 · 操作”，不要求用户抄内部工具名。工具名使用仅含字母、数字、下划线的稳定编码，避免 operation ID 的点号不被模型工具协议接受。服务工具通过现有工具组分配权限；角色绑定某服务不会绕过工具组。服务删除前列出工具组、角色、技能依赖影响，须在同次保存修正必需引用或取消删除。引用大脑仍使用现有配置键；大脑改名事务同步更新 brainRef，不为本任务额外重做全部大脑身份体系。

已开始操作固定配置快照；排队操作执行前重查权限和启用状态。删除服务不删除任务查询所需的非敏感连接和参数快照；凭据撤销后不得继续借旧引用调用。已有连接可复用，但服务的操作与默认参数独立，不能修改聊天模型的运行选择。

功能点：F02—F04。交互与删除方式见 UX-S02/S03。开发：接入配置候选、采用与脱敏；服务资源与工具注册原子切换。易错：服务保存了但工具没注册、名称冲突、切配置打断在途操作、回读密钥变空覆盖旧值。

### C03 操作与适配器范围

| 操作 ID | 含义 | 参数关键点 | 结果 |
| --- | --- | --- | --- |
| `image.inspect` | 回答关于选定图像的问题 | `assetIds`、`question`、可选范围 | 有来源的文字记录，不自动生成图 |
| `image.generate` | 根据文字生成图像 | `prompt`、输出参数 | 一个或多个输出资产 |
| `image.reference` | 根据文字和参考图生成新图 | `prompt`、`referenceAssetIds`、参考用途 | 新资产；不承诺原图局部保持 |
| `image.edit` | 按接口支持的编辑方式修改图像 | `prompt`、输入图、可选蒙版（仅适配器支持时） | 新资产；不覆盖源图 |
| `document.extract` | 提取文档文字或结构 | 资产、页/工作表范围（如工具支持） | 有范围及截断说明的文本/结构记录 |
| `audio.transcribe` / `video.inspect` | 已接入工具的转写/理解 | 对应资产与问题 | 有来源的文字记录 |

本次交付必须实现下表的官方接口接入及已支持协议的自定义地址。每条接口以官方可用的代表型号验证，型号目录允许扩展，不要求穷举历史型号。准确参数由开发核实；缺少资料或实测账号时记录对应适配/验证阻塞，不能把厂商静默移出范围。此表是已确认交付要求，不表示已经实现或实测。

| 适配对象 | 支持范围 | 特有约束与错误点 |
| --- | --- | --- |
| 视觉模型服务，引用已有 brain | `image.inspect`；PDF 仅对应模型与协议共同支持时 | 调用独立请求并返回文字，不替换 A 的 brain；不启用该模型的工具/委派循环 |
| MiniMax 图像 API | `image.generate`、`image.reference` | 人物参考不标成通用编辑；JSON `POST /v1/image_generation`；检查 `base_resp.status_code` 而非只看 HTTP 状态 |
| OpenAI Images 兼容 API | `image.generate`、实际模型支持的 `image.reference/image.edit` | 生成与编辑分别使用对应端点和内容格式；按模型目录限制参数；不假定所有兼容站均支持 |
| OpenAI Responses 图片工具 | 实际模型支持的图片生成/编辑、连续修改 | 属于本次交付，单独解析工具事件、输出与续接信息；不等同所有对话模型原生具备图片输出 |
| Google Gemini 图像模型 / Imagen | 按具体模型核实生成、参考输入、编辑及文字与图片混合输出 | 分别核对对话式多模态接口与专用生成接口；有序返回文字和图片，不能统一假设为 OpenAI Images 协议；准确模型 ID 和限制待官方核实 |
| 豆包 / Seedream（火山方舟） | 按具体模型核实文生图、参考图、编辑及多图输出 | 按官方模型/接入点、鉴权和协议配置；组图、流式或异步结果只在接口明确支持时启用；准确型号及参数待官方核实 |
| 现有自定义工具 / MCP | 按准确声明启用上述操作 | 提供结构化映射编辑与校验，定义输入资产/问题、常量字段、传输类型、结果路径；仅声明 accepts 不自动执行；远程 MCP 不直接读后端本地路径 |

#### 通用规则与厂商差异

- 通用层只定义操作意图、文件引用、有序结果、任务状态、配置保存和角色分工，不固定厂商参数名、模型名单、图片数量或尺寸枚举。
- 协议适配器负责真实端点、鉴权、参数、同步/流式/异步响应、远端状态查询与取消；模型目录负责该型号支持的操作和限制。新型号沿已支持协议接入时更新目录，不改 A/B 协作和文件协议。
- 专用生图 API 与对话式图像输出都必须接入统一结果：文本和图片按顺序保存；一条响应可有多张图，也可只有文字解释失败。不能只提取首图或把有文字的响应一律判作生成成功。
- 一个厂商不等于一个适配器，一个模型名称也不能证明协议兼容。兼容站须分别核实生成、编辑、参考图和输出格式，不能只验证聊天接口。
- UI 从适配器和模型目录取得可选参数、单位、默认值、互斥条件与限制；AI 配置使用同一字段定义。禁止把 MiniMax 的数量、比例或参数直接复制给 Gemini、GPT Image 或 Seedream。
- 每个目标服务都须补齐：准确模型 ID、官方依据、输入方式、输出方式、操作范围、尺寸/数量/字节限制、响应模式、错误判断、结果保存与重试行为。未核实项明确标记，不把用户口述型号直接写成可调用 ID。

以下 MiniMax 参数是厂商专属样例，只由相应适配器使用，不是通用产品限制。

MiniMax 参数依据 2026-10-15 读取的[官方文生图](https://platform.minimaxi.com/docs/api-reference/image-generation-t2i.md)和[官方图生图](https://platform.minimaxi.com/docs/api-reference/image-generation-i2i.md)：

- 模型 `image-01 / image-01-live`；prompt 最多 1500 字符；数量 1–9，缺省 1。
- 比例和指定宽高二选一；`image-01` 指定宽高均为 512–2048 且为 8 的倍数；`21:9` 仅该模型支持。界面不同时填写两组。
- 人物参考只接受 JPG/JPEG/PNG、小于 10 MB；本设计首次限定一张人物参考，作为产品适配范围而非宣称厂商仅支持一张。
- `image-01-live` 可配官方 style 类型与权重；其他模型隐藏且不发送 style。
- `response_format` 由适配器优先取 base64；使用 URL 时立即下载保存，官方 URL 有效期 24 小时，不能成为历史唯一文件。
- seed 可选；`prompt_optimizer` 默认 false；水印参数按官方规则传递，不增加自定义政策。

OpenAI Images 与 Responses 图片工具依据官方规范与 OpenAI SDK 定义：
- Images API（`/v1/images/generations`、`/v1/images/edits`）：代表模型 `gpt-image-1`、`gpt-image-1-mini`、`gpt-image-1.5`（兼容目录扩展 `gpt-image-2`、`gpt-image-2.5-sunburst`、`gpt-image-2.5-flare`）；参数包含 `size`（`1024x1024`、`1536x1024`、`1024x1536`、`auto`）、`quality`（`low`、`medium`、`high`、`auto`）、`background`（`transparent`、`opaque`、`auto`）、`output_format`（`png`、`jpeg`、`webp`）、`output_compression`（0–100，仅 `jpeg`/`webp`）、`moderation`（`low`、`auto`）、`n`（1–10）；编辑支持多输入图、`input_fidelity`（`low`、`high`）及可选同尺寸带 alpha 通道 `mask`；GPT Image 家族固定返回 `b64_json`。
- Responses 图片工具（`type: "image_generation"`）：在 `openai-responses` 流/响应中解析 `image_generation_call` 输出项，支持 `partial_images`（0–3）流式预览与最终资产分离，并纳入统一资产结果约定。

Google Gemini 原生图像与 Imagen 依据 Google AI 官方规范与 `@google/genai` SDK 定义：
- Gemini 原生图像（`models/{model}:generateContent`）：代表模型 `gemini-2.5-flash-image`、`gemini-3-pro-image`、`gemini-3.1-flash-image`、`gemini-3.1-flash-lite-image`；请求配置 `responseModalities: ["TEXT", "IMAGE"]` 与 `imageConfig`（`aspectRatio`: `1:1`/`3:4`/`4:3`/`9:16`/`16:9`/`21:9`；`imageSize`: `1K`/`2K`/`4K`）；响应按序解析 `candidates[0].content.parts[]` 中的 `text` 与 `inlineData`（`mimeType` + base64 `data`）及多轮编辑 `thoughtSignature`。
- Imagen 专用文生图（`models/{model}:predict`）：代表模型 `imagen-4.0-generate-001`、`imagen-4.0-fast-generate-001`、`imagen-4.0-ultra-generate-001`；参数包含 `sampleCount`（1–4）、`aspectRatio`（`1:1`/`3:4`/`4:3`/`9:16`/`16:9`）、`personGeneration`（`dont_allow`/`allow_adult`/`allow_all`）、`outputOptions.mimeType`（`image/png`、`image/jpeg`）。

火山方舟豆包 Seedream 依据 Volcengine Ark 官方图像生成 API（`POST /api/v3/images/generations`）：
- 代表模型 `doubao-seedream-5-0-pro-260628`、`doubao-seedream-5-0-flash-260915`（或用户方舟接入点 `ep-*`）；支持文生图、单图/多图参考编辑（`image` 为 string 或 string[]，支持 base64 data URI）与组图生成（`sequential_image_generation`: `'auto' | 'disabled'`，`sequential_image_generation_options.max_images`: 1–15）；参数含 `size`（`1K`/`2K`/`4K` 或像素宽高如 `2048x2048`）、`response_format`（`b64_json` 优先，或 `url` 立即下载落盘）、`output_format`（`png`/`jpeg`）、`watermark`（boolean）、`seed`。

自定义工具/MCP 的资产传输只能采用实际支持的字节、供应商上传引用或已有受控传输方式。远程工具若只接受公网URL而部署没有该能力，显示不可用，不自动架设公网文件服务。厂商支持流式预览时预览与最终资产分开；无图片的纯文字响应不能将生图操作标成功。

### C04 角色关联

`roles.<name>.fileCapabilities` 是操作 ID 到处理规则的可选映射：

| 字段 | 值 | 意义 |
| --- | --- | --- |
| `mode` | `auto / native / tool / role / disabled` | 缺省 auto；disabled 禁止该角色通过原生/工具/委派执行该已识别操作 |
| `targetId` | 稳定工具/角色 ID | tool/role 必填；native/auto/disabled 禁止填写 |
| `fallback` | 默认 `none` | 本次不建立隐式付费切换链；错误原样返回，模型可依据用户任务重新规划 |

优先级为本次明确指定→当前预设成员覆盖→角色默认→自动选择，始终先校验权限和 disabled。自动理解优先支持的原生方式，否则选唯一合格对象；有多个候选时有工具能力的 A 可明确选择已授权工具，只有必须在 A 请求前解决的歧义才向用户询问。不按注册顺序选，不自动失败切换付费服务。生成操作不会因为模型原生理解图片就选 native。

能力查询至少返回 `operation`、`availability`、`source`、`targetId`、`inputConstraints`、`outputKinds`、`reasonCode`、`reason`、`configRevision`。availability 分 `available / requires_approval / selection_required / unavailable / unknown`；“可用”表示配置与当前连接满足调用条件，不保证远端本次一定成功。试用结果独立返回，避免上次成功永久掩盖服务离线。

委派计算以当前预设、角色权限、运行版本为上下文；同一个公共角色在不同预设的可委派能力可以不同。预设成员可覆盖首选对象，按现有成员配置结构保存；角色默认不可用于某预设时显示缺项，不要求默认适用于所有预设。当前预设的显式无效引用在保存时拒绝。没有工具调用能力的角色不能自主 spawn；配置好的系统前置处理由运行层执行且记录执行主体。

配置检查针对同一操作的自动委派循环；运行时使用任务、操作、输入身份与已有层级/循环限制。不同操作的合法互助不得仅因角色存在双向关联就被拒绝。

无工具调用模型的具体变化：允许角色保留用于系统前置理解的工具组，模型请求仍完全不注入 tools。只有显式绑定为 tool 的 `image.inspect/document.extract/audio.transcribe/video.inspect` 可在输入处理时由系统调用，且目标确实在该工具组、经过同一权限检查；auto 不替它自动选择付费前置工具。生成、编辑、委派不因保留工具组就对该模型可用。必须一起替换当前“无工具模型必须清空工具组”的配置和 UI 规则，不能只放宽某一处校验。

### 配置关系示例与自动配置操作

“A 委派 B 生成”的通用关系为：A配置可派发B，B的工具组拥有某文件服务的生成工具，B将图片生成首选绑定该工具；A只绑定B，不复制B的服务凭据。A直接生图时则拥有服务工具并直接绑定，无需新增绘图角色。

下面是该关系的 **MiniMax 专属字段样例**，不是通用服务字段全集。资源名称和 ID 为示例，不能直接用于当前运行版本；已有配置其他必要字段省略。工具名由后端目录返回，不要求用户编造。

```yaml
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
      prompt_optimizer: false
    timeoutMs: 600000
    maxConcurrent: 2
roles:
  coordinator:
    id: role-coordinator_01
    brain: model_a
    senseGroup: coordination
    fileCapabilities:
      image.generate:
        mode: role
        targetId: role-illustrator_01
  illustrator:
    id: role-illustrator_01
    brain: planning_model
    senseGroup: drawing
    fileCapabilities:
      image.generate:
        mode: tool
        targetId: file_svc_image_b_image_generate
sense_groups:
  coordination: [spawn_role]
  drawing: [file_svc_image_b_image_generate, file_svc_image_b_image_reference]
```

示例还必须满足：两个角色均属于当前预设、派发权限允许 coordinator 派 illustrator、相应大脑支持工具调用、密钥引用存在。若 A 直接调用图片服务，则给 A 分配服务工具并将绑定改为 tool，无需额外绘图角色。若 A 不能看图，配置 `image.inspect` 的工具或允许委派的视觉角色，不改 A 的原生 input 为支持。

AI 按 `get + 资源目录查询 → validate → 既有变更确认 → patch → apply 状态查询` 执行；单批次可以同时创建服务、更新工具组和角色引用。服务 ID由创建接口产生并回填候选资源，或采用共享 schema 允许的请求稳定 ID；不得在模型提示中只让 AI 自由编一个可能冲突的工具名。引用工具标识从候选目录计算，保存前验证整批引用关系。

### C05 技能依赖与固定步骤

技能 frontmatter 接受 `requires.capabilities` 和 `optional.capabilities` 操作 ID 列表；角色装备预览、技能加载与运行检查使用相同计算。原技能无字段时保持“未声明依赖”，不是没有能力。允许带缺项装备和保存；明确调用该技能前检查必需能力，缺失时返回具体操作与配置入口，不执行依赖缺失的技能步骤，也不阻止角色普通聊天。可选依赖缺失仅跳过对应步骤。静态操作可用不证明所有文件可处理，实际格式、数量及权限在执行时再次检查。

技能正文可以建议先规划、后生成、再检查；本次不会把自然语言自动编译成强制流程。用户任务若明确要求先确认方案，使用现有提问/等待机制，并将等待条件记录到本次任务；明确要求检查则记录为任务完成条件。必需检查未完成不得标完整成功。自动再次生成/修图只在用户允许的任务范围内执行，沿既有循环上限；不因检查失败自动无限返工。不得以“技能里写过”当作系统已经保证执行顺序。

### C06 文件与上下文默认值

`files` 配置集中维护以下产品默认值；这是可调整的设计值，不是所有服务商的硬限制。

| 字段 | 默认 | 校验与含义 |
| --- | --- | --- |
| `maxUploadBytes` | 100 MiB | 正整数，服务端上传硬限；不以模型能力阻止保存 |
| `context.recentUserTurns` | 3 | 非负整数；0 为只带本次显式引用，普通用户轮也推进窗口 |
| `context.maxAssets` | 10 | 正整数；单次请求使用的不同资产版本上限；不限制只附文件或模型输出数量 |
| `context.maxBinaryBytes` | 16 MiB | 原始请求附件累计预算；另按实际序列化后总请求大小检查 |
| `context.maxExtractedCharsPerAsset` | 20000 | 正整数；超出标记截断并允许按范围继续读取 |
| `context.maxExtractedChars` | 80000 | 不小于单文件上限；还受模型整体 token 预算限制 |
| `context.defaultImageVariant` | `adapted` | 有不损害内容的适配版本时采用，否则原始；用户显式选择优先 |
| `imageAdaptation.maxEdge` | 2048 | 正整数像素；适配版本最长边，不放大小图，原始文件不修改 |
| `imageAdaptation.quality` | 85 | 1—100；仅适用于有损JPEG/WebP编码，不能伪装保证文字细节无损 |
| `unreferencedUploadRetentionHours` | 24 | 正整数；仅未提交上传且无其他引用的文件到期可清理 |
| `unreferencedAssetRetentionHours` | 24 | 正整数；持久记录解除最后引用后延迟清理；迁移中归属未明文件排除 |

上传数量与本次模型携带数量不同：超出当前携带上限时可分次发送或选择“仅附文件”；不能上传完悄悄丢弃。没有独立的“新增5项”限额。生成输出数量按服务限额及本次参数，输出单文件同样执行大小限制；超限记交付失败，不标保存成功。同文件重复引用不重复存储，协议实际重复发送产生的字节/token仍计预算；远端file_id不免除内容预算。

旧上下文按预算裁减并记录原因；新显式内容输入超限在远端调用前返回可处理错误。二进制内容字节、序列化后请求大小、提取文字和模型总上下文分别检查。适配版本默认保持透明度，GIF不自动转静态；需要改变动画/透明语义时由用户明确选择。小图不放大，实际变换与版本固定保存。

## 3. 文件与消息数据

### D01 文件记录

`Asset`：`id`、固定版本标识、`originalName`、`mimeType`、`kind(image/audio/video/document/file)`、`sizeBytes`、`sha256`、`createdAt`、`source(upload/tool/provider/workspace/migration)`、所有权范围、内部存储键、可选 `parentAssetId/transform`。外部返回不含绝对路径、密钥或永久带认证 URL。

上传首先属于当前后端身份的暂存记录，提交时原子关联到有权限的会话。访问沿现有身份和会话授权；知道assetId不是授权。子任务只取得明确输入文件的权限，可将正式成果回授父任务；同身份有权限的其他会话可以重新引用。试用记录独立归属当前身份。不同后端本次通过用户下载后重新上传，不提供自动搬运。

原始内容不可变。重名是不同资产；相同内容可去重物理存储，但不能合并授权范围。源、派生、消息、工具、任务关联独立记录。单文件写入采用临时文件→完成写入→登记元信息，失败留下可恢复状态，不返回不存在的成功 ID。

### D02 消息内容

有序 `parts` 包含稳定 `partId` 及 `text`、`asset` 和现有指令/角色/工作区引用的明确类型。资产部分保存 `assetId`、`assetVersionId`、`variant(original/adapted)`、`usage(content/reference-only)` 和可选可读说明。content表示本次使用内容，reference-only在界面显示“仅附文件”，本次不触发模型或工具读取，后续用户要求可重新使用。适配参数改变不会改写旧消息版本。数据库和消息协议以 parts 为权威；供文字算法使用的 content 在边界派生，切换后不保留独立可写文本副本。

工具调用/结果、思考签名及供应商必须保留的续接块沿各自正式类型处理，不压平成普通文本。所有发送、分支、历史、导出消费者均须核对；现有RPC可以升级时不新建职责重复的平行接口。

用户原文不由理解工具覆盖；模型请求投影可以替换成“附件说明 + 理解结果”。工具协议临时追加的 user 消息不写成用户真实发言。历史、分支、导出、上下文压缩及插件接入都消费同一结构。

### D03 处理和任务结果

`FileOperation` 保存操作 ID、输入资产/版本、有序参数、问题、执行对象、配置版本、来源消息/工具调用/任务、状态、输出文本/资产、远端任务 ID、错误、已报告 usage 与时间。用户问题、请求标识和版本参与结果复用，不因同一图就复用任意旧问题答案。

工具结果返回 `parts`、`outputAssetIds`、`operationId` 和状态；子任务返回 `summaryParts`、`deliverableAssetIds`、已登记操作来源及终态。生成草稿先登记为任务输出；提供正式的成果选择动作，不能只从末条文字推断。未显式选择时，每条独立产出链采用最后成功版本，同批多个结果全部保留，合并返回并标明系统采用；中间稿仍在任务详情可查。选择的资产必须属于本任务可访问输出，非法选择不得标成功。

文件保存成功后才发布“可下载”；远端生成成功但本地保存失败为 `delivery_failed`，后续只重试取回/保存，不自动重新生成。

连续改图使用明确选定的成果和必要编辑上下文；供应商需要的签名/response ID等由适配器按规范持久保存。跨模型不转发不兼容的私有内容块，改用正式文件和任务说明。外部引用过期时按支持的方式由本地文件重建，不把临时云ID当唯一文件。

成功含义分别记录：生成成功=服务返回有效成果；保存成功=本地资产可读；检查成功=指定视觉处理给出有依据的通过结果；任务完成=本次要求已满足；返回父会话=完成记录已被父任务接收；渠道发送成功=对应外部渠道确认。它们不能用一个成功布尔值替代。

## 4. 接口职责

以下定义目标接口职责；名称须在开工时核对现有正式RPC，有相同职责则升级原入口，不新增平行通道。协议同步注册并删除被替换入口，前端不直连服务商。

| 接口/操作 | 输入 | 输出与错误语义 |
| --- | --- | --- |
| `POST /api/assets/upload` | 二进制 body、文件名与 MIME；请求绑定当前后端身份 | 资产元信息；空文件/大小/格式识别错误逐项返回；不调用模型 |
| `GET /api/assets/:assetId` | ID、原始/适配版本、预览或下载用途 | 鉴权后的字节；下载 Content-Disposition；不存在与无权限不返回内部路径 |
| `assets.get` | ID 列表、当前会话访问上下文 | 元信息/缺失状态；不读出全文件，不消耗模型额度 |
| 受控资产列表/读取工具 | 当前会话/任务身份、资产ID、版本、问题或页/行范围 | 有权限的模型按需发现和读取旧文件；校验操作能力及本次预算；不向无工具模型注入工具 |
| `assets.importWorkspace` | chatId、相对文件路径、请求 ID | 校验工作区后创建不可变快照；目录不接受 |
| `chat.input.submit` | 当前会话、稳定 clientMessageId、有序 parts | 输入 ACK 与运行状态分别返回；同 ID 重试不重复创建 |
| `chat.branch.create` | 原分支定位、类型、有序 parts | 原子创建新分支并关联资产；创建成功后刷新失败不可重建 |
| `capabilities.resolve` | 角色/预设、可选临时运行选择，或版本化配置草稿 | 计算结果与配置版本；草稿查询不应用、不调用远端 |
| 配置候选保存 | 增加文件服务、角色绑定、files 策略字段 | 沿用现有 revision/影响预览/备份/采用结果，不另建保存通道 |
| `fileServices.validate` | 类型化服务草稿 | 结构与引用结果，明确不是远程验证 |
| `fileServices.try` | 服务快照、操作、参数、请求 ID | 真实操作记录及结果；不保存配置；按当前权限执行 |
| `fileOperations.get/retry/cancel` | operationId；retry 指明失败步骤并带请求 ID | 查询、单操作重试/取消；不重放整条用户消息 |
| 试用记录列表/删除 | 当前身份、记录ID | 重新查看已保存试用成果；删除解除引用，其他有效引用继续保留 |
| `spawn_role` | role、任务 parts、输入资产引用、现有 wake 策略 | 创建任务；终态由任务结果回写，不要求模型拼路径 |
| 正式成果选择动作 | 当前任务、可访问的输出资产列表 | 持久保存最终交付集合；无效引用拒绝，不影响已有文件可读 |

新配置读取/写入加入 `config_manage` 的资源操作与发现接口；现有 `get/patch/rollback` 保持统一业务方式，目标 schema 不再接受旧能力字段。`putFileService/removeFileService/setFilePolicy` 与 `putRole` 的引用更新可同批原子提交；配置信息脱敏后才回给模型。

## 5. 格式处理矩阵

| 文件 | 保存/展示 | 模型使用方式 | 不支持或失败时 |
| --- | --- | --- | --- |
| PNG/JPEG/WebP/GIF | 原始保存、缩略图、完整预览；GIF 保留原动画 | 支持该 MIME 的原生视觉；否则视觉服务/工具 | 明确无可读方式；格式转换作为派生版本，不静默取 GIF 首帧冒充完整动画理解 |
| PDF | 文件卡、下载；预览能力存在时由用户打开 | 内置支持接口的原生 PDF；文字提取/OCR通过配置的工具接入 | 加密、扫描件、页数/大小超限说明；扫描件无原生视觉或 OCR 方式不能标已读 |
| TXT/MD/CSV/JSON/代码文本 | 文件卡，可读文本预览 | 有界文本提取；CSV 保留表头/行号，JSON 不擅自执行或改写 | 编码不支持、二进制误判、截断均明确；不把预览结果当完整文件 |
| DOCX/XLSX/PPTX | 保存、文件卡、下载 | 配置文档转换工具；记录页/表/幻灯片范围 | 初始不内置完整 Office 渲染；无工具时可仅附文件保存/下载；不把 ZIP 原文当文本 |
| 音频/视频 | 原始保存、按浏览器支持预览播放 | 现有原生支持或工具转写/理解；按真实服务限制 | 浏览器不能播放仍可下载；不能把静音/空结果作为正常理解 |
| ZIP/其他二进制 | 文件卡、下载 | 仅已配置且允许的专用工具 | 不自动解包或执行；模型得到文件存在与未读取说明 |
| 工作区路径/目录 | 显示路径引用，不自动上传 | 现有受控文件工具按需访问 | 路径失效显示具体错误；绝对路径不发送外部服务 |

## 6. 执行顺序与恢复

1. 接收文件与消息，校验身份、引用及请求重复；持久输入 ACK 后才运行。
2. 固定本次角色、配置版本及操作目标，按每个资产建立处理计划；仅附文件不读取。多文件比较等同一问题按相关文件分组，不能因逐附件判断而拆坏联合理解。
3. 原生输入按协议生成内容；工具理解通过统一工具执行入口，沿用权限、取消和预算；角色任务由后端调度。前置过程只理解，不生成/编辑。仅上传图片无问题时使用明确的通用内容描述；需要联合读取但缺少能力时报告限制，不把独立摘要当精细对比。
4. 缓存命中仅使用条件一致的成功记录，条件含有序文件版本、问题/必要语境、处理对象和有效配置、范围。批处理观察只记录一次并关联所有输入；请求去重不等同跨任务内容复用。新的问题可以使用旧结果作背景，但须明确它没有回答新问题。
5. 建立最终模型请求计划，计算文本/图片/工具结果预算；选择原始或派生版本，记录每项携带/未携带原因。
6. A 调用生成服务或派发 B；外部请求建立 operationId，先登记再调用。外部响应解析完，先保存资产再发布结果。
7. 子任务结果写入正式完成记录，再投递父任务；接收/续跑采用同一去重键。当前主流程切换时按现有 deliveryChatId 与代次规则投递。
8. 浏览器仅订阅和展示。父任务活跃时消费新增结果；父任务等待子结果时后台唤醒；用户主动暂停/停止时只保存结果、不擅自恢复。
9. 重启后认领未处理的本地任务；支持查询的远端任务先查询；无法确定外部是否成功时标结果待确认，不自动再次生成。

操作分开记录执行状态、远端状态、文件交付状态和检查状态。执行包括 `waiting_approval / queued / running / succeeded / partial / failed / cancel_requested / cancelled / result_unknown`；交付包括等待保存、保存中、已保存、部分保存、保存失败；检查包括未要求、待检查、通过、未通过和检查失败。审批等待、排队截止、执行截止分别记录。只有确认停止才标cancelled；无法撤回远端调用时明确“已停止等待，远端可能仍完成”。迟到文件可保存，但不自动唤醒已停止任务。

不能通过刷新、重连、重复终态通知触发第二次生成。只对明确未执行的错误自动安全重试；内容生成结果不明时先查询，无法查询则由用户选择是否发起新生成。厂商不支持单项续作时不能将新请求叫精确重试。远端任务ID和返回结果尽早持久保存；从未可靠收到响应且无查询接口时，不能承诺重试下载即可恢复。模型检查不是用户验收，默认不额外检查，明确要求时按任务条件执行。

## 7. 上下文、用量与记录

最近用户轮以同一对话的真实用户输入计数，不把工具循环算新轮，不把子角色回复算人类轮。当前显式内容引用优先，未完成任务必要输入随后，已完成历史按最近3个用户轮（可配置）从新到旧填剩余预算。子任务以自身任务输入为起点，不复制父会话全部历史。仅附文件不自动变为内容输入；生成成果默认不在后续每轮重发，检查或重新引用时才携带。recentUserTurns=0禁止自动携带已完成历史，但不移除未结束任务的必要输入。

超预算只裁减非显式历史，保留可重新引用的说明。有工具能力的模型可经受控资产工具找回；无工具模型使用用户重新引用或已配置的前置处理。临时换模型后重新计算可用方式，不删除历史；必要输入不可读则报告缺项，不用旧摘要假装回答新图像细节。

理解记录是有来源的工具观察，不提升成系统指令。上下文压缩保留资产 ID、任务关系和必要说明，但压缩不是重新发送所有二进制。模型请求统计使用同一实际计划；本地估算、官方 token 预检与供应商 usage 分开，未知图片 token 不填 0。官方预检可用则使用，不提供或暂不可用时采用保守本地估算并注明；明确超限仍阻止调用，不能因某厂商没有预检接口而使全部调用不可用。

## 8. 迁移、保留与删除

迁移前创建一致备份，按版本登记进度。顺序：资产元信息→旧消息引用→工具/任务结果→配置→新协议采用→删除旧运行入口。临时中断后从最后已提交段恢复；迁移写入去重，失败不开放半迁移会话继续写入。

旧媒体标记仅在精确匹配且文件确实属于可迁移数据时转换；普通文本不误删。旧生成 URL 只有能确认受控本地文件映射时成为资产，其他保留普通链接。缺失文件保留说明。旧 `generate.*` 删除并报告，不能转成虚构服务；旧 `accepts/produces/preprocess` 只能给候选映射，未确定执行参数的工具停用自动文件处理并列补配置项，其他功能可运行。符合新公共接口的普通文本工具仍可用，不靠URL猜文件输出、不保留旧媒体执行分支。数据结构迁移失败则阻止新版本写入。

配置备份回滚走新 schema 校验，旧备份先迁移到新结构后作为候选；数据库结构回退只能与相应程序版本和数据备份一起处理，不向用户提供“任意回滚都兼容”的承诺。保留原文件和凭据不等于保留旧执行路径。

文件删除以有效引用为依据。删除子会话、撤回输入、移除草稿不直接删除仍被主会话引用的文件。活跃草稿提供可续期保留记录，排队及在途任务持久保留引用；暂存清理只处理无引用且不在认领事务中的文件。草稿仍按当前内存方式保存，刷新前提醒，不扩展跨设备同步。成果、中间稿和试用文件随各自记录保留；提供试用记录删除，解除最后引用后按配置默认24小时延迟清理。迁移中归属不明文件排除自动删除。

引用认领和清理必须互斥，源/派生版本各算引用。磁盘不足明确失败，不删除仍被引用的文件腾空间；本次写入失败可清理自己未完成的临时文件。已有资产的全局永久删除不新增独立管理产品，沿现有会话删除语义处理引用。

## 9. 开发顺序与文档归属

先共享类型/协议与权威契约，再存储和迁移，再统一能力/服务/执行，再 Web 和 AI，最后删除旧消费者与集中验证。不得出现前端发送新 parts 而后端只收 string 的混合可用状态；协议版本不匹配明确提示刷新/升级。

正式事实归属：能力与配置→[模型能力说明](../../backend/agent/model-capabilities.md)；消息/任务返回→[共享协议入口](../../shared/protocol/README.md)；资产生命周期→后端服务专题；设置交互→[settings.md](../../frontend/settings.md)；会话交互→[工作台说明](../../frontend/workbench-multi-window.md)；AI→[配置管理](../../backend/agent/config-manage.md)与[角色设计](../../backend/agent/role-design.md)。实施时逐项同步，设计材料不作为已实现事实来源。

### 消费者必须同步的清单

| 消费者 | 同步内容 | 易错点与检查 |
| --- | --- | --- |
| 配置类型、加载、目录推荐、AI operations、设置协议 | 同一能力状态/服务/绑定字段；删除 generate；保留无关角色字段 | 一层接受、另一层 strip；未知目录值在 UI 被默认化 |
| Web DTO 与 application public 接口 | 移除服务层重复媒体类型，导出统一 parts/asset/operation 语义 | 编译成功但旧 JSON 映射丢字段 |
| 树 composer、对话输入、精简控制器、快速发送 | 同一有序草稿与目标 | 精简仍按历史 brain 判断，另一视图已按实际能力 |
| DB、journal、历史投影、流事件、导出和分支 | parts、输出引用、理解记录；旧文字算法用只读派生 | 只改实时消息，重启和分页又丢文件 |
| Provider、mock、压缩、usage | 同一请求计划；原生 MIME 支持；文字工具结果与文件分开 | mock 忽略附件导致测试假通过；工具图片转换消息泄露进用户历史 |
| 工具编译器、插件 API、MCP、接入插件 | 声明操作、正式文件结果及错误，不靠 URL 文本识别 | 外部工具只返回旧 content，未迁移却被标完整支持 |
| QQ/NapCat 等现有消息适配器 | 本次同步接入：平台附件导入资产，结果优先平台原生文件发送，不支持时提示原因及现有受认证入口 | Web 成功而平台端收到内部 assetId；不得自动永久公开文件；平台发送成功独立于文件保存成功 |
| 部署包与模板同步 | 编译输出、迁移命令、模板版本和模型目录随包交付 | 源码有新 schema，部署仍用旧模板；模板同步覆盖用户密钥 |

## 10. 错误码与参数变化

错误使用现有结构化错误协议，增加明确的业务 code：`asset.not_found`、`asset.unavailable`、`asset.too_large`、`asset.format_unsupported`、`capability.unavailable`、`capability.selection_required`、`capability.delegation_cycle`、`file_service.invalid_config`、`file_operation.result_unknown`、`file_operation.delivery_failed`。具体文案由原因和字段定位生成，不把底层堆栈回传用户。

调用参数优先级：用户明确要求→本次工具显式参数→服务 defaults→服务商缺省；任一值不符合当前模型约束就返回字段错误，不静默改尺寸、数量或参考图。配置版本在一次操作内固定；改变配置只影响下一操作。结果查询和重试仍引用原操作的参数和凭据来源记录，凭据已撤销则报不可访问，不偷换另一个服务继续。
