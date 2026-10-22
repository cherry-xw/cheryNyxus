# GLM Messages 服务端工具：实测结论与完整需求

**文档创建时间：** 2026-10-17T01:13:12+08:00

> 本文维护服务端工具实测证据、功能要求、当前实现边界和验收条件。代码接通不等于真实完整流程通过；当前授权、预算与恢复入口见 [README](README.md)。资料核对日期：2026-10-17。

## 1. 当前结论

1. **GLM-5.3 经 Messages 接口能够理解图片，已实际复现。** 用户仅提供固定原图和“请描述这张图片的内容。”；完整 Claude Code 请求得到正确的主要场景描述，并收到真实的服务端工具事件。
2. 模型原生能力与服务提供的能力不同：GLM-5.3 官方仍标为仅文本；本次通过服务端 `analyze_image` 完成理解。不能因此把所有 GLM-5.3 配置标为原生视觉模型。
3. **网页读取与联网搜索均已取得独立成功证据**：网页返回 `server_tool_use(webReader)` 和对应正文；搜索仅声明专用 `web_search_20250305`，返回 `server_tool_use(web_search_prime)`、匹配结果及带来源的答案。搜索结果也已真实交回原主会话，主模型随后要求读取官方页面；该原问题的最终回答尚未完成，不能把搜索成功扩大为完整任务已完成。
4. **未找到 Messages 内置工具完整目录的公开查询接口。** 标准 MCP 的工具列表、Chat Completions 的 MCP 发现结果、Messages 已观察到的调用，是不同来源，不能混成一份“全部可用工具”。
5. 图片最小触发条件仍未确定；搜索已有不依赖 Claude Code 说明、普通工具列表或身份头的独立请求。不能把搜索条件推广到图片，也不能靠假工具或图片内容提示宣布产品接入完成。
6. 产品已接通独立服务端工具记录、协议解析、保存、工具卡，以及按连接隔离的观察记录和设置/AI 共用的能力来源查询；不能据此宣布 ST01—ST13 全部完成。真实任务成功/失败的验证管理、图片触发与输入选择、完整事件顺序恢复及真实多轮仍有缺口，见 §5。当前配置状态仍为“尚未验证”，调用结束不会自动建立验证成功。无本地素材的视频不测试、不生成素材；仓库、专项视觉及其他 MCP/API 不纳入本次实测。
7. 当前入口的 Chat Completions / Responses 尚未取得相同 GLM 能力的成功证据：搜索分别在请求转换、云端工具输出转换处失败，纯图片输入均拒绝查看；网页读取没有明确声明而未测，详见 §2.6。GPT Responses 已完成首批 4 次、1 次 Codex 风格搜索及 1 次用户明确批准的重试：首次搜索被 max_tool_calls 参数拒绝；去除该参数的 Codex 风格搜索首次遇到瞬时 HTTP 429 `model_cooldown / usage_limit_reached`（上游凭据配额冷却），明确重试后成功返回 `web_search_call(action=search)`、3 条 `url_citation` 引用和有依据的最终回答；Python/Shell 工具类型不支持；指定网页出现真实 open_page 和正常结束，但正文报告抓取失败，未取得页面内容。不能归因于 IP/域名封禁，也不能把工具完成状态当成内容读取成功，见 §2.7。

## 2. 已验证的调用流程与边界

### 2.1 实际流程

```text
固定资产版本 + 中性问题
  → Claude Code 2.1.183 构造 Messages 请求
  → GLM 服务返回 server_tool_use(name=analyze_image)
  → 同一响应返回 tool_result(tool_use_id=上述调用 ID)
  → GLM 返回图片描述
  → message_stop，stop_reason=end_turn
```

- 请求型号 `co-glm-5.3`，响应型号 `GLM-5.3`；一次 HTTP 请求内完成分析与最终回答，没有客户端二次执行图片工具。
- 请求工具定义没有 `analyze_image` 或 `image_analysis`；客户端 MCP 列表为空。**安装 MCP 不是已复现路径的前提。**
- 原图内容未在问题中透露；回答为红色机器人拿蓝色洒水壶给绿色幼苗浇水，与既有对照一致。此结论是主要内容理解成功，不替代每个视觉细节的人工核验。
- 原 PNG 的 SHA-256 为 `578e5b3c5ef5c49be1cd767fee7af40e68a2e74d039b1443c2feea13c9d1a6a6`。Claude Code 发送的 JPEG 为 195105 字节，SHA-256 为 `3a1b59781e257076eecbc6413d101ea7d65e2c6b4004f168d1a7f2236203df30`。成功不证明必须转换 JPEG，也不证明原 PNG 的独立请求已成功。
- 服务端调用参数包含 `imageSource` 和服务端生成的分析 `prompt`。客户端实际发送 Base64 图片，不需要预先托管公开 URL。服务返回的签名 URL 不是本地资产的新身份，也不能当作长期可用地址。
- `usage.server_tool_use.web_search_requests` 为 0，但图片工具确实执行。不能以搜索次数为 0 判断没有服务端工具。

### 2.2 条件对照

四组使用相同图片字节、相同问题和型号，各一次，无重试：

| 请求变化 | 结果 | 可以得出的结论 |
| --- | --- | --- |
| 完整请求体，改为普通鉴权和协议请求头 | 正确描述，含图片工具事件 | 本样本不依赖客户端专用请求头 |
| 删除全部系统说明和日期提示，保留工具及其他字段 | 正确描述，含图片工具事件 | 本样本不依赖这些提示词 |
| 只删除工具列表 | 无图片工具事件，回答无法查看 | 工具定义与成功存在重要关联，尚未确定具体触发规则 |
| 普通请求头、无说明/会话附加字段、仅 Read 工具 | 无图片工具事件，错误描述成仕女画 | 这套组合不可用；同时改了多组条件，不能单独断言 Read 不足 |

下一次定位应固定一个成功样本的其他条件，只缩减工具集合；先比较仅 `Read` 与其余工具，再按结果缩小范围。需要保留成功对照以识别服务波动；不能把一次差异直接上升为永久规则。随后才验证 cheryNyxus 自有工具、原 PNG、非流式和完整历史。

### 2.3 证据位置与使用方式

原始输出在 `/tmp/opencode/`，保留供本任务复核，任务收尾时决定清理或迁入受管理验证产物位置：

| 证据 | 用途 |
| --- | --- |
| `glm53-messages-claude-full-live-result.json` | 完整客户端成功请求、事件、CLI 结果 |
| `glm53-messages-ablation-{headers,system,tools,minimal}-result.json` | 分组对照；`outgoingRequest/outgoingHeaders` 才是修改后实际发出的内容 |
| `glm53-messages-ablation-budget.json` | 四次调用上限和已用情况 |
| `glm53-messages-neutral-params-result.json` | 无系统/工具的独立参数组合失败样本 |
| `glm53-messages-web-{search,reader}-result.json` | 搜索与网页读取独立请求、完整响应事件；保留实际 `outgoingRequest/outgoingHeaders` |
| `glm53-messages-web-budget.json` | 本批上限 2 次，搜索/读取各 1 次，均已用完，无重试 |
| `glm53-messages-web-reader-reference.json`、`glm53-messages-web-review.json` | 独立官方网页、读取时间及哈希，离线事件重建和事实核对结果 |
| `glm53-messages-server-search-{search,continue}-result.json` | 专用搜索成功请求/结果，以及按原工具 ID 交回主会话的真实续接 |
| `glm53-messages-server-search-budget.json` | 专用搜索和续接共 2 次，均已用完，不自动重试 |
| `glm53-messages-server-search-{reference,review}.json` | 官方页面对照、搜索事实与交付边界复核；复核本身不调用模型 |

结果文件已去除 API 密钥、图片字节和签名图片地址。临时脚本仅用于本次调查，不作为产品唯一实现入口。进入开发时需把脱敏、无凭据的必要事件样本加入正式测试；恢复设计不依赖临时目录一直存在。

### 2.4 搜索与网页读取实测

**对象与方法：** 2026-10-17（北京时间），服务入口 `https://ai.xcherry.top/v1/messages?beta=true`，请求型号 `co-glm-5.3`。脚本复用成功样本的内置说明、25 个工具定义、请求头与参数；替换用户问题、移除图片，无 assistant 历史，不追加自定义系统说明。保留原内置日期提示作为固定条件，它不作为本次日期或时效证据。直接 HTTP 调用，未再次运行 Claude Code、没有本地执行器或 MCP 客户端，供应商内部如何调度不作推断。不开展直连/代理比较。

