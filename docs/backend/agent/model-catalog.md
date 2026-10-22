# model-catalog.yaml — 模型目录

`.chery/model-catalog.yaml` 只保存模型识别规则、事实、编辑器推荐和协议映射，不是第二份 brain 配置。

- `facts`：已知最大上下文、官方协议、工具和媒体能力，用于展示与校验。
- `recommend`：没有协议专属值时，用户选择模型时写入设置页草稿；只有保存到 `config.yaml` 后才生效。可包含 `provider`（服务入口），切换模型时自动把服务与协议切到推荐值。
- `recommendByProtocol`：按 API 协议保存独立的编辑器推荐。切换协议时，设置页只更新仍等于旧自动推荐的字段，用户手动改过的值不被覆盖。
- `wire`：把已经保存的 `thinking` 档位翻译为请求字段，并声明历史思考的协议形状。
- 未匹配具体规则时先按模型名推断协议（GPT 系名称推荐 openai 服务与 openai-responses，其余推荐 openai-chat-completions），再叠加 `unknown.recommend` 的保守草稿；显式配置的 `unknown.recommend` 字段覆盖推断值。不伪造协议 wire 或可用思考档位。

## 匹配

`match.models` 支持三种形式：

```yaml
match:
  models:
    - { exact: MiniMax-M3 }
    - { glob: 'MiniMax-M3-*' }
    - { regex: '^relay-(alpha|beta)-\\d+$', flags: i }
  providers: [newapi] # 可选
```

普通字符串等同于 glob；不包含 `*` 时按精确值处理。匹配同时检查完整模型名和最后一个 `/` 后的名称。

默认模型规则全部保存在项目的 `.chery/model-catalog.yaml` 中，程序代码不隐藏厂商规则。它们统一使用“主体模型名 + 版本”正则，可容忍中转站前缀、日期或变体后缀和常见分隔符变化。版本边界会单独校验，例如 `deepseek-v4.1` 不会命中 `deepseek-v4` 规则。

优先级为精确 > 正则 > glob；同类匹配选择更具体的表达式。

## 完整结构

```yaml
version: 1

unknown:
  recommend:
    contextLimit: 256000
    thinking: off
    capabilities:
      toolCall: true
      input: { image: false, video: false, audio: false }
      generate: { image: false, video: false, audio: false }
  capabilities:
    toolCall: true
    input: { image: false, video: false, audio: false }
    generate: { image: false, video: false, audio: false }

models:
  - id: private-model
    match:
      models:
        - { exact: private-model }
        - { regex: '^private-model-\\d+$', flags: i }

    facts:
      contextWindow: 1000000
      protocols: [openai-chat-completions, openai-responses]
      capabilities:
        toolCall: true
        input: { image: false }

    recommend:
      provider: openai
      protocol: openai-responses
      contextLimit: 250000
      thinking: on
      capabilities:
        toolCall: true

    recommendByProtocol:
      openai-responses:
        protocol: openai-responses
        thinking: on
        capabilities:
          toolCall: true

    wire:
      openai-chat-completions:
        reasoningHistory: assistant-field
        thinking:
          - display: off
            params: { thinking: { type: disabled } }
          - display: on
            params: { thinking: { type: enabled } }
```

除 `id` 和 `match.models` 外均可省略。只声明 `wire.thinking` 时，前端仅获得思考档位，其他字段继续保持未知。

`reasoningHistory` 可取：

- `assistant-field`：Chat Completions 的 `assistant.reasoning_content`
- `reasoning-item`：Responses 的 reasoning item
- `thinking-block`：Anthropic Messages thinking block
- `omit`：不回传历史思考

## 推荐写入规则

选择模型时，设置页会请求 `utils.modelRecommendation`：

