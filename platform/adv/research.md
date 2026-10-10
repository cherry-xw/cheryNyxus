# Cardputer-Adv 客户端基础选型调研

状态：调研进行中；硬件演示不等于客户端。目标是与 Web 同等业务能力的小屏实体键盘客户端，不移植 Vue 页面，不在设备重复实现后端 Agent。此次不修改 Backend、认证、现有 ESP32 平台或正式服务。

## 已确认与推荐的区别

已确认：目录 `platform/adv`；ESP-IDF 底层；设备为 K132-Adv；最终对齐 Web 客户端业务；具体界面和功能细节后续确定。

推荐但尚未批准成为产品定案：LVGL 9.2.2 + esp_lvgl_port 2.6.2，ESP WebSocket Client 1.6.1，原生 LCD/I²C 驱动，C/C++ 分层实现。版本选择来自下面实际构建结果，不依据“最新版一定兼容”。

## 设备边界

官方产品页确认 ESP32-S3FN8、8MB Flash、240×135 ST7789V2、56 键、ES8311、BMI270、SD；音频、键盘、IMU 使用共享 GPIO8/9 I²C。[1] 厂家 ESP-IDF 演示要求 v5.4.2。[15]

按未确认存在 PSRAM 的条件设计；8MB Flash 或 SD 容量不能替代可用 RAM。ESP-IDF 的 DMA、内部 DRAM、IRAM 各有分配条件，FreeRTOS 任务栈默认也占堆；静态 size 不能当实际运行剩余堆。[8]

RGB565 整屏像素缓冲需要 64,800 字节；双 20 行缓冲合计 19,200 字节（按 240×行数×2 字节计算）。推荐局部刷新和硬件旋转，不默认整屏双缓冲。网络回调不得直接改界面，使用有界事件队列，界面更新由单一任务执行或统一锁保护。官方 LVGL port 要求跨任务 LVGL 调用加锁。[2]

## 技术比较

| 项目 | 推荐 | 不采用为默认的原因 |
| --- | --- | --- |
| 系统与构建 | ESP-IDF 5.4.2 / CMake / Ninja / Component Manager | 已有实际编译基线，不再引入 Arduino 运行层或第二套 PlatformIO 构建 |
| UI | LVGL 9.2.2 + esp_lvgl_port 2.6.2 | 手绘字体与图元适合诊断，不适合长文、输入框、列表、焦点、统一主题；不运行 Vue/Chromium |
| 硬件抽象 | 原生 esp_lcd/I²C/I²S/ADC/SDSPI，局部采用成熟驱动 | M5Unified 也支持 ESP-IDF，并非只能 Arduino；但同时让 M5 与原生驱动初始化同一总线风险较高，不能简单混搭。[7] |
| HTTP | ESP-IDF esp_http_client | 支持 HTTPS、流读取及证书验证，不自行实现 HTTP。[17] |
| WebSocket | esp_websocket_client 1.6.1 | 官方组件支持 TCP/TLS；必须明确启用服务端证书验证，不能因 wss 名称就认为安全。[11][14] |
| 配置 | NVS 小配置，文件缓存后续评估 | NVS 默认不等于加密；生产凭据保护需单独确定加密、密钥和物理威胁边界。[21] |
| 字体 | 固定许可证的点阵字体，Flash 常用字 + 可选扩展字库 | UTF-8 支持不意味着已包含全部汉字，LVGL 内置 CJK 字体只覆盖有限字符。[10] |
| 中文输入 | 独立输入适配层，对接实体键盘 | LVGL 拼音插件默认绑定 lv_keyboard 对象，不能认为实体键盘自然获得输入法；字典与字库同样是容量开销。[20] |
| 桌面测试 | 无界面状态机/协议测试优先，模拟器可选 | 不未经授权启动 GUI、截图或操作真实页面；设备视觉由用户检查 |

完整 CJK 字库不宜在启动时复制进 RAM。按 7000 个 16×16 字形估算，未压缩纯位图 1bpp 是 224,000 字节，2bpp 是 448,000 字节，均未包含索引、度量和实际压缩效果；这是设计估算，不是最终字体大小。中文正文不能仅裁剪为 UI 常用字集合。字体源文件、生成工具版本、字符范围、许可证必须固定。[10]

