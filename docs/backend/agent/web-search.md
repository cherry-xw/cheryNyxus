# 网络搜索与网页读取

本模块提供只读 `web_search` 与 `web_fetch`，不生成最终答案、不执行网页指令、不写长期记忆，也不依赖 QQ、Manager 或 NapCat。

## 接口与入口

- `apps/backend/src/agent/sense/webSearch.ts`：模型可见 schema 和 sense 工厂；经内置注册表及显式 `sense_groups` 选择。
- `apps/backend/src/agent/sense/web/runtime.ts`：Provider 注册、确定性选择、取消/超时、结果清洗与预算。
- `apps/backend/src/agent/sense/web/searchService.ts` 与 `browser-search.mjs`：服务响应解析、内部降级、搜索代理与临时浏览器；浏览器只读取搜索列表，不读个人资料，不绕过验证码。
- `apps/backend/src/agent/sense/web/fetch.ts`：公开 HTML/纯文本读取，逐跳 SSRF 校验、响应限制和脚本/样式清洗。

输入为非空 `query`（最多600字符、75个空白分隔词），可选 `limit`（1–10，默认5）与 `max_output_chars`（512–12000，默认8000）。不向模型暴露密钥、端点或 Provider 私有参数。

输出为 JSON observation：`ok`、`provider`（无法选择时为 null）、`observedAt`、`truncated`、`trust: untrusted_external_data`、`results`；成功条目含 title/url/snippet/source，可选 publishedAt。错误包含固定 `error.code/message`，不含原始异常或响应正文。JSON 总字符数计入预算。链接仅允许无内嵌凭据的 HTTP(S)，去掉 fragment 后去重；不跟随链接。文本去除标记及控制字符，只作为数据，不能覆盖系统指令。搜索不返回 hash，避免动态结果折叠。

## 配置与启用

本模块通过 AnySearch、Parallel MCP、Exa MCP 和无头浏览器搜索（Bing 后百度）组成自动降级链，不再注册 DuckDuckGo。搜索设置由 Backend 持久化于 `.chery/web-search.json`，经受保护的 Manager 工具设置入口读写；设置包括服务顺序、搜索专用代理开关与无凭据代理地址，下一次搜索生效，不影响模型和其他工具。默认顺序为 AnySearch → Parallel → Exa → 浏览器。匿名服务有额度限制，HTTP 200 也可能是限额提示，不能当作有效结果。

- 每个远程服务最多12秒、浏览器最多40秒、整体最多80秒，响应限1 MiB。失败、限额或空/无效结果会尝试下一服务，取消立即终止。缓存按设置版本隔离。运行器仍按每分钟10次限制逻辑搜索请求，缓存/replay不发网络。实时可用性必须通过实际查询验证，匿名额度不保证永久可用。

浏览器搜索使用 Playwright Node API；运行环境需提供 Node `playwright` 包及其 Chromium 浏览器（例如安装依赖后执行 `pnpm exec playwright install chromium`）。本项目搜索代码不依赖 Python 或 TS 运行器：Backend 将 `.mjs` 以 `?raw` 导入，用 `process.execPath --input-type=module -e` 执行，通过 stdin/stdout 交换 JSON。浏览器以 headless 模式启动，仅在搜索代理开启时显式设置代理，各搜索页导航12秒、等待结果6秒，禁用下载并在退出时关闭临时 context/browser。缺少包或浏览器时返回 `provider_unavailable`，不会回退到 Python。当前 package.json 尚未声明 Playwright，部署前需补齐依赖。

## 扩展与错误

`WebSearchRuntime.register` 接受受信任的后端 Provider，重复 id 拒绝；`availability()` 同步本地检查，禁止发网络请求；`search(input, signal)` 必须支持取消并自行限制传输字节。Provider 代码拥有宿主权限，不是沙箱扩展。

选择顺序：显式指定 id 优先；否则只有一个 ready 才执行，多 ready 返回 `ambiguous_provider`，不以注册顺序选择。零注册返回 `no_provider`，缺配置返回 `configuration_missing`，已注册但不可用返回 `provider_unavailable`。异常状态分别为 `invalid_input`、`network_error`、`timeout`、`cancelled`、`authentication_failed`、`rate_limited`、`invalid_response`、`response_too_large`。检查函数抛错视为不可用；未分类异常只返回固定网络失败信息。

SenseRuntimeContext.signal 接收当前 pipeline 的取消信号。运行器在超时/取消时停止等待，同时取消底层请求；即使扩展忽略 signal，也不能阻塞 Agent。取消原因不回显。

## web_fetch 安全边界

`web_fetch` 输入为无凭据的公开 HTTP(S) URL，可选 `max_output_chars`（512–100000）。只允许默认 HTTP/HTTPS 端口；URL 凭据、其他协议和自定义端口直接拒绝。每次请求和每次重定向都会重新解析 DNS，并拒绝 loopback、private（含 Docker 默认网段的 172.16/12）、link-local、CGNAT、benchmark、组播地址与 IPv6 文档段（2001:db8::/32）；IPv4 RFC 5737 TEST-NET 三个文档段（192.0.2.0/24、198.51.100.0/24、203.0.113.0/24）已拒绝，返回 `forbidden_address` 且不进入 Transport；重定向最多5跳。请求不发送 Cookie、Authorization、JavaScript 或压缩协商，响应只接受 `text/html` 与 `text/plain`，下载最多400 KiB，超时15秒。HTML 中的 script/style/noscript 和标签会移除，结果标记 `untrusted`、来源 URL、观察时间、字节数和 `truncated`。

所有失败均返回固定结构化错误，不返回部分正文；取消、DNS、类型、大小及网络错误均 fail-closed。Transport 可在本地 fixture 测试注入，生产默认使用 Node HTTP 客户端。

生产 HTTP 客户端固定连接到已验证的 DNS 地址；自定义 lookup 在 Node 请求 `all: true` 时返回地址记录数组，单地址模式返回地址与实际 IPv4/IPv6 family，不重新解析 DNS，也不使用无效的 family 0。

## 验证与边界

定向入口为 `apps/backend/test/agent/sense/webSearch.test.ts`、`apps/backend/test/agent/sense/webSearchFlow.test.ts`。覆盖输入、选择、预算、错误、凭据、取消和真实 Agent 下一轮消息回填。测试使用明确标注的本地响应，不证明真实搜索服务、部署或用户验收完成。`apps/backend/test/agent/sense/webFetch.test.ts` 覆盖协议/凭据、DNS/IP、逐跳重定向、内容类型、大小和正文清洗。独立安全专项断言（telemetry 脱敏、注入不可变性、缓存隔离、取消竞态、malformed provider、SSRF 矩阵扩展）见 `apps/backend/test/agent/sense/securityBoundaries.test.ts` 与 `apps/backend/test/agent/middleware/securityInjection.test.ts`。