1. 首次选择模型时把推荐服务、协议、上下文、思考档位和能力写入编辑草稿。
2. 更换模型时，推荐带 `provider`/`protocol` 就强制切换服务与协议、覆盖当前草稿值，无论是否命中目录规则（命中时用目录推荐，如 gpt-5.6 → openai + openai-responses；未命中时按模型名推断）；推荐未给出服务/协议时保留当前选择，不清空。其他字段（上下文、思考、能力）仍只替换空值或仍等于上一模型推荐值的字段。未命中具体规则时，先按模型名推断服务与协议（GPT 系名称 → openai + openai-responses；Claude 系名称 → anthropic-messages 协议、保留当前服务；其余 → openai + openai-chat-completions），再写入 `unknown.recommend` 的保守值。
3. 用户手动修改的值不被推荐静默覆盖：同一模型下只调整服务或协议时，推荐不会把改动改回；仅在更换模型时，服务/协议按推荐切换。
4. 点击保存后，草稿写入 `config.yaml` 并成为运行时事实。
5. 运行时上下文百分比只读取 `brain.contextLimit`，不读取 `facts.contextWindow` 或推荐值。

## 思考开关与强制思考

思考档位按具体型号和协议维护，不把同一家族的可关闭结论套到新版本。`wire.thinking` 包含 `off` 才表示该型号在此协议可关闭；未知目录没有档位，不伪造支持。

运行时全局关闭优先请求 `off`，优先于 brain 中保存的等级。目录明确列出档位却没有 `off` 时，不能把关闭请求静默提升成 low，也不能省略参数后让服务使用可能更贵的默认 max：请求前返回明确的配置冲突，不发送模型请求、不改保存偏好。用户需要确认开启全局思考并选择合法等级，或选择支持关闭的型号；自动采用最低档的替代政策尚未获得确认。未知模型不注入猜测参数。

`wire.toolCallThinkingLevels` 声明某协议允许函数调用的思考档位；空数组表示该协议不支持函数调用。请求携带工具而档位不兼容时明确报错，不删除工具、不改档位、不切换协议。该限制是官方接口约束，不是从 provider 地址推断的能力。

MiniMax M3.1 Flash Preview 的 Chat Completions 使用 `reasoning_effort`，Messages 使用 `output_config.effort`，Responses 使用 `reasoning.effort`；合法等级均为 `low/medium/high/xhigh/max`，不支持 `none` 或 `thinking.type: disabled`。显式选择低档时使用 `global.thinking: true` 与对应 `llm.brain.<name>.thinking: low`；Chat 请求应解析为 `reasoning_effort: low`，不能把全局开启等同于所有 brain 自动选择 low。M3 的开关能力不同，不能共用规则；M2.x 始终思考，接收 disabled 不代表实际关闭。Claude Opus 4.7 的 adaptive 是唯一**开启**模式，但支持 disabled；不能误写成强制思考。

## 默认规则

未知或新增代际必须单独核对后加入目录，不能放宽旧版本边界直接继承全部参数。当前目录区分 MiniMax M3/M3.1、GPT-6/6.1、Claude Opus 4.7、Gemini 3 的 Pro/Flash/3.1 变体、Qwen3-VL hybrid/thinking 和 MiMo 小版本。用户可修改、删除或追加中转站别名规则。未修改的官方模板文件可随版本安全升级；一旦用户修改，同步器保留用户版本。

### 官方查询入口与维护检查

查阅日期为 **2026-10-17**（不是网页更新日期；网页未明确发布时间时不伪造“最新更新”）。以下入口是参数事实来源；中转站是否完整实现要另外验证，离线测试不能证明中转能力。