## 实际兼容性探针

探针位于仓库外 `/home/chery/.hermes/cache/scratch/adv-framework-probe`，不修改现有演示程序，不烧录、不建立网络连接。仅构建 LVGL port 初始化、label、HTTP/WS handle 创建与释放的固件，验证依赖解析、API 编译和链接；不证明运行成功。

- 初次组合 ESP-IDF5.4.2 / LVGL9.2.2 / esp_lvgl_port2.9.0 / WS1.6.1：依赖解析通过，实际编译退出码2，port 引用了 LVGL9.2.2 未定义的 `LV_COLOR_FORMAT_RGB565_SWAPPED`。组件清单版本范围不足以保证所有组合可编译。
- 改为 esp_lvgl_port2.6.2，其他版本不变：完整构建退出码0，`idf.py size` 退出码0，应用 bin 556,592 字节。2.6.2 声明支持 IDF>=5.1、LVGL>=8,<10。[19]
- size 报告 DIRAM 静态使用123,139字节，余218,621字节；其中 .bss72,296、.data10,624、.text40,219。该数字不是 Wi-Fi/TLS/屏幕运行后的可用堆。探针未加载中文字体、未初始化 Wi-Fi、未注册实际显示、未收真实协议帧。
- 原硬件演示构建产物为319,216字节，只能作为当前编译基础，不可据此推算最终客户端容量。

下一项验证应包括 Wi-Fi+TLS+LVGL 局部刷新组合的最小运行固件、实际最大连续堆、任务栈高水位、帧大小/分页/超时/断线恢复、中文字体和输入。正式分区表需要在完整体积估算后决定是否预留双 OTA 应用槽与字体分区，不直接照用当前1MB单应用默认布局。

## Web 功能与设备适配矩阵

以下是源码调研结果，不表示设备功能已实现。Web 的“精简视图”是界面模式，`profile=lite` 是连接的数据投影，两者不是同一功能；`apps/web/src/features/lite/liteStore.ts` 不创建 MCU socket，`apps/web/src/services/chatApi.ts` 的 `getTimelineNode` 使用普通应用连接。

| 能力 | 复用入口 | 设备工作与风险 |
| --- | --- | --- |
| 预设、会话创建、任务列表、输入及排队撤回 | [chatApi](../../apps/web/src/services/chatApi.ts) `createAgent`、`submitChatInput`、`withdrawChatInput`；[agentApi](../../apps/web/src/services/agentApi.ts) `listTasks` | 重写小屏界面、草稿和确认状态；命令确认不是模型执行完成 |
| 中止、继续、子 Agent 控制 | chatApi `resumeRun`、`resumeTree`、`abortTask`；[方法目录](../../packages/protocol/src/rpc.ts) | 使用现有 `chat.run.resume`，不采用旧 `chat.resume`；子任务结束不等于整体结束 |
| 运行计时、模型与工具步骤 | [liteProjection](../../apps/backend/src/service/websocket/liteProjection.ts) `projectStateSnapshot` | 有界窗口、任务关联及缺项说明；掉线后重新获取权威快照，不凭本地计时推测结果 |
| 历史、正文、思考、工具结果 | chatApi `getRootTimeline`、`getTimelineNode`；liteProjection `projectLiteNodeDetailResponse` | 单 section 分页可复用；长文只保留当前页；代际历史 `generation.get` 尚非统一有界出口 |
| 分支、完整树与子任务关系 | chatApi `previewBranch`、`createBranch`、`activateBranch` | lean 节点不包含全部关系，不能以缺失数据重建完整树；改成逐层页面不是删业务 |
| 审批、提问、待办收件箱 | [interaction handler](../../apps/backend/src/service/interaction/handler.ts) `handleList`、`handleApprovalDecide`、`handleQuestionAnswer` | 输入、批量答题与确认需重写；当前待办窗口无后续页游标，审批截断不等于充分依据 |
| 工作区文件、文件引用、Git | [workspace handler](../../apps/backend/src/service/workspace/handler.ts) `listFiles`、`readFile`、`gitStatus` | 文件列表/正文需小页、分段接口；不能把一次2MiB读取塞入 MCU；保留引用和危险操作确认 |
| Terminal | [terminal handler](../../apps/backend/src/service/terminal/handler.ts) `registerTerminalHandlers` | 需要有界输出和设备终端解释器；当前发送旁路不受 lite 裁剪 |
| 图片、音频、视频与附件 | agentApi `uploadMedia`；[媒体输入](../../apps/web/src/features/agent/composables/useComposerMedia.ts) | 复用资产契约，采集、缩放、播放和解码另选；不承诺任意高清视频本机播放，不默认跨端接力替代设备操作 |
| 设置、角色/大脑/工具组、技能、插件、MCP、Hooks | agentApi `getConfig`、`previewConfig`、`saveConfig`；[设置说明](../../docs/frontend/settings.md) | 现有业务RPC可复用，但全量配置、列表、预览结果需分页；保存版本与实际生效状态分开显示 |
| 归档、永久删除、上下文与用量 | chatApi `listArchives`、`contextUsage`、`promptSnapshot` | 保留业务语义和删除确认；大数据分页，图表改为简明状态与明细 |
| 多窗、桌宠、Pixi树、浏览器工具渲染 | [前端入口](../../docs/frontend/README.md) | 不复用 Vue/Pinia/Pixi/xterm 源码；设备页面、焦点与导航重新设计，业务能力不擅自缩减 |