| 用例 | 搜索 | 网页读取 |
| --- | --- | --- |
| 用户输入 | 要求实际搜索 GLM-5.3 官方模型说明，对比 Flash 图片输入，给出标题、链接与原文 | 仅提供官方网页 URL，要求提取一级标题、工具名、三项功能名称、完整服务地址及原文 |
| 时间（北京时间） | 01:28:55—01:29:00 | 01:29:07—01:29:21 |
| HTTP / 协议 | 200，`message_stop`，无协议错误 | 200，`message_stop`，无协议错误 |
| 普通工具请求 | 两个 `WebSearch`，查询分别为“智谱 GLM-5.3 官方 模型说明 输入类型”“GLM-5.3-Flash 图片输入 多模态 bigmodel” | 一个 `WebFetch`，URL 与目标相同，prompt 要求按原文提取 |
| 服务端执行证据 | 无 `server_tool_use`，无工具结果 | `server_tool_use(name=webReader,input={return_format:"markdown",url})`，随后匹配调用 ID 的 `tool_result` |
| 结束原因 | `tool_use`，等待客户端执行 | `end_turn`，最终答案已返回 |
| 内容核对 | 只有“我来实际联网搜索……”；无搜索来源与结论，未通过 | 标题“网页读取 MCP”、工具 `webReader`、功能“网页内容抓取/结构化数据/远程服务”、地址 `https://open.bigmodel.cn/api/mcp/web_reader/mcp`，全部与独立页面及工具结果一致，通过 |
| 本地工具执行次数 | 0 | 0 |

网页读取源为 <https://docs.bigmodel.cn/cn/coding-plan/mcp/reader-mcp-server.md>。供应商返回的正文与独立抓取页面的套餐申请说明存在差别，但上述全部目标事实一致；因此只认定本次提取成功，**不声称整页逐字一致、页面最新、任意网站可读或无缓存**。原网页内容未提前放进模型请求，独立读取只用于验后对照。

两组 usage 均含 `server_tool_use.web_search_requests:0`。这与网页读取真实发生并不冲突；搜索失败结论依据缺少执行和结果，不仅依据计数。普通工具参数分散在 `input_json_delta`，不能从开始事件里的空 `input` 判断模型没给参数。

**新增边界：** 网页读取响应先发出普通 `WebFetch`，后发出 `webReader` 服务端调用和结果，二者 ID 不同。已确认同一 URL 的服务端抓取完成，但没有明确的协议字段把两个调用标成同一调用。不能把云端结果伪装成本地 `WebFetch` 的结果，也不能在 `end_turn` 后不加判断地执行遗留的 `WebFetch`。这一情况必须作为独立的解析、保存和防重复执行验收项。

**复核方法：** 临时脚本 `/tmp/opencode/glm53-messages-web-capabilities.mjs` 支持 `check`（不发模型请求）、`search`、`reader`；已用预算和排他创建的输出文件阻止重复调用。`/tmp/opencode/glm53-messages-web-review.mjs` 默认仅离线重建参数、核对 ID/结束原因/事实及两次预算，退出 0；`--reference` 只抓官方页面并保存，已使用，不能覆写原证据。后续真实调用必须另行授权，不能删除预算文件绕过上限。

### 2.5 联网搜索的完整流程与当前定位

**当前结论：专用云端搜索已通过，真实结果交付主会话也已通过。** 普通 `WebSearch` 与专用 `web_search_20250305` 不是同一层：前者要求客户端处理调用，后者由当前服务实际执行搜索。只发送前者并在第一次响应后停止，不能检验完整搜索功能。当前已确认一套可用的专用声明，不宣称它是唯一支持的版本或每个字段都不可省略。

证据按来源分开：