| 范围 | 官方查询入口 | 维护要点 |
| --- | --- | --- |
| OpenAI GPT-5.5/5.6、GPT-6 Astra/Sol/Luna、GPT-6.1 Sol | [模型列表](https://developers.openai.com/api/docs/models)、[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)、[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、[GPT-6 指南](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra) | 6.1 Sol/Astra 无 none，Chat Completions 不支持工具；Sol/Luna 的 Chat 函数调用仅支持 off→none，推理加工具需 Responses；原生输出仅文本，image_generation 是工具；通用 API 示例不能覆盖具体型号指南限制 |
| Anthropic Claude Opus 4.7 | [Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)、[Effort](https://platform.claude.com/docs/en/build-with-claude/effort) | 支持 off 与 low/medium/high/xhigh/max；adaptive-only 指开启模式，不等于不能关闭；保留完整签名块 |
| MiniMax M3.1/M3/M2.7 | [Chat Completions](https://platform.minimax.io/docs/api-reference/text-openai-api)、[Messages](https://platform.minimax.io/docs/api-reference/text-anthropic-api)、[Responses](https://platform.minimax.io/docs/api-reference/responses-create)、[Responses schema](https://platform.minimax.io/docs/api-reference/text/api/openapi-responses.json) | M3.1 强制思考，五档；M3 可关闭但协议默认值不同；M2.7 上下文 204800，思考不可关闭；reasoning_split 是输出形状，不是深度档位 |
| DeepSeek V4/V3.2/R1 | [思考模式](https://api-docs.deepseek.com/guides/thinking_mode)、[V3.2 发布](https://api-docs.deepseek.com/news/news251201)、[R1-0528 发布](https://api-docs.deepseek.com/news/news250528)、[V3.1 别名切换](https://api-docs.deepseek.com/news/news250821) | V4 支持 off/low/high/max，协议字段独立；V3.2-Speciale 不支持工具，独立规则；0528 才有明确函数调用证据。deepseek-reasoner 是滚动别名，不能继续当作 R1；历史 V3.2 开关字段缺具体 schema，不保留猜测映射 |
| GLM 5.1/5.2/5.3/Flash/FlashX | [思考参数](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)、[GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)、[Flash](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash) | 5.2 可关闭；5.3/Flash 强制思考 low/high/max；普通 API 严格拒绝其他档位，Coding Plan 另有映射，不能混同；5.2/5.3/Flash 支持 1M |
| Google Gemini | [OpenAI 兼容](https://ai.google.dev/gemini-api/docs/openai)、[Gemini 3](https://ai.google.dev/gemini-api/docs/gemini-3)、[思考](https://ai.google.dev/gemini-api/docs/generate-content/thinking) | 当前聊天适配器是 OpenAI 兼容而非 Google 原生；Pro 与 Flash/Flash-Lite 档位不同，minimal 不是完全关闭；不同时发送 budget 和 level |
| Alibaba Qwen3-VL | [视觉推理](https://www.alibabacloud.com/help/en/model-studio/visual-reasoning)、[视觉](https://www.alibabacloud.com/help/en/model-studio/vision) | 现行页面明确列出 plus 混合思考，目录不再把 flash 套入该开关；thinking 后缀沿用独立规则；未核实 instruct/其他变体媒体事实为 unknown；地区入口、模型可用性及流式限制分别核对 |
| Moonshot Kimi K3 | [推理档位](https://platform.kimi.com/docs/guide/use-reasoning-effort)、[Messages schema](https://platform.kimi.com/docs/api/messages.md)、[Responses schema](https://platform.kimi.com/docs/api/responses.md) | 强制思考 low/high/max；Chat 顶层 reasoning_effort、Messages output_config.effort、Responses reasoning.effort，不发送旧代 thinking；历史分别回传 reasoning_content、签名 thinking block、reasoning item；Responses 图片需 data URL，不支持公网 URL；已配置地区地址不随域名跳转修改 |
| Step 3.5/3.7/5 Preview | [3.5](https://platform.stepfun.com/docs/zh/guides/models/step-3.5-flash)、[3.7](https://platform.stepfun.com/docs/zh/guides/models/step-3.7-flash)、[5](https://platform.stepfun.com/docs/zh/guides/models/step-5-preview) | 3.5 是纯文本；2603 只有 low/high；3.7/5 是多模态且 low/medium/high，Messages 用 output_config.effort |
| Xiaomi MiMo | [深度思考](https://platform.xiaomimimo.com/docs/en-US/quick-start/usage-guide/text-generation/deep-thinking)、[型号发布](https://platform.xiaomimimo.com/docs/updates/model) | 仅对官方明确的 2.5/2.6 型号加入开关；旧 V2 pro/flash/omni/tts 的媒体差异不能合并成全模态，当前泛规则为 unknown；厂商下线/重定向不授权更换保存型号；工具轮须保留 reasoning_content |
| xAI Grok 4.7 | [推理](https://docs.x.ai/developers/model-capabilities/text/reasoning)、[型号](https://docs.x.ai/developers/models/grok-4.7) | low/medium/high/xhigh，不可关闭；Responses 为 reasoning.effort 并原样回传 reasoning items |
| 图像模型与文件服务 | [GPT Image 参数](https://developers.openai.com/api/docs/guides/image-prompting)、[Gemini generateContent 图像](https://ai.google.dev/gemini-api/docs/generate-content/image-generation)、[Imagen](https://ai.google.dev/gemini-api/docs/imagen)、[MiniMax 图像](https://platform.minimax.io/docs/api-reference/image-generation-i2i)、[Seedream pro/flash](https://docs.volcengine.com/docs/ark/seedream-5-0-pro?lang=zh)、[Seedream API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh) | 图像服务不是聊天思考协议；不得凭兼容协议推断所有 variant 的字段；下面列出已实现范围及限制 |
| Ollama | [Chat](https://docs.ollama.com/api/chat)、[Thinking](https://docs.ollama.com/capabilities/thinking) | think 的合法值由具体模型 /api/show 声明；目录未确认不猜，已配置 ollama-chat wire 需实际传入请求 |
| New API/custom/mock | 各实际连接的实现文档；mock 无上游 | 仅提供入口或离线测试，不是模型厂商，不从中转地址推断厂商能力 |

维护触发：新增或更换具体型号、preview 转正式、日期快照变化、上游参数报错、切换地区/平台/协议、厂商模型页更新。依次检查官方模型页 → 对应协议请求 schema → 平台差异 → 本地目录 → 实际请求序列化 → 离线回归。缺证据的型号/字段保持 unknown，不用较新家族名补全能力。

### 图像服务参数与实现边界

已批准的张数契约使用 `capabilities.imageOutput[operation]` 描述实际绘图模型、接口及操作的原生限制，不属于规划角色能力。每项包含可选 `adapter`、`nativeMultiImage`（supported/unsupported/unknown）、`countControl`（requested/maximum/uncontrolled/unknown）、可选 `maxImagesPerRequest`、可选 `maxInputAndOutputImages`。目录条目必须明确 adapter，只有与实际文件服务一致时才能采用；连接内手动声明可省略 adapter，表示该连接正在使用的接口。省略能力项继承目录，显式 unknown 不冒充单图；手动覆盖不解除接口尚未实现的参数。不能把 Images 的 n 用于 Responses，也不能把 Responses 连接的聊天大脑当作图片型号。

全局 `files.imageGeneration.defaultCount` 是唯一默认张数，缺省 1。服务 defaults 不再接受 n、sampleCount、sequential_image_generation 或 sequential_image_generation_options；这些仅由统一张数计算生成当次厂商参数。期望张数与收小后的有效张数分别记录，参数、接口、型号或参考图改变后重算，不改写已保存的全局偏好。旧服务数量默认一次性移除，其他参数与历史请求结果保留。该契约实施中，尚不表示运行版本已支持。

- GPT Image 2.5 的具体型号为 `gpt-image-2.5-sunburst` 与 `gpt-image-2.5-flare`。支持显式 `xhigh/max` 图片质量和自定义尺寸：边长不超过 3840、16 的倍数、最长短边比不超过 3、总像素 655360–8294400。Responses 图片服务需显式设置 `image_model` 才使用这些专属参数，不能把顶层聊天模型当作图片模型。旧代质量/尺寸限制保持独立；2 的 `input_fidelity` 明确不能发送，2.5 的该旧参数未确认也不猜测开放。流式局部图片仍未实现，不把接口支持说成本地已支持。
- Gemini 图片服务使用 `generateContent`，保存配置名 `imageConfig` 在发送时映射为 `generationConfig.responseFormat.image`；不是聊天 OpenAI 兼容接口。3.1 Flash Image 支持 `512`，Flash Lite Image 只支持 `1K`；具体图像型号才声明图片输入输出，不把 PDF 或 Chat Completions 支持写成已确认。Interactions API 页面不是 generateContent 请求 schema。
- Seedream 5.0 pro 为 `doubao-seedream-5-0-pro-260628`，flash 为 `doubao-seedream-5-0-flash-260915`。基础生图支持 `1K/1.5K/2K` 或总像素 921600–4624220、宽高比 1/16–16 的尺寸；不是 4K。`optimize_prompt_options.mode=fast` 仅 pro，flash 仅 standard。PNG/JPEG 输出、b64_json/url 返回、水印、最多 10 张参考图分别校验；现代型号单图上限 30,000,000 字节。上游还接收更多图片格式，本地通用资产入口仅开放 PNG/JPEG/WebP/GIF，不扩大原资产格式契约。
- Seedream 透明输出显式 `background=transparent`，本地需单张 PNG 参考图并禁止 JPEG 输出，真实透明通道由服务方校验。图层拆分虽然上游已支持，但本地缺图层位置/名称等结果契约，因此明确拒绝 `layer_decomposition`，不把普通多图结果冒充图层支持。组图、seed 与流式不套到 pro/flash；没有自动重试或收费降级。
- MiniMax 人物参考不是通用编辑；Imagen 使用显式 Vertex 项目/地区完整 predict 地址与 Bearer 认证，不把已停用的 Gemini Imagen 入口当作可用。六类文件适配器只实现共享参数 schema 中列出的范围；并不承诺所有厂商参数均已实现。未实现的字段拒绝而不是悄悄丢弃。

### 常见维护错误与防止方式

- 新 exact 匹配会启用原先未生效的全部 wire；补图片格式时同时核对 thinking，不能只验证图片能力。
- 点号是版本的一部分。既要匹配已确认的小版本，也要证明未知小版本不误命中旧代；测试大小写、namespace、日期、preview、thinking/instruct 差异。
- 全局 off 是用户意图，不保证服务支持；强制思考不得发 disabled/none，也不得提高到 low 或省略后落到厂商默认 max。请求前报告冲突，保留用户的选择权。
- reasoning_split=true 的独立兼容性不能从“同时删掉 thinking 和 reasoning_split 成功”推出；只记录已证明的拒绝字段，避免归因到图片。
- SDK 异常不能在请求局部循环被通用错误覆盖；保留已分类的 errorId/detail/cause，不输出密钥、messages 或图片字节。
- 已有 model-catalog 专题承担模型知识；本仓库没有统一 lessons 系统，不在 AGENTS 增加厂商参数知识，也不新建全局知识体系。

离线回归入口：`apps/backend/test/utils/modelThinkingMaintenance.test.ts`，并联查 `modelCatalog.test.ts`、各协议 provider 测试及 `agent/middleware/chat.test.ts`。生产目录更新必须逐文件原子写入、校验修改前摘要并回读；不改运行地址、型号、凭据或用户 thinking 偏好。目录缓存及旧运行镜像仍需通过获授权的重载/部署后使用新源码，更新磁盘文件本身不是生产修复验收。

RPM 不属于模型能力，它由账号、服务或中转站决定，只配置在 `config.yaml` 的 brain 中。
