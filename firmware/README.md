# MCU 参考固件（ESP32-C3 档）— lite profile 落地验证

> **状态：参考实现（planned 静态验证），未实机烧录验证。** 本目录是 [mcu-lite-api.md](../docs/mcu-lite-api.md)（v3.1，P0 implemented）P1 第 4 项的设备侧参考固件，目标是验证 lite profile 在真实资源受限设备（ESP32-C3：可用堆 150–250KB、无 PSRAM、单核 RISC-V 160MHz）上的可用性：**≤4KB 缓冲解析全部 lite 帧**。可读性与契约正确性优先，非生产代码。

## 文件

| 文件 | 职责 |
|---|---|
| `main.c` | 应用入口：WiFi → /api/config → WS 连接 → 状态机主循环（hydration/事件等待/重连） |
| `ws_lite.c/.h` | 最小 WS 客户端封装（esp_websocket_client）：URL 组装 `?profile=lite&v=1&maxFrameBytes=2048`、binary 帧接收（0x02 JSON 解析 / 0x01 忽略计数）、握手 close(4001) 版本拒绝处理、发送 |
| `json_lite.c/.h` | 零堆 JSON 字段扫描器（jsmn 风格，编译期键名表）：顶层 kind/type/id/requestId 路由，data 子树按键取值，字符串原位引用不拷贝 |
| `rpc.c/.h` | RPC 请求-响应关联：Request.id 生成（连接内递增）、pending 表（≤4 并发）、超时 |
| `model.c/.h` | 会话模型：LeanTimelineNode 环形缓存（20 槽）、pending 审批/提问、run 状态、时钟偏移 Δ（serverNow 校准） |
| `ui_stub.c/.h` | 显示/输入桩（串口日志输出模拟 OLED；编码器/按键回调桩）——参考固件用，替换为真实 SSD1306/LVGL 驱动即可 |

依赖：ESP-IDF ≥5.1（esp_websocket_client、esp_timer、nvs_flash）+ jsmn（单头文件，放入 components/）。Arduino 框架可用 arduinoWebSockets 等价替换 ws_lite 层，其余模块不变。

## 与文档契约的对照（严格按 protocol.md / types.ts 字段名）

| 固件行为 | 契约出处 |
|---|---|
| 连接 `?profile=lite&v=1&maxFrameBytes=2048` | protocol.md「lite profile 连接级投影」§连接声明 |
| 收 0x02 帧解析 JSON；0x01 帧忽略（服务端已抑制，计数防御） | mcu-lite-api.md §3.8 |
| 白名单三分类：抑制名单跳过 / 精简·透传解析 | mcu-lite-api.md §3.2 矩阵（14 种处理事件） |
| hydration：chat.list{scope:"stage"} → chat.open{rootChatId, knownTimelineRevision} → interaction.list{maxItems:20} | mcu-lite-api.md §3.6 |
| timeline 自愈：timelineUnchanged 短路 / 落后则 timeline.get 分页循环 | §3.6 + F9 |
| 审批：interrupt 全量（truncations 容错）→ approval.decide{interactionId, action, expectedRevision, commandId}；以返回 interaction.status 终结（不从 success 推导） | §3.5 C4 + protocol.md interactions 节 |
| 倒计时：remaining = deadlineAt − (now + Δ)，Δ 由 serverNow 校准（interaction.list 响应 + done 投影两个到达点） | §3.9 B-3 |
| run.updated 为工作态唯一权威（不从 turn.started 推断）；子 chat turn 折叠、子 done 忽略 | §3.2 B-1 + §7.6 |
| 错误：error.code 六码机读分支 + message 原样显示（不截 [tracingId] 前缀）；未知 code=unknown | D13/F11/D-a |
| commandId/messageId NVS 持久化，确认前不清除；UUID 级生成 | §1.3 C2 |
| 断线重连：指数退避 1s→60s 封顶±20% 抖动；重连后 chat.open+interaction.list | §3.6 |
| 重连判定「错过事件不重放不推演」：state 快照无 runId + revision 自愈完成 | §3.6 B-7 |

## 约束满足分析（静态，未实机验证）

### 堆与缓冲预算（ESP32-C3，Wi-Fi station 后可用堆 150–250KB）