- [Claude Code 官方工具说明](https://code.claude.com/docs/en/tools-reference#websearch-tool-behavior) 明确 `WebSearch` 请求搜索后端、返回标题和 URL，不直接读取结果页面；读正文需后续 `WebFetch`。页面还说明一次调用内部可能多次搜索并有错误重试，完整客户端验证必须在转发入口限制请求数，不能只按用户问题计费次上限。
- [公开实现案例](https://github.com/superduck-ai/open-managed-agents/pull/141) 报告 Claude Code 2.1.120 的两层流程：主模型发普通 `WebSearch`，内置执行器另发声明 `web_search_20250305` 的 Messages 请求，然后把结果返回主会话。该案例的搜索执行服务不是本项目的服务，仅用于解释调用结构。
- [公开 GLM 验证报告](https://github.com/code-yeongyu/senpi/pull/3125) 记录 z.ai Anthropic 入口、`glm-4.6`、`tools:[{type:"web_search_20250305",name:"web_search",max_uses:2}]` 返回 `server_tool_use`、`tool_result` 和最终答案，搜索计数仍为 0。这是第三方自述，不是本项目实测，也不能直接推广到当前型号和账号。
- 智谱[中文搜索 MCP 文档][search] 明确 Claude Code 服务端内置、无需安装；[英文 Coding Plan 搜索页](https://docs.z.ai/devpack/mcp/search-mcp-server) 则提供远程 MCP 配置，没有同一段内置说明。两者不是完整的原始 Messages 搜索协议定义，不能把 MCP 工具名 `webSearchPrime` 直接替换普通 `WebSearch` 名称就认为完成接入。Anthropic 平台搜索协议页本次访问返回地区限制，未把该页正文当作已核验来源。

当前实测流程：

```text
用户问题 → 主模型请求普通 WebSearch(query)
  → 客户端搜索执行器另发 Messages 请求，声明专用云端搜索工具
  → 模型服务执行搜索，返回真实调用、结果、来源
  → 客户端将真实搜索结果按原 WebSearch ID 返回主会话（已通过）
  → 主模型要求 WebFetch 读取搜索所得官方页面（已收到调用，未执行）
  → 取得页面原文后给出原问题的最终回答（未验证）
```

这里“客户端执行器”是发起云端搜索请求，不代表搜索必须在本地实现或另装 MCP。本次是脚本复现这组请求和结果交付，不是对 Claude Code 内部实现的逆向，也没有捕获它的完整搜索流程。产品也可以在主请求中直接声明专用云端搜索工具；与其他真实产品工具混用、权限控制、历史续接和主模型选择仍需单独验证。

另外两条官方独立路径为：连接搜索 Remote MCP，先 `tools/list` 后 `tools/call(webSearchPrime)`，再把实际结果交给模型；或按 [Z.AI 搜索指南](https://docs.z.ai/guides/tools/web-search) 使用独立 Web Search API / Chat Completions 的 `type=web_search` 配置。它们各有接口和凭据要求，不用它们代替 Messages 内置搜索的验收。Chat Completions 声明的当前入口实测见 §2.6；独立搜索 API 和 MCP 均未调用。

**已验证的独立搜索请求：** 入口 `https://ai.xcherry.top/v1/messages?beta=true`，请求型号 `co-glm-5.3`，返回 `GLM-5.3`；`max_tokens=8000`、`stream=true`，单条用户消息明确要求只搜索一次并给出真实来源。无 `system`、无历史、无 metadata/thinking/context_management/output_config、无 Claude Code 普通工具定义；显式请求头仅普通鉴权、content-type、anthropic-version 和 accept-encoding。无需安装 MCP，搜索执行不在本地发生。

```json
{"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":1}]}
```

| 验证对象 | 实际结果与完成边界 |
| --- | --- |
| 专用搜索 | HTTP 200，1 个 `server_tool_use(name=web_search_prime,input={search_query,location:"cn"})`，随后匹配 ID 的 `tool_result`；`message_stop/end_turn`，无协议错误，无普通客户端工具调用 |
| 查询与内容 | 使用原主会话第一个查询“智谱 GLM-5.3 官方 模型说明 输入类型”，返回 9 条结果，4 条为官方文档；每项有 title/link/content/refer |
| 结果格式 | 本样本 `tool_result.content` 是 JSON 字符串，解析后为嵌套数组；保存原始结构，规范化时提取结果列表，不把数组层级丢失或字符串误当普通摘要 |
| 内容核对 | 官方切换模型摘要“GLM-5.3 为文本模型”和概览摘要“Flash 原生理解图片视频”，与独立抓取的官方页面一致；搜索摘要不等于页面全文或最新版本，不补造被截断原文 |
| 主会话交付 | 保留原问题、原 assistant 的思考签名与普通调用，将真实云端结果包装进第一个 WebSearch 对应的 user.tool_result；为第二个未执行查询返回明确 is_error，未把同一搜索冒充两次 |
| 主模型续接 | HTTP 200，无协议错误；正确说明第二个查询未执行，随后请求读取搜索所得 GLM-5.3 说明页和模型概览页，stop_reason=tool_use；真实结果已被利用，但页面读取和原问题最终回答未完成 |
| usage | 搜索响应的 web_search_requests 仍为 0；依据真实关联事件和非空结果确认成功，不以该计数作为唯一依据 |
| 额度与执行位置 | 本批总计 2 次模型请求，用完，无重试，无本地搜索或网页执行，无额外 MCP 请求；服务端只观察到 1 次搜索调用，max_uses 的错误边界及供应商内部行为未验证 |

本次没有把云端原始块直接作为下一条 assistant 内容回传，而是经普通工具结果交付；因此不能宣称已通过供应商私有块原样多轮回传。第二次响应没有 end_turn 的最终答案，也不能因无协议错误就认定整个原问题完成。

脚本 `/tmp/opencode/glm53-messages-server-search.mjs` 支持 `check/search/continue`，预算与排他输出阻止重复调用，continue 仅在搜索有真实关联结果后允许执行；本批已结束，不得删除预算绕过额度。复核 `/tmp/opencode/glm53-messages-server-search-review.mjs` 默认离线检查事件、9/4 条结果、主工具 ID、未执行查询及两个后续网页链接，退出 0；`--reference` 已用于独立抓取两个官方页面，页面只供核对、未再发送给模型。

下一步是把已验证搜索格式落实到产品设计，明确直接声明云端工具还是由真实本地工具调用专用请求；不要照抄 Claude Code 普通工具定义。产品接入、搜索后读网页再回答、完整历史及异常路径仍须验收。完整客户端捕获如确有必要需另有总请求上限；当前无剩余额度，不自动继续。

### 2.6 Chat Completions 与 Responses 协议对照

**范围与授权：** 2026-10-17（北京时间），同一 `https://ai.xcherry.top/v1`、同一账号和 `co-glm-5.3`，用户批准最多 6 次、每个协议/能力组合最多 1 次，不重试。实际 4 次；两个网页读取组合因没有明确的内置声明或真实官方 MCP 服务代码而跳过。批次已关闭，剩余 2 次不得挪给 GPT、重试或多轮续接。未执行本地工具、未装 MCP、未比较直连/代理，未修改产品代码。

依据智谱官方 [Chat 搜索指南](https://docs.bigmodel.cn/cn/guide/tools/web-search.md)、[Chat OpenAPI](https://docs.bigmodel.cn/openapi/openapi.json)、[Responses 指南](https://docs.bigmodel.cn/cn/guide/develop/responses/introduction.md) 和 [Responses OpenAPI](https://docs.bigmodel.cn/openapi/openapi-responses.json) 构造请求，流式、输出上限 8000，无系统说明、历史或 Claude Code 身份。图片仅固定原 PNG 的 Data URL 和“请描述这张图片的内容。”，无工具定义、无内容提示；1459345 字节、原始和发送 SHA-256 均为 §2.1 的原 PNG 值，未新建/转换图片，也未由执行助手看图。

| 组合 | 实际请求与结果 | 结论 |
| --- | --- | --- |
| Chat 搜索 | `/chat/completions`，`tools:[{type:"web_search",web_search:{enable:true,search_engine:"search_pro",search_query,count:5,search_result:true,require_search:true}}]`；HTTP 500，`convert_request_failed`，错误 `unsupported type "web_search" without a native payload` | 请求转换失败；没有云端结果，不是模型已成功搜索 |
| Responses 搜索 | `/responses`，`tools:[{type:"web_search"}]`、`store:false`；HTTP 200，正文出现云端搜索开始提示，但随后 error 与 response.failed，错误 `unknown Claude server tool "web_search_prime" cannot be represented as an OpenAI Responses hosted tool` | 未交付结构化搜索结果，没有 response.completed；不能把开始文字当作完成证据 |
| Chat 图片 | 单条 `image_url+text`；HTTP 200、stop、正常流式结束；模型声称无法访问图片链接，未返回云端工具记录 | 标准图片输入没有复现理解；实际发送的是 Data URL，不能将模型自述当作丢图原因 |
| Responses 图片 | 单条 `input_image+input_text`；HTTP 200、response.completed；模型同样拒绝查看，输出只有 reasoning/message | 正常结束不等于看图成功；未复现云端分析 |
| 两种协议网页读取 | 未找到可直接采用的内置声明；官方 MCP 的 `server_label:"mcp code"` 未核实为真实可用服务代码 | 未测，不猜参数、不把占位值当真实工具 ID |

图片请求与 Messages 成功样本的 JPEG/完整工具集合并非严格单变量对照，不能把失败永久归因于协议，也不能宣布官方原生服务整体不支持。搜索错误只说明当前入口的已测声明未走通，不开展代理排查或改写其代码。

产物在 `/tmp/opencode/glm53-openai-protocols/`：`run.mjs` 的 `sources/check/review` 不调用模型，四种付费模式各排他输出并提前记录预算；`budget.json` 记录 4/6 与关闭状态；`{chat,responses}-{search,image}-result.json` 保存脱敏请求和完整响应，`source-0.json` 至 `source-4.json` 保存官方规范及哈希。离线 `review` 核对两类搜索错误、图片拒绝、原图哈希、无本地执行和预算，退出 0，结论在 `review.json`。HTTP 错误正文可能是 JSON 而非 SSE，复核同时检查 jsonResponse.error，不能只看流式错误列表。

### 2.7 GPT Responses、Codex 与 GLM 的差异

**调查边界：** GPT 的目标是核对相同服务入口的 `gpt-6.1-sol` 是否真正交付云端执行结果，不是默认 OpenAI 所有官方工具都能被当前账号/入口使用。用户已批准独立最多 4 次，搜索/指定网页/Python/禁网云端 Shell 各一次，实际已用完，无重试。原图不再生成，不上传私有文件、不操控浏览器、不安装 MCP、不改产品代码，不执行本地替代工具。

OpenAI 官方网页本次返回 HTTP 403，搜索服务返回 401；没有把这些网页正文作为已读证据。采用可访问的[官方 OpenAPI](https://github.com/openai/openai-openapi/blob/6ca9cb2b2dd5fbe766c32f3ab898e2e479c29840/openapi.json)，固定提交 `6ca9cb2b2dd5fbe766c32f3ab898e2e479c29840`；Codex 使用公开未打包源码与测试，固定提交 `221e4e7c05386d06aa7b91da2a9b04f7f2bd921f`，未访问本地 node_modules 或逆向构建产物。它们说明协议及实现路径，不是当前账号成功证据。

| 官方工具 | 执行位置与前提 | 当前调查/实测选择 |
| --- | --- | --- |
| `web_search` | OpenAI 服务执行；输出 `web_search_call`，action 可为 search/open_page/find_in_page；正文引用与 action.sources 用于核对来源 | 准备搜索、指定网页读取各 1 次；读取不是单独的 `webReader` 声明，要求实际出现 open_page 才算读取路径通过 |
| `file_search` | 服务端检索已上传并建立索引的文件，需要 vector_store_ids；不是自动读取本地磁盘 | 无授权文件/索引，本次不创建或上传 |
| `code_interpreter` | 指定自动或已有容器，在服务端执行 Python；输出代码、状态、outputs 和 container_id | 准备不读文件、不联网的确定性计算 1 次；云端容器可能单独计费 |
| `image_generation` | 服务端图片生成/编辑，返回 image_generation_call | 官方存在，不生成新图、不用它替代原生图片理解 |
| `mcp` / connectors | 模型服务连接远程工具，需要服务器/连接器、权限与可能的鉴权；可返回列表、审批请求、mcp_call 结果或错误 | 不安装本地 MCP 不等于无需远程服务；没有指定服务器和权限，不盲测 |
| `shell` | environment=container_auto/container_reference 可用云端容器；environment=local 则需客户端执行，不能混称云端 | 准备禁网云端容器、仅 printf 固定文字 1 次，不允许本地执行兜底；容器可能单独计费 |
| `tool_search` | execution 可为服务端或客户端；用于查找已提供但延迟加载的工具定义，不是网络搜索，也不是当前账号所有隐藏工具目录 | 无待发现工具集合，不作空泛可用性测试 |
| `computer` / `apply_patch` / 普通 function/custom | 协议定义操作或调用，但不能据此认为 OpenAI 已代为执行；computer 需要运行环境、动作结果/截图回传，patch/function 需对应执行方 | 不触碰浏览器及本地文件，不计入已具备的云端执行能力 |

**Codex 的实际处理路径：** [hosted_spec.rs](https://github.com/openai/codex/blob/221e4e7c05386d06aa7b91da2a9b04f7f2bd921f/codex-rs/core/src/tools/hosted_spec.rs) 的 `create_web_search_tool` 按模式生成声明，Cached 设 external_web_access=false，Live 设 true，Disabled 不发；该版本还有 Indexed 模式及模型相关字段，不能把未列入公共 OpenAPI 的字段照搬进产品。[spec_plan.rs](https://github.com/openai/codex/blob/221e4e7c05386d06aa7b91da2a9b04f7f2bd921f/codex-rs/core/src/tools/spec_plan.rs) 将 hosted specs 与本地工具注册分开，同时存在独立扩展 web.run 的选择，不能将全部 Codex 搜索路径当作同一接口。[web_search.rs](https://github.com/openai/codex/blob/221e4e7c05386d06aa7b91da2a9b04f7f2bd921f/codex-rs/core/src/web_search.rs) 分别处理 Search/OpenPage/FindInPage 的展示信息；对应测试核对实际请求的工具字段，但模拟测试不是当前服务真实成功证明。一次性脚本只复用公共声明及事件规则，不启动 Codex 隐式多轮循环、不复制其身份。

| 对比 | GPT Responses 官方定义 | GLM 已取得的证据 |
| --- | --- | --- |
| 搜索声明 | Responses `type=web_search`；external_web_access 控制是否允许外部访问 | Messages `web_search_20250305/name=web_search` 成功；Chat 相同语义需嵌套 web_search 配置，当前入口转换失败 |
| 执行/结果 | 专用 web_search_call 的 id/status/action，加正文引用与可选 sources；不应当做待本地执行的 function_call | 原始 server_tool_use(web_search_prime) 与按 tool_use_id 关联的 tool_result；结果为嵌套数组 JSON 字符串 |
| 网页读取 | 同一个 web_search 工具可有 open_page/find_in_page 动作，需实测型号和入口 | Messages 已出现独立 webReader 调用及正文；不能把名称直接改成 open_page |
| 完成与继续回答 | 检查工具完成、实际来源与最终 response.completed，可能一条请求内完成；跨请求历史另验 | 专用搜索一条请求内完成；交回普通 WebSearch 的主会话已通过，但后续读页面与最终答案未完成 |
| 当前入口转换 | GPT 网络搜索（去除 max_tool_calls 的 Codex 配置）已真实返回 `web_search_call(action=search)`、正文 `url_citation` 与 `response.completed`；网页读取返回完整 `web_search_call(action=open_page)` 但页面内容未读到；max_tool_calls 和 Python/Shell 工具被明确拒绝 | GLM Responses 明确无法表示 web_search_prime，HTTP 200 后流式失败；同为 Responses 不能假定两者云端事件都能处理 |
| 图片能力 | 需单独按 GPT 型号确认原生视觉；image_generation 是另一能力 | GLM-5.3 原生仅文本，已验证的是 Messages 云端 analyze_image，不能互相替代声明 |

**脚本与已批准额度：** `/tmp/opencode/gpt-responses-cloud-tools/probe.mjs`，`research` 保存固定版本官方来源，`check` 离线核对声明并生成 `prepared-requests.json`，两者不发模型请求。用户批准后创建 approval.json；budget.json 与排他结果文件阻止重复调用。四种付费模式串行各 1 次，已用完，不得删除预算重试，也未挪用 GLM 额度。每次仅对应工具、tool_choice=required、store=false、max_output_tokens=4000、stream=true，当前入口 `/v1/responses`、型号 gpt-6.1-sol。

搜索首先携带官方 max_tool_calls=1，被明确拒绝；不重复搜索，后续三个不同组合删除此已知不支持参数，网页问题改为只调用一次。后续只能靠请求文字约束次数，未宣称存在强制工具上限；网页实际仅观察到一个调用，Python/Shell 未执行。该调整不增加模型请求，也不把一次 API 请求与供应商内部物理搜索次数混同。

**四次实际结果（2026-10-17 北京时间 07:35—07:36）：**

| 项目 | HTTP / 响应 | 实际结论 |
| --- | --- | --- |
| search | 400，`Unsupported parameter: max_tool_calls` | 请求在执行前被拒绝；未验证实际搜索是否可用，不得写成不支持 web_search |
| reader | 200，1 个 web_search_call，action=open_page 且 URL 精确匹配，in_progress/searching/completed 的 item_id 一致，最后 response.completed，无协议错误 | 真实云端网页工具调用路径已成立，模型返回 gpt-6.1-sol；但正文报告 `Failed to fetch …: (400) OK`，未提取目标事实，annotations 为空，也没有 sources/页面正文，内容任务未通过 |
| python | 400，`Unsupported tool type: code_interpreter` | 当前入口/模型/账号组合不接受此类型，未执行计算；错误不说明由哪层拒绝，也不能外推官方 API 不支持 |
| shell | 400，`Unsupported tool type: shell` | 当前组合不接受此类型，未创建可观察容器或交付执行输出；未改为本地执行 |

网页错误只出现在模型最终文字中；响应没有暴露原始网页抓取错误对象或正文，所以精确错误原因不能独立核对。`web_search_call.status=completed` 与 response.completed 表示调用/回答结束，不保证抓取成功。该样本无搜索 action，不可拿来宣称网络搜索已通过；也没有明示域名、IP、地域或账号权限被拒绝。usage 保留供应商原值，不保证这批免费或无其他内部费用。

**当前后续仅定位 GPT 网络搜索：** 用户明确缩小到搜索，不再测试网页读取、计算或 Shell。同一固定 Codex 版本的 [tool_spec.rs](https://github.com/openai/codex/blob/221e4e7c05386d06aa7b91da2a9b04f7f2bd921f/codex-rs/tools/src/tool_spec.rs) 确认 WebSearch 序列化为 type=web_search，未设置的可选字段省略；结合 hosted_spec.rs，Live + 文本工具 + 无过滤/位置等设置时声明为 `{type:"web_search",external_web_access:true}`。[client.rs](https://github.com/openai/codex/blob/221e4e7c05386d06aa7b91da2a9b04f7f2bd921f/codex-rs/core/src/client.rs) 构造 Responses 请求时使用 tool_choice=auto、store=false、stream=true，工具并行取决于当前设置；未在该请求结构中观察到 max_tool_calls。新增源码通过 GitHub Contents API 在线核对，未宣称已加入 source-0 至 source-4 快照。

已准备并执行 `/tmp/opencode/gpt-responses-cloud-tools/search-codex-request.json`：同一现有入口/模型，单条用户搜索问题、上述 Live 工具声明、auto、禁用并行、store=false、stream=true；不发 max_tool_calls、不发其他工具、来源 include、最大输出或客户端身份等非必要字段。这是复现 Codex 对应配置的搜索相关请求，不是捕获真实 Codex 请求的逐字重放；没有照抄模型特定的 search_content_types 或内部字段，也不保证动态搜索结果逐字相同。

- **首次 Codex 风格搜索（`search-codex`）：** 独立 `search-codex-approval.json` 与 `search-codex-budget.json`（1/1 用完），2026-10-17 08:06（北京时间）返回 HTTP 429，`type=upstream_error`、`code=model_cooldown`，错误 `All credentials for model gpt-6.1-sol are cooling down (last error: usage_limit_reached: The usage limit has been reached)`。请求在模型/工具执行前因上游凭据配额冷却被拦截。
- **用户明确批准的 1 次重试（`search-codex-retry1`）：** 保留首次 429 产物不变，使用独立 `search-codex-retry1-approval.json` 与 `search-codex-retry1-budget.json`（1/1 用完），发送完全相同的请求体。2026-10-17 08:13:41—08:13:56（北京时间）返回 HTTP 200，正常流式完成 `response.completed`（模型 `gpt-6.1-sol`，`usage` 为 input 6678、cached 5376、output 779、reasoning 249、total 7457），包含 1 个真实 `web_search_call`（`id=ws_0c066885564063b2016ad2bdb823e087d0b9d5687fa6f4ddf1`，`status="completed"`，`action={type:"search",query:"智谱 GLM-5.3 官方 模型说明 输入类型",queries:["智谱 GLM-5.3 官方 模型说明 输入类型"]}`），流式事件依次经过 `response.web_search_call.in_progress`、`searching`、`completed`，无 `open_page` 或本地函数调用。最终回答含 3 条 `url_citation` 注解，依据阿里云百炼官方模型文档对比得出 **GLM-5.3 仅支持 Text 输入、不支持原生图片输入**，而 **GLM-5.3-Flash 原生支持 Text/Image/Video/File 输入**，并如实说明本次搜索命中的是阿里云官方服务文档而非 `docs.bigmodel.cn` 原始页面。这证明 GPT Responses 在当前入口和账号下的 `web_search` 云端搜索已真实走通，前一次 429 仅为上游凭据瞬时冷却。

证据目录 `/tmp/opencode/gpt-responses-cloud-tools/` 中 `{search,reader,python,shell,search-codex,search-codex-retry1}-result.json` 保存真实请求及完整响应、usage、错误和时间；search 的请求才有 max_tool_calls，其余无此参数。`review.mjs` 默认只做离线校验，核对首批 4/4、首次 Codex 搜索 1/1、明确重试 1/1（共 6 次）、无自动重试/本地执行、三项 HTTP 400 的精确错误、search-codex 的 HTTP 429 `model_cooldown / usage_limit_reached`、search-codex-retry1 的 `web_search_call(action=search)` 与 `url_citation` 引用、open_page 目标与事件 ID、无来源和最终抓取失败报告，退出 0，写入 review.json。原始产物当前保留供脱敏样本提取与诊断，任务收尾时按归属迁出/清理。

通过标准不是 HTTP 200、模型自称已执行或只出现工具开始事件：搜索要求完成调用、真实非空来源与有依据答案；网页读取要求 open_page 的目标关联、完整响应与可核对页面事实；Python 要求 code_interpreter_call 执行证据及结果 `333383335000`；Shell 要求云端环境、真实输出和正常结束，而不是让客户端执行 shell_call。对不支持的工具保留实际错误，不换模型/入口重试，也不从收费 usage 的 0 推断免费。文件检索、图片生成、MCP、computer、tool_search 和完整多轮均不在这 4 次内。

**域名、IP 与第三方能力限制的定位：** 用户要求区分官方可行与第三方限制，不能预设都是网络问题。公开 Codex 是客户端实现，不包含 OpenAI 云端搜索后端；源码能构造请求和模拟测试通过，不证明第三方已部署等价工具服务。按下表分别取证，不复制身份、不修改 Host 或尝试绕过服务权限：

| 位置 | 已核对事实 / 可能限制 | 不能直接推断 |
| --- | --- | --- |
| Codex 客户端选择 | 同版本 [provider capabilities](https://github.com/openai/codex/blob/221e4e7c05386d06aa7b91da2a9b04f7f2bd921f/codex-rs/model-provider/src/capabilities.rs) 的默认 web_search/external_web_access 均 true；模型、当前模式和扩展路径仍会限制暴露。配置可覆盖 external_web_access | 在已读搜索能力判断中没有发现“第三方域名/IP 一律禁用”；不是所有能力对所有入口都相同 |
| 服务地址与认证 | [provider info](https://github.com/openai/codex/blob/221e4e7c05386d06aa7b91da2a9b04f7f2bd921f/codex-rs/model-provider-info/src/lib.rs) 按认证模式选择 chatgpt.com/backend-api/codex 或 api.openai.com/v1，允许 base_url 覆盖；独立搜索、后端专用路由也有各自支持判断 | ChatGPT 登录权限不自动等于 API Key/第三方账号权限；地址不同不等于仅校验域名就能开启工具，更不能冒用登录凭据 |
| 第三方协议转换 | GLM Chat 已返回 convert_request_failed；Responses 已返回无法表示 web_search_prime 的明确错误 | 这是已观察的请求/输出转换失败，不是 IP 封禁证据；服务是否另有网络限制仍未知，不外推 GPT 同样失败 |
| GPT 当前实际限制 | max_tool_calls 参数、code_interpreter 与 shell 类型被明确拒绝；去除 max_tool_calls 的 Codex 风格 `web_search` 在上游凭据冷却恢复后成功返回 `action=search` 与 `url_citation`；open_page 可交付结构化事件，但目标页面抓取失败 | 无明示 IP/域名禁用；不把参数/工具类型不支持或瞬时配额冷却误诊为网络，不把单页失败泛化为所有网站都不可读 |
| 工具服务与账号 | 官方声明需要对应服务、模型、账号权限、配额；文件索引、容器和远程 MCP 还依赖额外资源 | “兼容 Responses”或模型名相同不保证云端工具执行、引用、历史与资源管理均实现 |
| 网络与访问策略 | API 请求出口、工具服务访问目标网站、目标域名过滤是不同位置；均可能有域名允许列表、地域/IP、防火墙或访问限制 | 超时、HTTP 403 本身不足以唯一确定 IP 原因；本次官方文档访问 403 不能当作 GPT 模型接口或云端工具被封的证明 |

实测脚本先原样记录 HTTP、流式失败、工具状态与结果，在用户现有入口判断失败发生位置；若出现明确地区/IP/域名拒绝再登记证据。只有同一模型/工具/请求在已授权且权限可比的不同入口或出口对照，或供应商错误/日志明确说明时，才定位网络限制；本任务没有这类对照授权，不自动换地址、出口或凭据。新增三份访问控制源码已通过在线读取核对，独立脚本下载快照超时，未宣称它们已保存进 source-0 至 source-4；固定版本链接可复查。

## 3. 还有哪些类似能力

这里的“服务端工具”指模型服务执行工具并返回结果；与 cheryNyxus 自己执行普通工具、连接外部 MCP 服务分别处理。

| 能力 | 官方名称或真实名称 | 接入方式与证据 | 当前验证范围 |
| --- | --- | --- | --- |
| 图片理解 | 文档 `image_analysis`；本次响应 `analyze_image` | [视觉 MCP][vision] 明确 Claude Code 服务端内置；实际 Messages 事件已取得 | 已验证主要内容理解；不擅自把两个名称全局改写为同名 |
| 联网搜索 | 声明 `web_search_20250305/name=web_search`；真实服务端名称 `web_search_prime`；MCP 文档为 `webSearchPrime` | [联网搜索 MCP][search] 的内置说明与本任务独立 Messages 成功证据 | 专用搜索和真实结果交主会话通过；产品接入、搜索后读原文再最终回答尚未完成 |
| 网页读取 | MCP 文档及本轮服务端调用 `webReader` | [网页读取 MCP][reader] 明确 Claude Code 服务端内置，无需安装 | 独立 Messages 请求已走通，目标事实与官方页面一致；完整产品流程待实现 |
| 图像专项分析 | `ui_to_artifact`、`extract_text_from_screenshot`、`diagnose_error_screenshot`、`understand_technical_diagram`、`analyze_data_visualization`、`ui_diff_check` | [视觉 MCP][vision] 提供的完整工具集 | 未证明这些均为 Messages 默认内置工具 |
| 视频理解 | `video_analysis` | 同一视觉 MCP 工具集 | 无本地素材，本次明确不做；不得由看图成功推断视频成功 |
| 开源仓库阅读 | `search_doc`、`get_repo_structure`、`read_file` | [Zread MCP][zread] 提供远程服务 | 未找到该页声明默认内置于 Claude Code Messages；独立 MCP 路径待验证 |
| 外部 MCP 工具 | 指定服务器实际返回的工具名 | [服务端 MCP 调用][mcp-call]：Chat Completions 的 `tools[].type=mcp` | 不属于本次已验证的 Messages 调用方式 |
| 搜索、文件解析、OCR 等独立 API | 按具体 API 定义 | [官方文档索引][index] 提供专用接口 | 不是隐藏工具目录；若接入，复用已有文件服务/普通工具体系 |

[Managed Agents 工具][managed] 是另一套产品，具有显式工具集和会话事件；不能把其中的 Bash、文件操作、搜索等名称或列表接口当作 GLM Messages 的内置契约。本次不扩展为接入整套 Managed Agents。

## 4. 获取工具列表的可靠途径

### 4.1 已知 MCP 服务：标准 tools/list

按照 [MCP 工具协议][mcp-tools]：先完成连接和初始化，确认服务声明 tools 能力，再调用 `tools/list`，跟随 `nextCursor` 取完分页。返回内容包括名称、说明、输入结构；可选输出结构和注解以实际响应为准。支持 `listChanged` 时处理列表变更通知。

官方已公开的远程地址：

| 服务 | 地址 |
| --- | --- |
| 搜索 | `https://open.bigmodel.cn/api/mcp/web_search_prime/mcp` |
| 网页读取 | `https://open.bigmodel.cn/api/mcp/web_reader/mcp` |
| 仓库阅读 | `https://open.bigmodel.cn/api/mcp/zread/mcp` |

这些地址的列表只属于对应 MCP 服务及当前凭据，不等于 Messages 内部工具列表。视觉 MCP 文档提供的是本地 stdio 安装方式；本轮不安装它、不猜测未公开 HTTP 地址，也未使用凭据查询上述服务。

现有 [`loader.ts`](../../../apps/backend/src/core/mcp/loader.ts) 的 `buildSensesForServer` 已调用一次 `client.listTools()`；项目代码未显式遍历 `nextCursor` 或处理工具变更通知。如果实施通用工具发现，需要按 SDK 官方接口补齐分页与刷新，不能把第一页显示为完整目录。

### 4.2 Chat Completions：服务端发现指定 MCP 的工具

[官方指南][mcp-call] 支持配置 `server_label`、`server_url`、`allowed_tools`、传输方式和鉴权；其中 `mcp code` 是指南明确给出的官方服务器标识，不是本文编造的工具 ID，但其在当前账号上的实际可用性尚未测试。

[OpenAPI][openapi] 的 `ChatCompletionResponseMessageToolCall.mcp` 包含：

- `type=mcp_list_tools` 时返回 `tools`，含名称、说明、注解与 `input_schema`。
- `type=mcp_call` 时返回工具名称、参数、输出和错误等字段。

这是模型调用中针对指定服务器的发现结果，不是一个已确认的“只列目录、不会执行工具”的接口。不能为查目录随意启用全部工具；`allowed_tools` 也不是 Messages 内置工具开关。

### 4.3 Messages：官方目录加实际观察

本轮检查官方 Claude API 兼容页、Coding Plan 工具页、公开 OpenAPI 与文档索引，未找到获取该入口全部内置工具的独立接口。应采用：

1. 官方说明记录“文档支持”。
2. 实际结构化事件记录“已观察到”，保留服务地址标识、协议、模型、时间和执行位置。
3. 成功样本记录“本配置已验证”，失败保留原因；连接/模型配置变化后重新核对。
4. 如供应商提供发现接口，再接入；当前显示“完整列表未知”，不伪造按钮或空列表结论。

让模型“列出你的全部工具”、从普通正文提取工具名称、依据 `usage` 搜索计数推测能力，都不是可靠目录。观察到调用参数也不能反推完整 JSON Schema。目录缓存按配置及凭据引用隔离，不能把一组账号的可用性推广到所有账号。

## 5. cheryNyxus 当前实现缺口

记录通路已有实现，以下逐项区分当前代码与剩余工作；不能把它们全部归为“仅待真实调用”。

| 位置与关键符号 | 已有行为 | 待补内容 |
| --- | --- | --- |
| [`anthropic.ts`](../../../apps/backend/src/agent/provider/anthropic.ts)、[`openaiResponses.ts`](../../../apps/backend/src/agent/provider/openaiResponses.ts) | 已分开解析服务端调用、结果与普通调用；支持搜索声明转换 | 真实产品请求、多轮与异常完整流程待验收 |
| `anthropicStreamSSE`、`extractSenseCallDeltas` | 按 block index 分开服务端与普通调用参数；脱敏离线事件覆盖交错、错误与孤立结果 | 真实产品异常与完整多轮仍待验证 |
| [`core/message/adapter.ts`](../../../apps/backend/src/core/message/adapter.ts) `LLMResponse`、`MessageProviderAdapterConfig` | 已有独立 `serverToolCalls` 和增量接口，不伪造成本地结果 | 正文、思考和工具统一顺序未完整保存；私有块续接未实测 |
| [`chat.ts`](../../../apps/backend/src/agent/middleware/chat.ts)、[`checkpointState.ts`](../../../apps/backend/src/agent/middleware/checkpointState.ts) | 服务端增量合并与 `end_turn` 混合调用停止本地执行已接通；已有不完整事件、重复快照、审批时机及结果状态的离线覆盖 | 正文/思考/工具完整顺序与全部恢复场景未完成 |
| [`fileInputPlanning.ts`](../../../apps/backend/src/agent/middleware/fileInputPlanning.ts) `planFileInputs` | 按原生媒体支持或本地映射工具选择 | 区分模型原生视觉与已验证入口的服务端视觉；不能硬改模型原生声明 |
| [`imageContext.ts`](../../../apps/backend/src/service/fileServices/imageContext.ts) | 已接通单图分析结果写入观察描述，沿用图片保留规则 | 产品看图路径与多图可靠关联未验证 |
| [`db/message.ts`](../../../apps/backend/src/db/message.ts)、[`observer.ts`](../../../apps/backend/src/service/chat/observer.ts) | `provider_continuation.serverToolCalls` 与本地调用分开保存；增量更新、清空和独立续接字段保留已有离线覆盖 | 真实重启全流程与受保护原始续接仍待完成及验收 |
| [`types.ts`](../../../apps/backend/src/core/middleware/types.ts)、[`timeline.ts`](../../../packages/protocol/src/timeline.ts) | 已传递执行归属、状态、结果与来源 | 跨端完整恢复仍需验收 |
| [`SenseCallBox.vue`](../../../apps/web/src/features/agent/chat/SenseCallBox.vue)、[`BrainServerTools.vue`](../../../apps/web/src/features/agent/settings/tabs/brain/BrainServerTools.vue) | 工具卡隐藏本地操作；设置按需只读展示能力来源、目录说明、此连接观察记录及完整列表未知，支持刷新 | 用户界面验收未完成；真实任务验证状态管理未完成 |
| [`modelCatalog.ts`](../../../apps/backend/src/utils/modelCatalog.ts)、[`brainCapabilities.ts`](../../../apps/backend/src/service/config/brainCapabilities.ts) `readBrainServiceCapabilities` | 区分原生媒体、按协议推荐的 `serverTools`、目录工具说明与已观察记录；Web/AI 共用读取；目录附加说明不写入大脑配置 | 型号推荐与已观察调用均不是当前地址/凭据的成功验证；`verification.status` 固定为 `not-verified` |
| [`serverToolScope.ts`](../../../apps/backend/src/utils/serverToolScope.ts)、[`serverToolObservation.ts`](../../../apps/backend/src/agent/provider/serverToolObservation.ts)、[`serverToolObservations.ts`](../../../apps/backend/src/db/serverToolObservations.ts) | 按服务商/有效协议/地址/完整 URL/模型/凭据引用及实际凭据隔离；运行配置保存摘要；只保存名称/状态/时间，调用结束与整次请求失败分开，最多查询 200 种且标记截断 | 观察记录不是验证记录；成功/失败的真实任务验证保存、失效和读取尚未实现 |
| [`loader.ts`](../../../apps/backend/src/core/mcp/loader.ts) `buildSensesForServer` | 已知 MCP 工具发现和注册 | 若纳入目录功能，补分页/变更刷新及完整性状态 |

权威说明归属：模型与文件选择见[模型能力](../../backend/agent/model-capabilities.md)，Provider 见[协议适配](../../backend/agent/provider.md)，消息契约见[Core 消息](../../backend/core/message.md)，MCP 见[MCP 接入](../../backend/core/mcp.md)，Web 见[工具渲染](../../frontend/renderer.md)。实施改变这些事实前先同步相应说明，本文不提前把设计写成已实现行为。

## 6. 建议一起落实的设计

以下是已确认的需求约束；部分已有代码，剩余范围见 §5 和 §7，不以建议文字代替实现证据。

### 6.1 调用记录与执行归属

- 为服务端调用保存独立记录，字段至少覆盖：供应商/协议、请求 ID、响应 ID、block index、调用 ID、真实工具名、参数、状态、结果、错误、来源资产、结果截断标记。
- 唯一标识应包含请求/响应范围，不能仅使用厂商调用 ID；不同轮次可能重复 ID。
- 本地普通工具若负责另发云端搜索请求，应分别记录外层工具 ID、内部请求 ID 和服务端调用 ID；本地负责发起不等于搜索在本地完成。结果按外层原 ID 交付，但不得把内部真实工具名或 ID 改写成外层调用。
- 状态区分“服务端开始调用”“取得成功结果”“明确失败”“中断/结果未知”。看到开始事件不等于成功；HTTP 成功不等于工具成功；没有开始事件但收到结果时保留孤立结果，不编造一次调用。
- `server_tool_use` 与关联结果只更新记录，**不进入本地 sense 调度、审批或重试**。同一响应若另有普通 `tool_use`，仍按现有本地执行规则处理。
- 本地调度必须同时核对结束原因和适配器给出的执行决定，不能看到普通 `tool_use` 就执行：本次 GLM 在 `end_turn` 且已返回同 URL 的云端读取结果时，普通 `WebFetch` 仅保留为“未在本地执行”，不得再次抓取；不同调用 ID 不合并、不补造结果。`tool_use` 结束且没有服务端完成证据时，才按真实本地工具注册和授权继续；无法明确归属的混合情况显示“待确认”，不能猜测对应关系或静默丢弃调用。
- 结果可为字符串、数组或对象；保留类型，不假设 `tool_result.content` 总是可解析 JSON。实际工具名原样保存，中文显示名是另一层映射。
- 未识别的服务端结果块保留可诊断的类型与受限数据，不能静默丢失，也不能因为名称相似而执行它。

### 6.2 流式、展示与多轮

- 按 block index 保存正文、思考、工具开始与工具结果的顺序，支持同一响应多次/交错调用；参数可能在开始块中完整给出，也可能由 `input_json_delta` 分段给出。
- 工具完成、最终回答失败和整个请求失败分别记录；断流后不把所有工具统一标为失败或成功，不自动重跑已完成调用。
- 成功样本同时返回结构化工具事件和介绍工具的普通文字。不能用宽泛正则删除正文。先保留正文；仅在供应商明确提供可靠关联时避免重复展示，未知情形以不丢内容为准。
- UI 展示真实工具名、执行位置、状态、参数与结果；未公开的内部步骤明确不可见。工具说明缺失时不请求本地同名工具的说明。
- 历史记录重开、WebSocket 重连和数据库恢复必须得到同一结果，不能只在实时流中可见。
- **展示存档不等于模型回传格式。** GLM 的服务端结果位于 assistant 响应，本地工具结果通常位于后续 user 消息，不能混写。多轮原样块、思考签名、供应商续接信息应按协议实测确定；切换供应商不得回放另一家的私有块。
- 不把服务端搜索/网页结果提升成系统指令。引用与来源链接保留，供用户判断回答依据。

### 6.3 图片与文件能力

- 模型原生能力保持原义；新增的服务入口能力应有验证状态和适用协议，不能仅凭型号名启用。
- 只有完成最小条件确认并验证 cheryNyxus 自有工具请求后，才为 GLM Messages 启用服务端看图路径。不要塞入不会执行的 Claude Code 工具充数；若名字映射确有必要，必须对应真实可执行工具并同步参数、授权与历史回传。
- 保留用户图片所在消息及顺序，沿用固定版本、预算、默认 1 个用户轮、过期替代和显式重读；服务内部分析不增加用户轮数。
- 描述来源区分用户文字、模型最终回答、实际视觉工具结果。只有关联可靠的分析结果才能记入该资产的视觉描述；多图无法一一关联时保存请求级分析，不能随机挂到其中一张图。
- 不以签名 URL 作为资产主键，不自动下载服务上传的副本代替原图；文件版本和请求内图片对应关系由本地记录维护。
- 继承角色已有禁用规则。若某入口无法禁用单项服务端工具，需要如实表示这一限制，而不是用不存在的本地审批声称能阻止服务内部执行。

### 6.4 工具目录与扩展

- 工具目录区分“官方说明”“MCP 实际发现”“响应中已观察到”“当前配置验证成功”，同时记录目录是否完整。
- 保存原始厂商名称与输入结构，显示名可单独提供；发现某个工具不等于启用它，模型目录接口也不是工具目录接口。
- MCP 分页/刷新复用当前连接管理；服务器暂不可用时显示最后一次列表及过期状态，不假装刷新成功。
- 先使图片、搜索、网页读取共用服务端记录与展示，再考虑 Chat Completions MCP、其他厂商内置搜索/代码执行等适配。不同协议单独解析，不把某家的字段强塞给其他厂商。
- 本轮没有证据支持 GLM Messages 自动内置 OCR、视频分析、沙箱或仓库工具；这些只列为候选，分别验证后才能加入可用目录。

### 6.5 用量、日志与恢复

- 保留供应商实际 usage；输入、输出、缓存命中和工具次数分别处理。不根据正文长度估算云端工具费用，不把未提供的计费项填成 0。
- 用户页面和诊断日志去除密钥、认证请求头、Base64 与签名 URL 查询凭据；多轮续接确需的受保护原始字段与展示副本分开保存，不能把脱敏字符串回传成有效 URL。
- 从已保存的脱敏事件建立离线验证，不靠再次收费获取同一测试样本。迁移保留会话、原图和凭据，已有消息缺少新字段视为“未记录”，不能补造历史云端执行。

### 6.6 可实施需求与范围

目标用户应当能直接问图片内容、要求搜索或提供网页链接，看到真实能力和结果，不必安装额外 MCP 才能使用已经验证的服务端图片/搜索/网页读取路径。功能状态必须区分“需求要求”“当前实测”“产品已实现”。本节为需求索引；各行为细节由上文对应章节维护，不再建立另一份需求副本。

| 编号 | 必须交付的结果 | 规则归属与验收 |
| --- | --- | --- |
| ST01 | 按服务配置、协议与模型分别表达原生媒体能力、云端工具能力及验证状态；配置改变不沿用另一入口的成功结论 | §4.3、§6.3；设置与 AI 配置读取相同结果 |
| ST02 | 图片与网页读取支持无额外 MCP 的服务端执行；不复制整套 Claude Code 身份或假工具作为产品条件 | §2、§6.3；真实 cheryNyxus 请求完成任务后才标可用 |
| ST03 | 可靠记录服务端开始、参数、结果、错误与未知状态，按真实 ID 关联；未知工具仍可保存和查看 | §6.1；流式/非流式、多个调用和不完整事件验收 |
| ST04 | 服务端已完成工具不在本地执行；处理 `WebFetch` 与 `webReader` 混合响应及结束原因 | §2.4、§6.1；同 URL、不同 ID 不合并，不重复抓取 |
| ST05 | 联网搜索必须取得真实结果和可核对来源，并能支持最终回答；不能把模型请求调用工具当作搜索完成 | §2.5；专用云端搜索通过，真实结果交付主会话通过；产品循环、搜索后读正文及原问题最终回答待验收，不得以本地搜索替代云端验收 |
| ST06 | 已有本地工具仍按真实注册与授权执行；若本地工具仅发起专用云端搜索，应分别显示发起与实际执行位置；真正本地搜索不能显示为云端内置 | §6.1、§2.5；保留外层和内部 ID；本轮无本地搜索，新增本地搜索服务不在范围内 |
| ST07 | 保留网页/搜索来源、输入、结果与错误；对无法访问、空结果、超时、截断和取消如实报告，不返回臆造摘要 | §6.1—§6.2；网页单样本已通过，异常路径待产品验证 |
| ST08 | 图片仍遵守固定版本、3 用户轮、到期说明、重读和角色权限，服务端分析只在关联可靠时写入描述 | §6.3；单图、多图、过期、重启、显式重读验收 |
| ST09 | 每个响应的正文/思考/工具顺序可恢复；刷新、重连、重启和历史回传不丢记录、不重复执行、不伪造普通工具结果 | §6.2；多轮及切换供应商验收 |
| ST10 | Web 工具展示说明由谁执行、状态、参数/结果/来源；未本地执行的普通调用不能显示“成功”，云端工具不能显示本地重试或审批按钮 | §6.1—§6.2；由用户进行最终界面验收 |
| ST11 | 工具目录可区分官方说明、MCP 发现、已观察调用和已验证能力；未知完整列表明确说明，不伪造工具输入结构 | §4、§6.4；已知 MCP 的分页/刷新如纳入产品目录必须完整覆盖 |
| ST12 | 实际用量、密钥脱敏、URL 凭据保护和受保护的历史续接分开处理；没有提供的用量不填 0 | §6.5；日志、页面与回传三条路径分别验收 |
| ST13 | 一次迁移保留历史、原图与凭据，不为旧消息编造云端工具；已有本地工具和其他供应商不受损 | §6.5、§7；集中回归与迁移验收 |

**主要操作过程：**

1. 用户或 AI 配置服务入口；系统显示其原生能力、云端能力的来源、验证状态及限制。没有可靠单项禁用能力时不能提供误导性的开关；只允许使用不执行该能力的入口或明确禁用该入口，不承诺能从客户端阻止云端内部动作。
2. 图片提问沿用文件选择规则；网页读取只需用户提供公开 URL；联网搜索需要问题及已验证可用的搜索路径。缺能力时说明缺失，不自动安装 MCP、不修改凭据、不悄悄换供应商。
3. 发送请求并按响应事件记录执行位置和顺序。云端执行在同一响应内返回结果；真实本地待执行调用走原授权流程；有最终结果的混合响应不重复工作。
4. 用户查看最终答案、工具结果和来源；若未成功，看到具体未完成步骤。重新打开历史仍可查看，不因重开会话重新发起搜索或抓取。

**本次不包含：** 视频素材生成与测试、专项视觉工具逐项测试、仓库工具、第三方 MCP 安装、公开图片托管、Managed Agents 产品接入、生产部署与真实 QQ 发送。独立图片/搜索/网页读取均有成功证据，但 ST05 的产品完整流程仍待实现及验收，不能称产品已支持全部云端能力。

**产品开发前需确定：** §7 的记录结构选择；图片最小成功条件及自有工具请求；搜索在主请求直接声明还是由真实工具发专用请求；私有块多轮回传格式。搜索可用声明已确认，不再重复定位为完全未知。其余已明确需求不重复询问。没有新证据时，不新增协议字段作为供应商既有事实。

## 7. 实施顺序、选择与完成条件

| 编号 | 工作与交付 | 前提/完成条件 | 当前状态 |
| --- | --- | --- | --- |
| S1 | 固定成功样本，逐步缩减工具，核对是否与工具名/结构有关 | 最小请求可复现；再验证使用真实 cheryNyxus 工具，不借用虚假定义 | 待验证，真实调用需新额度 |
| S2 | 确定服务端事件、能力来源、历史回传契约 | 更新权威说明；明确下面两种结构调整方式 | 已确认（使用一方案：保留本地执行结构，新增服务端记录） |
| S3 | Provider 解析、累积、保存与恢复 | 服务端事件不触发本地执行；流式/非流式/混合调用一致 | 独立记录与连接隔离观察已有实现和离线覆盖；完整顺序与受保护续接仍未完成 |
| S4 | 图片输入选择、分析关联、保留与重读 | 原生与服务入口能力不混用；多图/过期/重启正确 | 已实现服务端单图分析观察描述写入；S1 最小触发条件仍待真实额度 |
| S5 | Web 结果展示、设置能力来源与已知工具目录 | 用户看清谁执行、是否完成、目录是否完整；不重复展示和伪造可用性 | 工具卡、设置能力来源/已知目录及连接观察已有实现；当前始终“尚未验证”，真实任务验证管理未完成，界面待用户验收 |
| S6 | 搜索与网页读取验证，必要时补 MCP 发现能力 | 真实确认名称、参数、结果、错误；发现列表与 Messages 能力分开 | GLM 独立网页读取、专用搜索、真实结果交付主会话通过；GPT Responses `web_search`（Codex 配置重试）搜索通过，open_page 事件通过但抓取失败；产品代码已接通声明与解析；真实多轮待新额度 |
| S7 | 需求逐项核对后集中验证、更新使用说明 | 下方验收项完成，未验证项明确保留 | 离线测试与构建已完成，真实额度与人工界面验收待执行 |

### 存量契约改动方式：已确认决定

用户已明确选择**使用一方案（保留本地执行结构，新增服务端记录）**：保留既有本地 `senseCalls` / `role:'sense'` 执行与审批链路，新增独立的 `serverToolCalls`（持久化于 `messages.provider_continuation.serverToolCalls`，时间线与前端投影为 `executionOwner: 'server'`），不阻塞 `loop` / `canResume` / `spawnFinalize`，并在 `SenseCallBox.vue` 与 `LiteToolCallDetail.vue` 展示“由模型服务执行”徽章、来源引用及脱敏参数。

## 8. 验收矩阵与未决细节

| 项目 | 验证方式与通过标准 |
| --- | --- |
| 原图中性提问 | 无对象线索；正确主体/动作/场景与真实服务端分析记录一致 |
| 最小调用条件 | 一次只改一个条件；成功/失败请求均保存；产品工具请求通过后才开放配置 |
| 服务端/本地混合调用 | 按 block 类型、调用 ID 和结束原因分流；服务端 input_json_delta 不生成本地调用；本次 `WebFetch`+`webReader` 不重复抓取、不把不同 ID 合并成本地成功 |
| 异常事件 | 完整参数、分段参数、重复事件、未知块、孤立结果、明确错误、断流、取消、缺少结束标记均保留准确状态 |
| 完整历史 | 新问题、普通工具循环、服务端结果回传、切换供应商及压缩不会产生无效 tool_result 或重复调用 |
| 图片保留 | 多图与固定版本对应；到期不重发图片；重读恢复计数；重启不丢已验证描述 |
| 保存与展示 | 实时、刷新、重连、历史读取一致；签名凭据不展示；正文与工具卡不误删或误合并 |
| 工具列表 | 分页完整、变更刷新、连接失败可见；不把 MCP 目录当 Messages 全部工具 |
| 搜索与阅读 | 当前配置下的真实工具名/输入/结果/来源可核对，错误状态与 usage 不伪造 |
| 搜索结果交付 | 专用搜索结果按原普通调用 ID 交付；未执行查询明确标记；搜索摘要与页面全文分开，能继续读原文后给出最终答案；单次/总次数限制和取消不造成重复搜索 |
| 回归 | 既有本地执行、授权、普通 MCP、原生视觉与其他供应商保持正确 |

离线入口为 [`anthropic.test.ts`](../../../apps/backend/test/agent/provider/anthropic.test.ts)、[`serverTools.test.ts`](../../../apps/backend/test/agent/provider/serverTools.test.ts)、[混合调用测试](../../../apps/backend/test/agent/middleware/serverTools.test.ts)、[持久化测试](../../../apps/backend/test/db/serverToolCalls.test.ts)、[连接能力查询测试](../../../apps/backend/test/service/brainServiceCapabilities.test.ts)、[观察状态测试](../../../apps/backend/test/agent/provider/serverToolObservation.test.ts)、[请求流程观察测试](../../../apps/backend/test/agent/middleware/serverToolObservation.test.ts)及 [Web 能力读取测试](../../../apps/web/test/settings/brainServiceCapabilities.test.ts)。可复用命令归[文件能力验证](../../quality/verification/file-capabilities.md)。先完成本次实现核对，再集中类型检查、相关测试与构建。界面查看按项目约定由用户完成；文档检查通过不代表这些验收通过。

仍需回答的核心问题：具体哪类工具声明触发图片分析；是否支持明确启用/禁用；无工具模型如何表示该能力；非流式与多轮怎样回传；多图如何关联；搜索在产品中的声明位置、次数限制异常行为与后续读原文循环；混合普通调用与服务端调用是否存在官方关联字段；未知结果与引用如何保存。搜索声明、真实名称、结果字段与网页读取名称/参数已有实测，不再作为完全未知项。未得到证据前不固化为供应商规则。

## 9. 官方来源

- [官方文档索引][index]、[Claude API 兼容][claude]、[GLM-5.3 模型说明][model]。
- [视觉 MCP][vision]、[联网搜索 MCP][search]、[网页读取 MCP][reader]、[开源仓库 MCP][zread]。
- [服务端 MCP 调用][mcp-call]、[公开 OpenAPI][openapi]、[MCP 工具协议][mcp-tools]。
- [Managed Agents 工具][managed]：仅用于辨别另一套产品边界。

[index]: https://docs.bigmodel.cn/llms.txt
[claude]: https://docs.bigmodel.cn/cn/guide/develop/claude/introduction
[model]: https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3
[vision]: https://docs.bigmodel.cn/cn/coding-plan/mcp/vision-mcp-server
[search]: https://docs.bigmodel.cn/cn/coding-plan/mcp/search-mcp-server
[reader]: https://docs.bigmodel.cn/cn/coding-plan/mcp/reader-mcp-server
[zread]: https://docs.bigmodel.cn/cn/coding-plan/mcp/zread-mcp-server
[mcp-call]: https://docs.bigmodel.cn/cn/guide/capabilities/mcp-call
[openapi]: https://docs.bigmodel.cn/openapi/openapi.json
[mcp-tools]: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
[managed]: https://docs.bigmodel.cn/cn/managed-agents/tools
