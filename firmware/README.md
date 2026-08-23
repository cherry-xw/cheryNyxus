# MCU 参考固件（ESP32-C3 档）— lite profile 落地验证

> **状态：host/static 验证通过，未实机烧录验证。** 本目录对齐 [mcu-lite-api.md](../docs/mcu-lite-api.md) v3.3 的执行计时契约，目标是在 ESP32-C3 档设备上用固定内存显示当前问题、总计时、并行模型/工具步骤，并按键懒加载详情。可读性与契约正确性优先，非生产代码。

## 文件

| 文件 | 职责 |
|---|---|
| `main.c` | 应用入口：WiFi → /api/config → WS 连接 → 状态机主循环（hydration/事件等待/重连） |
| `device_config.h` | 设备镜像的编译期预算：帧、timeline 页、详情字符页、详情缓冲、ExecutionStep 容量 |
| `ws_lite.c/.h` | 最小 WS 客户端：解码 text RPC response 与 binary notification，显式声明 `maxFrameBytes=2048&turnDelta=0`，超限帧丢弃 |
| `json_lite.c/.h` | 零堆 JSON 扫描器；支持固定缓冲反转义与 UTF-16 code unit 计数，供 node.get offset 连续分页 |
| `rpc.c/.h` | RPC 请求-响应关联：Request.id 生成（连接内递增）、pending 表（≤4 并发）、超时 |
| `execution_state.c/.h` | 固定容量 `ExecutionStep` 数组：独立计时、并行 active、终态封口与最早完成项汇总 |
| `detail_pager.c/.h` | 正文/thinking/toolCalls 的当前页窗口；上一页/下一页不累积全文 |
| `model.c/.h` | `chat.open.state` 和实时通知解码，问题/root run/执行步骤/时钟偏移的单一设备投影 |
| `ui_stub.c/.h` | 串口模拟 OLED：问题+总计时、活动节点置顶、完成摘要；物理按键映射入口 |
| `test/` | MinGW/CMake host 回归、ESP-IDF 入口静态编译桩、零动态分配/默认预算检查 |

依赖：ESP-IDF ≥5.1（esp_websocket_client、esp_timer、nvs_flash）。JSON tokenizer 已内置；Arduino 框架可用 arduinoWebSockets 等价替换 ws_lite 层，其余模块不变。

## 与文档契约的对照（严格按 protocol.md / types.ts 字段名）

| 固件行为 | 契约出处 |
|---|---|
| 连接 `?profile=lite&v=1&maxFrameBytes=2048&turnDelta=0` | protocol.md「lite profile 连接级投影」§连接声明 |
| WebSocket text 解 RPC Response；binary 应用层 0x02 解通知；0x01 逐字正文拒绝并计数 | mcu-lite-api.md §3.8 |
| 白名单三分类：抑制名单跳过 / 精简·透传解析 | mcu-lite-api.md §3.2 矩阵（14 种处理事件） |
| hydration：chat.list → chat.open{rootChatId, knownTimelineRevision, executionStepLimit:16} → interaction.list | mcu-lite-api.md §3.6 |
| timeline 自愈：timelineUnchanged 短路 / 落后则 timeline.get 分页循环 | §3.6 + F9 |
| 审批：interrupt 全量（truncations 容错）→ approval.decide{interactionId, action, expectedRevision, commandId}；以返回 interaction.status 终结（不从 success 推导） | §3.5 C4 + protocol.md interactions 节 |
| 倒计时：remaining = deadlineAt − (now + Δ)，Δ 由 serverNow 校准（interaction.list 响应 + done 投影两个到达点） | §3.9 B-3 |
| run.updated 为工作态唯一权威（不从 turn.started 推断）；子 chat turn 折叠、子 done 忽略 | §3.2 B-1 + §7.6 |
| 错误：error.code 六码机读分支 + message 原样显示（不截 [tracingId] 前缀）；未知 code=unknown | D13/F11/D-a |
| commandId/messageId NVS 持久化，确认前不清除；UUID 级生成 | §1.3 C2 |
| 断线重连：指数退避 1s→60s 封顶±20% 抖动；重连后 chat.open+interaction.list | §3.6 |
| 重连判定「错过事件不重放不推演」：state 快照无 runId + revision 自愈完成 | §3.6 B-7 |
| 重连从 `state.run/runs[].startedAt + executionSteps` 恢复总计时和所有并行活动步骤，不从零计时 | §3.2「设备计时交互」+ §3.6 |
| 按键才调用 `chat.timeline.node.get{sections,offset,limit}`；正文/thinking/toolCalls 每次只驻留当前页 | protocol.md「chat.timeline.node.get」 |

## 设备配置

所有参数在 [device_config.h](./device_config.h) 中提供默认值，并可用编译器 `-D` 为不同设备生成独立镜像：

| 宏 | 默认值 | 作用 |
|---|---:|---|
| `MCU_MAX_FRAME_BYTES` | 2048 | WS 声明、接收与组装缓冲上限；范围 512–65536 |
| `MCU_TIMELINE_PAGE_SIZE` | 3 | `chat.timeline.get.limit`；服务端仍会按帧预算自动收缩 |
| `MCU_DETAIL_PAGE_CHARS` | 256 | `node.get.limit` 和上一页/下一页的 offset 步长 |
| `MCU_DETAIL_PAGE_BUFFER_BYTES` | `maxFrameBytes-384` | 当前详情页驻留字节数，不累积全文 |
| `MCU_EXECUTION_STEP_CAPACITY` | 16 | 固定 `ExecutionStep` 数组和 `chat.open.executionStepLimit` |
| `MCU_QUESTION_BYTES` | 160 | 顶部问题 UTF-8 截断缓冲 |

