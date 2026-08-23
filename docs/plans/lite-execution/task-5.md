# Task 5：交互状态机闭环

## 目标

统一 Lite 与完整视图的命令和交互状态，补齐发送、停止、继续、审批、提问、超时、断线与失败恢复闭环。

## 允许修改范围

- canonical command path 与 Lite/完整视图的命令 adapter。
- `done`、发送、审批、提问、继续、停止和 interaction 状态 reducer。
- 连接门禁、空态、错误归属、重试和失败消息展示。
- 直接覆盖上述状态机的前端测试。

## 禁止事项

- 不新增连接、订阅、reconnect manager 或 Lite 专用命令通道。
- 不改变 Task 1 的协议字段和工具执行时间语义。
- 不重做 Task 4 已完成的布局与视觉体系。
- 不修改 MCU 固件。
- 不用页面级单一错误覆盖不同消息、审批或问题项错误。
- 不在 RPC 成功前把乐观消息永久标记为 committed。

## 接口与行为

- Lite 与完整视图的发送、停止、继续、审批和回答均走同一 canonical command path。
- 合并 `done` 为单一处理分支，同时更新：
  - root 最终正文。
  - `canResume`。
  - 服务端时钟偏移。
  - root 完成时间和总计时封口。
- 连接状态不是 ready、正在水合、无 root 或发生不可恢复错误时，危险操作必须禁用并说明原因。
- 无会话使用工作台已有创建入口；水合/连接失败提供明确重试。
- 发送消息先进入 sending；失败后进入 failed，可重试或移除；成功后才 committed。
- 错误绑定具体消息、审批或问题项，不被其他命令覆盖。
- 审批卡在 resolved、expired、already-resolved 后保留结果摘要与详情入口，不直接消失。
- 审批详情无 anchor 时使用与当前 interaction 关联的可靠定位，不回退到无关历史工具。
- 提问提交前校验必填单选和自由文本，错误落在具体题目。
- `ALREADY_RESOLVED` 显示已处理终态；`RATE_LIMITED` 显示可理解的等待/重试状态。
- reconnect/replay 期间命令状态保持幂等，不重复发送或重复提交。

## 测试

- `done` 一次性更新最终正文、`canResume`、时钟偏移、完成时间与总计时。
- idle、connecting、hydrating、reconnecting、无 root 和错误态的操作门禁正确。
- 发送成功/失败/重试/移除状态转换正确，不留下假 committed 消息。
- 停止、继续在 Lite 与完整视图走同一命令路径。
- 审批批准/拒绝/超时/已在其他视图处理后均保留清晰终态。
- 单选未选、自由文本为空时禁止提交并显示逐题错误。
- `ALREADY_RESOLVED`、`RATE_LIMITED` 与一般网络错误均绑定正确对象。
- reconnect/replay 不重复发送消息、审批或回答。

## 完成条件

- Lite 的所有主要交互均可成功、失败、重试或明确结束，不存在静默无响应。
- 与完整视图共享 canonical 命令和 interaction 状态。
- 针对性状态机测试全部通过。
- 删除本文件，在 master 中标记 Task 5 完成。
- 独立提交：`fix(web): complete lite interaction state machine`。

