# MCU lite API 修订预研清单（T6+T4 汇总）【已执行，归档】

> 状态：**已执行归档**。本清单全部条目已于 T8 一次性改版进 docs/mcu-lite-api.md（v3，含 T7 三修正+两建议与 captain C/D 组增补）。保留本文作为修订过程记录，主文档为准。
> 来源：T6 设备复核（6 条件 + R1-R7）、T4 对抗评审（A-2/3/4、B-1~B-11、R1-R10、裁定建议 + 新增决策点）。
> 本清单把两份复核的修订要求合并去重，映射到主文档章节，并解决 T4 与 T3 的决策点编号冲突。

## 1. T6 六条修订条件 → 文档落点

| T6 条件 | 主文档落点 | 修订内容（定向结论） |
|---|---|---|
| ① LeanTimelineNode 低估 1.7 倍 | §3.3 summary 注释 + 预算行；§1.2；D5 | summary 改**字节定义**：≤180B（≈60 中文字符，OLED 4 行）；单节点预算改标 300–500B；D5 改为「180B 字节定义，参数化」 |
| ② question batch 超 2KB | §3.7-3；D8 | D8 裁定为 **schema 硬校验**；options.description 截断 ≤60B 或 lite 投影剔除 description（推荐剔除——description 是 tooltip 用，低档无 hover）。注意与 T4 B-4 的 D8 双层方案合并，见 §3 合并裁定 |
| ③ 响应帧无有界约束 | §3.7 扩展（新增小节「RPC 响应有界」）；§3.6；D6 | §3.7 从「推送事件」扩展为「全部出站帧（事件+RPC 响应）」：timeline.get/open **默认 limit=20 分页（P0）**（T6 结论，captain 已定向，强于 T4 的 nodeCount 预告折中——nodeCount 仍保留作设备预判）；interaction.list lite 投影默认 maxItems≤20 + hasMore 游标分页（C1：现状 LIMIT 500 静默截断无 hasMore，必须补）；收件箱 payload 内审批 arguments 同样截断+引用（T6-R7，与事件面 §3.7-2 同策略） |
| ④ 截断阈值未扣信封 | §3.7 各条 + D2 | 服务端截断统一按 **maxFrameBytes − 256B**（信封+JSON 结构开销）计算：finalMessage 截 3.75KB（4KB 档）、interrupt arguments 同理；§3.4 注释同步 |
| ⑤ G6 缓冲矛盾 | §1.2 G6 行 | 措辞改「接收缓冲 = maxFrameBytes（C3 默认 4KB，堆内可承受）；设备可声明 maxFrameBytes=2048 换取服务端更狠截断」——消除与 ≤4KB 单事件的矛盾 |
| ⑥ 自由文本降级缺失 | 新增 §3.9「低档交互降级」 | 内容：freeText 题显示题干+选项、用 answer.cancelled=true 逐题取消或转交 PC/手机端；chat.list 的 pendingQuestionCount 供设备识别「有待办可转交」并提示用户 |

## 2. T4 前置条件与 B 项 → 文档落点

