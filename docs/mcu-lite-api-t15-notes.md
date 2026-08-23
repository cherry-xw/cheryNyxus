# T15 实现预研：连接级 profile + 事件面裁剪三出口

> 状态：预研完成，等 T14（doc-first 标注）完成后 claim t15 实施。设计契约 = canonical-timeline.md §3.6 + mcu-lite-api.md（v3.1 定稿）。

## 1. 源码摸底结论

### 1.1 src/service/websocket/connection.ts（507 行）
- `ConnectionState`（:62-66）：{id, ws, pendingRequests}——**加 profile 字段点**：`profile?: {kind:'lite', version:number, maxFrameBytes:number, turnDelta:boolean}`。
- `create(ws)`（:99-107）：无参创建——需扩展签名接收 profile（或 setter）。
- `prepareSessionEvent(ws, item)`（:366-417）：**主收口**。现状：无 chatId 原样返回（:376-377 前置）；mutedRoots 抑制（:382-390）；root/direct 订阅匹配+信封增强（:391-416）。**lite 插入点：在信封增强前后加 profile 分支**——先过白名单（抑制类直接返回 []），再对保留事件做字段投影与信封精简。
- `backgroundControlEvent`（:37-57）：既有裁剪先例，lite 不复用（语义不同：那是静默 root 压缩）。
- `close(ws)`（:477-494）：清理齐全，profile 随 state 删除自动释放。

### 1.2 src/service/websocket/index.ts（431 行）
- `verifyClient`（:88-112）：仅认证开启时存在——**profile 解析不放这里**（无认证场景 verifyClient 为 undefined）。改在 `wss.on('connection')`（:131）：`new URL(req.url).searchParams` 取 profile/v/maxFrameBytes/turnDelta，未知 v → `ws.close(4xxx, reason=JSON{supportedVersions})`（D14：握手期拒绝，不进消息循环）。
- **注意**：connection 回调当前不接收 req 参数（`(ws) => ...`）——ws 库 connection 事件实际是 `(ws, req)`，需补第二参。
- `sendChatEvent`（:43-54）：已统一走 prepareSessionEvent——lite 事件裁剪在此天然覆盖。
- **Response 帧旁路**（:377 `ws.send(transport.serializeMessage(response))` + :226/:230/:247/:260 四处提前返回的 send）：非流式 handler 的 RPC Response 直出——**lite Response 投影点**：集中封装 `sendResponse(ws, response)`，对 chat.timeline.get/chat.open/interaction.list 的 data 做 lean 投影+分页（P0 范围：LeanTimelineNode 投影；字段级截断）。
- `handleMessage` ping 分支（:192-195）：profile 无关，不动。

### 1.3 src/service/interaction/events.ts（27 行）
- `broadcastInteractionChanged`：getAllOutputs 直发 ws.send——**旁路一插入点**：对每个 ws 判 profile，lite 时投影加 presetId（从 record 或 getInteraction 取）+信封不变（本就三字段轻量）。需从 db/interaction.ts 的 InteractionRecord 取 presetId 字段（已存在）。
- presetId 来源：broadcastInteractionChanged 的入参 record: InteractionRecord 含 presetId?——直接带上。

### 1.4 src/service/chat/streamMapper.ts（事件产生面）
- 产生 20+ 种事件但**不在 lite 裁剪范围动它**（单一产生面，红线：不改写路径）——裁剪全部在发送端三出口完成：
  1. 出口一（事件主收口）：prepareSessionEvent 内 profile 分支（connection.ts）
  2. 出口二（旁路一）：broadcastInteractionChanged（events.ts）
  3. 出口三（旁路二）：sendResponse 封装点（index.ts Response 帧）
- 白名单矩阵照 mcu-lite-api.md §3.2 逐行实现（原样透传/投影精简/抑制三分类；子 chat 判定需 rootChatId 上下文——prepareSessionEvent 可从订阅信息或 getRootChatId 取）。

## 2. 实现计划（等 T15 解锁后执行）

| 步骤 | 文件 | 内容 |
|---|---|---|
| S1 | types.ts（message） | 新增 ConnectionProfile 类型 + LeanTimelineNode 类型 + LITE_EVENT 矩阵常量（whitelist/transform 表） |
| S2 | connection.ts | ConnectionState.profile + create() 扩参 + prepareSessionEvent lite 分支（白名单过滤→字段投影→信封精简） |
| S3 | websocket/index.ts | connection 回调补 req 参解析 query → profile 校验（未知 v close 4xxx）→ connectionManager.create(ws, profile)；sendResponse 封装（Response 帧投影） |
| S4 | interaction/events.ts | broadcastInteractionChanged lite 投影（presetId 注入） |
| S5 | chat/handler.ts | chat.open/timeline.get 响应构建处 lean 投影（按 ctx.connectionId 查 profile）+ node.get handler（若属 Track 1 范围则一并，否则留 Track 2） |
| S6 | 测试 | 白名单矩阵逐事件单测 + 子 chat 路由 + 未知 v 握手拒绝 + 信封精简断言 |

## 3. 边界（captain 已确认）

**T15 范围**（且仅此）：① ConnectionState.profile + URL 解析 + 未知 v 握手期 close(4xxx)；② 事件面三出口裁剪（prepareSessionEvent 主收口 + interaction.changed 旁路 + Response 帧旁路）；③ 信封最小化；④ LeanTimelineNode 投影（timeline.get/open/patch 三处共用投影函数）。

**归 T16（researcher Track 2）**：node.get、有界负载、分页默认值、interaction.list 的 serverNow/maxItems 增强。

**关键约束**：sendResponse 封装只做「lite 连接上的 Response 裁剪」传输层动作，**不动 handler 响应结构本身**（S5 收窄为：timeline.get/open/patch 的 data 投影在 sendResponse 内按 method+profile 分发，handler 零改动）——避免与 T16 冲突。