## 协议核对与阻断项

基于 [连接入口](../../apps/backend/src/service/websocket/index.ts)、[数据投影](../../apps/backend/src/service/websocket/liteProjection.ts)、[传输编码](../../apps/backend/src/service/websocket/transport.ts) 与公共方法目录：

1. lite 是数据投影，不是权限控制。正常鉴权后仍可调用已注册管理RPC，不能用 profile 声称设备具有最小权限。
2. RPC请求/响应是 JSON 文本；通知可能是文本或 `0x02 + JSON`；chunk 被 lite 抑制。必须处理分片、未知类型与明确长度限制。
3. `projectLiteResponse` 对非 node.get 错误、无 rootTimeline/state/currentState 的成功结果直接返回。`shrinkLiteResponseToBudget` 缩减部分步骤和节点后仍可超限返回，未设最终兜底。未知通知透传。当前“所有帧不超过 maxFrameBytes”不成立；扩大缓冲不是完整解决。
4. 待办 `maxItems` 只限制窗口，`hasMore` 不提供浏览下一页的游标；问题批次、审批返回和参数可能超预算。安全批准必须能看到完整所需依据，不能仅凭截断摘要。
5. `chat.open` 的 schema 没有通用 before/limit 字段，使用 open 首页再 `timeline.get` 翻页；generation.get 返回完整顶层 nodes/edges，不自动命中 rootTimeline 投影。
6. 配置状态通知目前跳过 profile 连接；设置业务必须主动读回生效状态或补通知，不能用保存成功冒充生效。

推荐仍复用同一业务协议，但在后续实施前明确后端配套范围：统一完整信封帧预算、未知通知规则、文件分段、配置资源分页、待办游标、审批详情与代际历史分页。此调研没有修改这些后端行为，也没有执行相关业务测试。

## 实际认证与连接方案

源码入口：[Web认证](../../apps/web/src/stores/auth.ts)、[后端认证](../../apps/backend/src/service/auth/index.ts)、[地址构造](../../apps/web/src/services/platform.ts)、[WS入口](../../apps/backend/src/service/websocket/index.ts)、[Manager认证](../../apps/manager/src/auth.ts)、[Relay转发](../../apps/relay/src/server.ts)。

- 后端当前是 challenge → login → access/refresh token，并非 RSA 登录或标准 JWT。challenge 的 nonce 混淆不能替代 TLS；nonce 与密文同时暴露时可还原密码。设备使用 HTTPS，不沿用旧参考固件明文登录。
- Manager Cookie 与后端 token 是不同身份系统，不能认为 Manager 登录可以通用代理设备业务。设备不要使用仅本机可用的管理密钥或 QQ 专用凭据。
- WS 开启认证时先检查 Origin，再校验正常身份；设备应配置受认可 Origin 与 Bearer，不通过伪造 QQ 身份规避检查。令牌优先放头，避免查询参数进入URL日志。
- 后端直连与反代入口必须区分 local/remote；反代经过 loopback 不应触发远程免认证。当前源码结构的检查不等于已经验证生产部署安全。
- Relay 转发存在删除 Authorization、WS 固定 `/ws` 未保留 token/profile 参数、默认 unavailableTargetAdapter 等缺口；未验证实际部署是否另有适配层。不能直接作为首轮设备可靠连接方案。
- 未发现 MCU 配对码、设备独立凭据与完整撤销闭环；初始认证用户拥有管理权限。`verifyAuthToken` 未限制 access 类型、logout 未撤销令牌，属于后续安全审查项，不允许设备依赖这些宽松行为。