| T4 项 | 主文档落点 | 修订内容 |
|---|---|---|
| (i) D3 字段级智能截断（**安全级，最高优先**） | §3.7-2；D3 | 推翻「头部截断」：投影层保留**全部键名与短字段全文**，仅对超长单字段截断并附 `{field, contentLength, contentHash}` 引用（write_file 的 path 全文保留、content 截断+可拉）。决策结构完整，仅体量受限 |
| (ii) 子 chat 事件路由语义 | §3.2 新增小节「子 chat 事件路由」 | 三条规则：①子 chat 的 done/staged 抑制或投影为纯状态 {chatId, finished}——最终回复只认 rootChatId 维度的 done；②子 turn.started/completed 透传但设备按 chatId≠rootChatId 折叠为「子任务运行中」；③role_reply 去重见 D15 |
| (iii) role_reply 去重 | D15（新编号，原 T4-D13） | 推荐 **b) 抑制 role_reply**，子任务完成态只靠 timeline patch 的 return lean 节点（更符合 G1/G2，无对齐键推断风险；感知延迟毫秒级可忽略） |
| (iv) node.get 提前 P0 | §5 分期表；D16（原 T4-D14） | node.get（完整版：content/thinking/toolCalls + offset/limit 分段）**移入 P0**——G5 是原则级承诺非体验项；消除 P0 期 >4KB 回复全文不可得（T4-R4 + T3 §7.5 自认缺口） |
| (v) state 快照 lean 定义 | §3.2 矩阵补行 / 新 §3.x | chat.open 的 state（pendingInputs/activeTurns/runs/questionBatches/runningTools）逐对象给 lean 字段集：activeTurns 不带累计文本（仅 {chatId,turnId,messageId,createdAt}）；questionBatches 不带题干（仅 {batchId,interactionId}——详情走收件箱）；runs 原样；pendingInputs 保留 content 但计入响应预算 |
| A-2 F11 只对半条 | §3.2 error 行 + §4 F11 行 | 引用 error-conventions 全文：message 含前置 [tracingId] 码，设备**原样显示不得截前缀**、不得自行重生成文案 |
| A-3 doc-first 顺序 | §5 P0-⑦ 改为前置步骤 | 顺序固化：T5 schema → protocol.md 补录 interaction.* → lite 文档定稿 → 任何代码。P0-⑦ 拆为「P0 前置」 |
| A-4 方案 B 漂移种子 | §2 方案 B 定位段 | 加约束句：/api/lite/* 落地时必须复用同一 handler 与投影函数，禁止独立实现 |
| B-3 时钟校准 | §3.4 DoneLeanData；§7-3 | serverNow 加入 done 投影字段集（每轮免费校准）；校准误差容忍写成规范条款（建议视觉 ≤5s、审批 deadline 以服务端为准） |
| B-7 重连状态机 | §3.6 补「重连判定规则」 | 明确：错过 done/run.updated 后「已结束」唯一判定 = chat.open state 无该 runId 且 revision 自愈完成，不依赖重放；unchanged→等待 / revision 落后→全量后等待 / state 含 activeTurns→恢复运行中 UI。附「同时观察 root 数建议 ≤1–2」（内存翻倍理由）→ 见 D19 |
| B-8 interaction.changed 放大器 | §3.2 该行；D18 | 投影加 presetId（+4B/帧），设备据此判断是否需重拉收件箱 |
| B-9 done≠必有回复 | §3.4 加负向语义注 | done 可能无 finalMessage（loop 结束在审批 yield/sense 循环）；无 finalMessage 的 done 只更新状态。逐条列全负向语义 |
| B-10 node.get 滥用阀门 | §3.5 node.get 行 | 标注「低频用户触发」语义 + 预留服务端节流位（注释性规范，不做限流） |
| R6 首刷预判 | §3.5 chat.open 行 | 响应保留 nodeCount（窗口内节点总数）供设备预判分批拉取 |
| D10 微调 | §3.2 consumed 行 | consumed 投影附 msgId（T4 裁定：去 content 但附 msgId 供对齐） |
| R10 投影热路径 | §3.1 或 §3.7 注 | 实现先判 profile 再构建（避免双份序列化）；文档注明 |

## 3. T6/T4 重叠裁定的合并

- **D8（question batch）**：T6 说 schema 硬校验 + description 截断；T4 说双层（上游软约束+投影层硬保证，硬拒上游会卡死既有对话）。**合并结论：双层**——上游 ask_user_question 软提示（超限建议拆题，不硬拒）；lite 投影层硬保证（批次超 2KB 时 label 截断/分页引用、description 剔除）。T6 的 description 处理归入投影层动作。
- **D6（分页）**：T6 要求 limit=20 默认分页提前 P0；T4 折中 nodeCount 预告。**合并结论：两者都做**——P0 默认 limit=20 分页（captain 已按 T6 定向）+ nodeCount 预告（P0 一并给，成本一行字段）。
- **D3**：T6 未直接评；T4 明确否头部截断改字段级。**结论：字段级智能截断**（安全优先级最高）。
- **D9（键名短化）**：T6 实测确认维持不做（热点 144–251B 达标、有效载荷 >60%）——与 T3/T4 一致，闭环。

## 4. 决策点编号统一（解决 T3-D13/D14 与 T4 新增 D13–D17 冲突）

T3 原有 D13（错误表达）/D14（版本策略）保留原号；T4 新增五点顺延：

| 编号 | 议题 | 推荐结论 | 状态 |
|---|---|---|---|
| D1–D12 | （原 T3） | 见主文档 §6；T4 裁定：D1/D2/D4/D7/D9/D11/D12 ✅ 同意；D5 改字节定义（180B）；D6 双做（分页+nodeCount）；D8 双层；D10 附 msgId；D3 改字段级截断 | T4 已裁定，D3/D8 需用户最终确认 |
| D13 | 错误表达（原 T3） | 最小机读 code 集（INTERACTION_STALE 等），message 面向用户/code 面向设备 | 待用户确认 |
| D14 | 版本策略（原 T3） | ?profile=lite&v=1 字段集冻结只增不改 | 待用户确认 |
| D15 | role_reply 去重（T4） | 抑制 role_reply，完成态靠 return lean 节点 | T4 推荐 b，待确认 |
| D16 | node.get 提前 P0（T4） | 完整版提前 P0 | T4 推荐 a，待确认 |
| D17 | 子 chat 事件处理（T4） | 子 done 抑制/纯状态化 + 子 turn 折叠 + 路由规则文档化 | T4 推荐 a，待确认 |
| D18 | interaction.changed 加 presetId（T4） | 加 | T4 推荐，低成本 |
| D19 | 多 root 并发订阅上限（T4） | 文档建议值 1–2 | 规范性建议 |

## 4b. 第二批修订项（captain 最终清单 C 组 + D 组新增，T7 前并入）

| # | 修订项 | 主文档落点 | 内容 |
|---|---|---|---|
| C1 | interaction.list hasMore | 并入 §3.7 响应帧扩展（上表③） | lite maxItems≤20 + hasMore；现状 LIMIT 500 静默截断必须消除 |
| C2 | messageId/commandId NVS 持久化规范 | 新增设备规范条款（§3.5 或 §3.9 附近） | 断电重发去重依赖全局唯一 id：messageId/commandId 须持久化在设备非易失存储（NVS/littlefs），发送成功确认前不清除——掉电重启后同 commandId 重发可安全幂等去重 |
| C3 | D13 错误码扩至 6 | §6 D13 | 在原 4 码（INTERACTION_STALE/ALREADY_RESOLVED/COMMAND_CONFLICT/INPUT_QUEUE_FULL）基础上 + `PROFILE_VERSION_UNSUPPORTED`（D14 未知 v 拒绝需机读可判）+ `RATE_LIMITED`（node.get 预留节流位） |
| C4 | decide 过期 success 陷阱 | §3.5 approval.decide 行强化为设备规范条款 | 「应答后一律以返回的 interaction.status 终结本地状态机，不从 success 推导」——覆盖全部 interaction.* 应答（decide/answer 同理） |
| C5 | interrupt 投影剔 waitTime/createdAt | §3.2 interrupt 行；倒计时单源 | interrupt lite 投影**剔除 waitTime/createdAt**，统一 deadlineAt 单一倒计时源（防两套公式并存）；interaction.changed 设备侧 **500ms 防抖**后重拉 interaction.list（规范条款） |
| D-a | 错误码载体与冻结 | §6 D13 扩写 | 错误码放 error.code **并列字段**（不进 message，不违 F11）；错误码枚举纳入 v1 冻结集（与 D14 版本策略联动）；未知 code 设备行为 = 按 unknown 处理 + 原样展示 message |
| D-b | 未知 v 拒绝时机 | §3.1 版本机制扩写 | ?profile=lite&v=N 未知时建议 **WS 握手期 close(4xxx, reason=JSON{supportedVersions})** 而非建连后 error 事件——设备在握手层即可机读判定，无需进入消息循环 |

> D-c~D-j（serverNow 入 done/时钟容忍条款/D10 msgId/done 负向语义/F11 全文/presetId/方案 B 复用约束/doc-first 条款化/多 root ≤1–2）已在本清单 §2 覆盖，此处不重复。

## 5. 改版执行顺序建议（一次改版内的编辑批）

1. §1.2 硬约束表（T6①⑤：字节定义、rx buffer 措辞）
2. §2 方案 B 加约束句（A-4）
3. §3.1–§3.2（T4 ii 子事件小节、D10 msgId、D18 presetId、A-2 error 规范引用、v) state 快照 lean 定义）
4. §3.3–§3.4（T6① summary 字节、B-3 serverNow、B-9 负向语义、T6④ 阈值扣 256B）
5. §3.5（R6 nodeCount、B-10 节流注释、interaction.list maxItems）
6. §3.6（B-7 重连判定规则 + root 上限）
7. §3.7 大改（T6③ 扩展到响应帧 + 分页默认 + 收件箱 payload 截断；T4 i 字段级截断改写）
8. 新增 §3.9 低档交互降级（T6⑥）
9. §4 对照表微调（F11 全文引用）
10. §5 分期重排（node.get 入 P0、protocol.md 补录前置化）
11. §6 D 清单按 §4 编号统一重写 + 标注裁定状态
12. §7 开放问题闭环（多条已由本轮解决：删除/改写对应条目）