| 项 | 大小 | 说明 |
|---|---|---|
| WS 接收缓冲（esp_websocket_client buffer_size） | 2048B | = 声明的 maxFrameBytes（服务端据此截断，任何帧 ≤2KB 到达） |
| 帧组装缓冲（静态） | 2048B | 单帧完整 JSON 落地 |
| jsmn token 数组（静态） | 160×8B=1280B | lite 嵌套 ≤4 层，单事件 token 需求实测 <100 |
| LeanTimelineNode 环形缓存 | 20×~380B≈7.6KB | 静态结构体数组，无 malloc |
| RPC pending 表 | 4×48B | id/method/callback |
| 显示行缓冲 | 512B | 串口桩；真实 OLED 需 ~1–2KB |
| NVS 命名空间 | ~256B blob | commandId/messageId |
| **合计（静态/受控）** | **~14KB** | 零动态分配解析路径；堆余量 >130KB |

### 解析路径峰值分析（每帧）
1. WS 事件回调 → `frame_rx`：数据已在 2KB 接收缓冲；一次性帧（WEBSOCKET_EVENT_DATA 且 data_len==payload_len）直接就地扫描，**零拷贝**；分片帧拼入静态 2KB 组装缓冲（防溢出：offset+data_len>2048 即丢弃+记日志）。
2. `json_lite`：jsmn 解析到静态 token 数组（上限 160，超限丢弃+记日志）；顶层取 kind/type；kind=response 时按 requestId 关联 pending；kind=notification 时按 type 走白名单。
3. 白名单命中处理函数按编译期键名表取 data 子字段（全部返回 jsmn 原位字符串指针 + 长度，**不拷贝**），仅 LeanTimelineNode/interrupt arguments 等需驻留的内容显式拷入固定槽（strncpy 带界）。
4. 峰值堆增量 = 0（全静态）；峰值栈 <1KB（无递归解析，嵌套由 jsmn token 数组天然限定）。

### 4KB 硬上限检查（T27 实测校准）
固件声明 maxFrameBytes=2048。**T27 关键发现**：当前服务端 Response 投影只做字符串字段截断，**不按 maxFrameBytes 切分节点数组**（liteProjection.ts:441 `void profile // Response 帧预算归 T16`）——默认 20 节点页实测 ≈9KB/581 token，会超出任何 C3 档缓冲与 token 预算。固件侧对策（已实现）：**timeline.get 显式 `limit=3` + `nextCursor` 游标分页循环**（P1-② 已实现的 before/limit 游标），实测单页 1616B/121 token，2048B/160 token 预算内。chat.open 首页（服务端默认页大小）若超缓冲由 rx_overflow 计数暴露，固件随后走 timeline.get limit=3 自愈。**建议后端跟进**：T16 落地时让 Response 投影按 maxFrameBytes 自动收缩 limit（或 C3 档默认 limit 适配 2048B），使 chat.open 首页也天然有界。

超限防御：组装缓冲溢出 → 丢弃该帧 + rx_overflow 计数（契约 §3.7 保证，设备不指望但防御）。若部署改用默认 4096，仅需改 `LITE_MAX_FRAME`（并相应上调 JL_MAX_TOKENS：4096B 帧最多 ~530 token）。

### 解析正确性验证（host 侧，替代实机验证的一部分）
json_lite 算法在 host 上按 C 实现逐行移植后对真实契约帧全量测试：run.updated（15 token）/ done 含与不含 finalMessage（B-9 负向语义）/ interrupt 含转义引号 arguments（21 token，转义处理正确）/ timeline.patch 嵌套 upsert 节点（43 token）/ interaction.list 响应（38 token，deadlineAt/revision/payload.senseName/serverNow/hasMore 全部提取正确）/ chat.open 响应（73 token，toolNames 数组/nextCursor/nodeCount 提取正确）/ question batch 2 题版（59 token）——**32 项断言全部通过**；limit=3 分页页 1616B/121 token 预算内。

## 已知限制（参考固件范围）
- UI 为串口桩，未接真实 OLED/编码器驱动；
- 未做 TLS（C3 档建议明文 ws + 局域网信任边界，mcu-lite-api.md §2/A-2）；
- turn.delta 可选订阅（P1-1）未实现——默认关，符合 G1；
- chat.input.submit 发送路径实现但 UI 输入桩未接；
- **未实机烧录**：体积/峰值分析为静态推算（依据 T2 调研数据 + 文档契约的服务端保证），实机验证待后续。