例如给 4KB 帧/24 步设备编译时传入 `-DMCU_MAX_FRAME_BYTES=4096 -DMCU_EXECUTION_STEP_CAPACITY=24`。容量是编译期常量，不会在运行时分配或扩容；调整帧上限时还应按目标响应复核 `JL_MAX_TOKENS`。

按键语义：`DETAIL_CONTENT`、`DETAIL_THINKING`、`DETAIL_TOOL` 打开对应第 0 页；`PAGE_NEXT/PAGE_PREVIOUS` 触发后续 `node.get`。GPIO/编码器驱动只需调用 `ui_input_dispatch`。

## 约束满足分析（静态，未实机验证）

### 堆与缓冲预算（ESP32-C3，Wi-Fi station 后可用堆 150–250KB）

| 项 | 大小 | 说明 |
|---|---|---|
| WS 接收缓冲（esp_websocket_client buffer_size） | 2049B | 2048B JSON 预算 + binary 应用层 1B type 前缀 |
| 帧组装缓冲（静态） | 2048B | 单帧完整 JSON 落地 |
| JSON token 工作区（静态） | ~5.1KB | `jl_doc` + tokenizer raw 各 160 token，串行复用 |
| LeanTimelineNode 环形缓存 | 20×328B≈6.4KB | 静态结构体数组，无 malloc |
| ExecutionStep 窗口 | 16×~240B≈3.8KB | 固定数组；活动优先，最早完成项进入计数/累计耗时 |
| node.get 当前页 | 1664B | 正文/thinking/toolCalls 共用一个缓冲，不保留前页 |
| RPC pending 表 | 4×48B | id/method/callback |
| 显示行缓冲 | 512B | 串口桩；真实 OLED 需 ~1–2KB |
| NVS 命名空间 | ~256B blob | commandId/messageId |
| **合计（静态/受控）** | **~22KB** | 含 WS 双缓冲、审批槽等；执行/详情/解析路径零动态分配 |

### 解析路径峰值分析（每帧）
1. WS 事件回调：text RPC response 直接作为 JSON；binary notification 先剔 0x02 类型字节。完整帧就地扫描，分片帧拼入静态 2KB 组装缓冲；任一路径超过声明预算都整帧丢弃并计数。
2. `json_lite`：jsmn 解析到静态 token 数组（上限 160，超限丢弃+记日志）；顶层取 kind/type；kind=response 时按 requestId 关联 pending；kind=notification 时按 type 走白名单。
3. 白名单命中处理函数按编译期键名表取 data 子字段（全部返回 jsmn 原位字符串指针 + 长度，**不拷贝**），仅 LeanTimelineNode/interrupt arguments 等需驻留的内容显式拷入固定槽（strncpy 带界）。
4. 峰值堆增量 = 0（全静态）；峰值栈 <1KB（无递归解析，嵌套由 jsmn token 数组天然限定）。

### 2048B 硬上限

服务端 lite 投影按 `maxFrameBytes` 自动收缩 timeline 节点与 executionSteps；固件同时显式请求 `timeline limit=3`、`executionStepLimit=16`，详情请求使用 `limit=256`。WS 组装缓冲严格等于设备声明值，任何违约帧会整帧丢弃并增加 `rx_overflow`，不会写越界。`turnDelta=0` 时 0x01 路径只计数，不进入正文状态。

步骤窗口溢出时先合并最早终态为“较早步骤 N 项 / 累计耗时”；running 节点不会被终态挤掉。若 16 个槽全部为 running 后服务端仍发送第 17 个 running（违反本连接 `executionStepLimit`），固件保持已有节点并增加显式 `active_overflow_count` 告警，避免内存越界。

### 解析正确性验证（host 侧，替代实机验证的一部分）
运行：

```powershell
cmake -S firmware/test -B build/firmware-host -G Ninja -DCMAKE_C_COMPILER=C:/Qt/Tools/mingw1310_64/bin/gcc.exe
cmake --build build/firmware-host
ctest --test-dir build/firmware-host --output-on-failure
```

host 回归覆盖：text/binary/分片/超限帧、JSON 反转义/UTF-16 offset、顺序工具切换、模型/工具实际顺序、多 Agent 并行 running、16 槽终态溢出汇总、`chat.open.state` 计时恢复、详情连续分页且只保留当前页。static 回归同时编译 `main/rpc/ws` 入口，并禁止有界路径调用 `malloc/calloc/realloc/free`。

## 已知限制（参考固件范围）
- UI 为串口桩，未接真实 OLED/编码器驱动；
- 未做 TLS（C3 档建议明文 ws + 局域网信任边界，mcu-lite-api.md §2/A-2）；
- turn.delta 可选订阅未实现——本镜像固定显式声明 `turnDelta=0`；
- chat.input.submit 发送路径实现但 UI 输入桩未接；
- **未实机烧录**：体积/峰值分析为静态推算（依据 T2 调研数据 + 文档契约的服务端保证），实机验证待后续。
