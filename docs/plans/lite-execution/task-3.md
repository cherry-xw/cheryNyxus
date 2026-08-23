# Task 3：Lite 单连接集成

## 目标

将 Web/Electron Lite 接入 canonical 会话与命令路径，使模式切换成为纯 UI 切换，彻底消除独立连接、重复水合、错会话与多窗口串状态。

## 允许修改范围

- Lite store 的职责和 per-window UI state。
- `WorkbenchDialog` 与 LiteView 的 root 绑定和组件集成。
- 浏览器与 Electron 的 Lite 切换入口、持久化逻辑。
- Web 生产路径中独立 `LiteClient` 的移除或退役。
- 与连接数量、subscription/cursor 连续性、多窗口隔离相关的前端测试。

## 禁止事项

- 不改变 Task 1 已确定的协议和计时事实。
- 不重做执行监控视觉或详情抽屉；该工作留给 Task 4。
- 不重做发送、审批、提问状态机；该工作留给 Task 5。
- Lite 切换时不得调用 `connect`、`disconnect`、`chat.open` 或 `chat.close`。
- 不通过 `chat.list()[0]` 或列表顺序猜测当前会话。
- 不复制 canonical timeline、interaction inbox 或 reconnect 状态到 Lite store。
- 不修改 MCU 固件。

## 接口与行为

- LiteView 显式接收当前工作台 `rootChatId`，数据来自 Task 2 canonical selector。
- `WorkbenchDialog` 继续通过既有 `chatSessions.acquireRootTimeline()` 持有唯一 root 订阅。
- Lite store 仅按 `windowId + rootChatId` 保存：展开项、草稿、滚动位置和其他纯 UI 状态。
- 完整视图与 Lite 共享 canonical root timeline、transient state、interaction inbox、streaming events、replay fence 和命令路径。
- 浏览器与 Electron 统一调用 `toggleLiteView()`；禁止给只读 computed 赋值。
- 模式切换保留相同 WebSocket、`subscriptionId`、`rootEventSeq` cursor 与正在运行的任务。
- root 改变时只切换 selector/UI state，不继承上一个 root 的 revision、错误、展开项或草稿。
- 无会话时复用工作台已有的新建会话流程。
- 离开 Lite 不断开连接；关闭窗口只清理该窗口的 UI state，不破坏其他窗口或共享 canonical 数据。

## 测试

- 切换 Lite 前后 WebSocket 实例数不增加。
- root `subscriptionId` 和 `rootEventSeq` cursor 保持不变。
- 运行中连续切换不停止任务、不丢流、不重复消息。
- canonical 主连接断线只产生一次重连，Lite 不出现第二套状态。
- 两个工作台窗口分别绑定各自 root，UI state 不串窗。
- 切换历史会话后 Lite 立即显示正确 root，不使用列表首项或旧 revision。
- 浏览器与 Electron 切换入口均生效并按窗口持久化。
- 无会话入口复用现有新建流程。

## 完成条件

- Web/Electron 生产 Lite 路径不再创建或维护独立 `LiteClient`。
- 所有切换和多窗口测试通过，运行任务在切换前后连续。
- 主 Agent 审查确认无新增连接、订阅或重复水合。
- 删除本文件，在 master 中标记 Task 3 完成。
- 独立提交：`fix(web): switch lite mode without reconnecting`。