推荐首轮验证经安全入口的直接 HTTPS/WSS，Relay及设备配对另作明确决策。前置：Wi-Fi配网、DNS、地址前缀、认可Origin、CA及主机名校验、可信校时、401刷新与429退避、按目标地址隔离令牌存储。开发期不默认烧写不可逆安全 eFuse；发布前明确安全启动/Flash加密/NVS密钥与遗失撤销策略。[17][21]

## 推荐框架结构与恢复规则

建议在 `platform/adv` 分出 ESP-IDF components：`adv_board`（屏幕/键盘/电源/共享总线）、`adv_transport`（Wi-Fi/HTTP/WSS/证书）、`adv_protocol`（请求关联/分页/版本/预算）、`adv_state`（任务/会话/草稿/交互投影）、`adv_ui`（LVGL页面/焦点/输入）、`adv_storage`（NVS/缓存/资源）。这是推荐划分，尚未创建空壳目录或重复后端业务。

C驱动适配 + C++业务封装可选；第一轮避免异常驱动控制流、大量 std::string/JSON树复制。JSON选型先比较现有 `platform/ESP32/json_lite.c` 与 IDF cJSON：前者有有界/UTF-16游标基础但不能直接假设适合全部设置和媒体，后者容易使用但必须控制输入体积、嵌套、分配和生命周期。状态不依赖LVGL对象；网络与UI之间传有界事件/句柄，不共享无锁JSON对象。

待确认命令保留原ID与稳定参数，不超时就生成新ID重发副作用。后端请求记录有保留窗口，超出窗口需查业务状态。重连刷新令牌在获取需鉴权config之前，重新订阅与取快照；通过revision/游标纠正缺口，不重放已失效审批或自行宣布任务成功。

## 当前完成与下一阶段验收

已完成：官方资料和Web/后端源码核对、功能及协议缺口矩阵、候选版本真实依赖解析/编译/size、框架与安全推荐。未完成：正式LVGL屏幕集成、Wi-Fi认证实测、中文字体产物、实体键盘中文输入、完整客户端、后端分页补强及实机验收。

基础准备下一阶段应整体完成后统一验证：固定manifest与lock；屏幕局部缓冲和键盘适配；Wi-Fi/时钟/可信TLS最小连接；配置和凭据空态；状态/协议有界队列；命令恢复与失败演示；heap/最大连续块/任务栈指标。对该组合的构建验证不等于这些工作已经完成。

待用户决定（后续，不阻止本轮调研交付）：采用推荐版本与分层方案；实际设备连接入口与账号授权方式；后端小帧/分页补强范围；中文输入与媒体/Terminal体验；OTA分区和设备遗失安全策略。

## Sources

[1] https://docs.m5stack.com/zh_CN/core/Cardputer-Adv
[2] https://components.espressif.com/components/espressif/esp_lvgl_port
[7] https://components.espressif.com/components/m5stack/m5unified
[8] https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/system/mem_alloc.html
[10] https://docs.lvgl.io/9.2/overview/font.html
[11] https://docs.espressif.com/projects/esp-protocols/esp_websocket_client/docs/latest/index.html
[14] https://components.espressif.com/components/espressif/esp_websocket_client/versions/1.6.1/dependencies
[15] https://raw.githubusercontent.com/m5stack/M5Cardputer-UserDemo/CardputerADV/README.md
[17] https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/protocols/esp_http_client.html
[19] https://components.espressif.com/components/espressif/esp_lvgl_port/versions/2.6.2/dependencies
[20] https://docs.lvgl.io/9.2/others/ime_pinyin.html
[21] https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/storage/nvs_encryption.html
