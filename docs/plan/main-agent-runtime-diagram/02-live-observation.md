# T02 实时观察与订阅

所属总任务：[主 Agent 运行流程图](README.md)。状态：未开始。批次：B。复杂度：4（较高），因为涉及运行边界、异步等待、多窗口租约与断线状态恢复。依赖：T01。

## 范围与交付

实现只读流程 open/close 和状态通知，接入主 Agent 的基础执行边界。交付小型当前状态投影、连接生命周期清理、初始快照与后续更新。依据[技术设计](technical-design.md)第 3 至 5 节，产品状态归[需求说明](requirements.md)。

不追踪子 Agent 内部流程，不把专用观察写入 chat/root journal，不改变 Loop、重试、审批和唤醒策略。历史 RPC 与持久结果附注由 T03 负责。

## 已完成事实

- [x] 已确认工具在 Phase 1 收齐后执行，pending 续接能跳过模型路径。
- [x] 已确认现有连接管理有订阅与关闭监听入口，专用观察不能成为执行 owner。
- [ ] 实时观察模块与接线尚未实现。

## 剩余步骤

- [ ] 更新后端模块文档的写者/回收规则，消费 T01 已发布类型。
- [ ] 在 `src/service/chat/` 实现按主 chatId 共享的当前投影，以及按连接/observerId 区分的观察租约。
- [ ] 在 [connection.ts](../../../src/service/websocket/connection.ts) 既有连接生命周期接入回收；open/close 幂等且校验订阅所有权，不复用执行 owner 身份。
- [ ] 注册打开与关闭 handler，返回带 streamId/revision 的快照；原子处理快照和通知接入竞态。
- [ ] 对 [Agent 中间件](../../../src/agent/middleware/) 的输入、Chat、退避、完整批次、执行、汇总、Loop 出口接入可选观察回调；Core 不反向依赖 service。
- [ ] 对 [runtime.ts](../../../src/service/chat/runtime.ts) 的真实构建/恢复和 [autoCompact.ts](../../../src/service/chat/autoCompact.ts) 的指令预检输出基础状态。
- [ ] 复用 [executionFacts.ts](../../../src/service/chat/executionFacts.ts)、pending interaction、spawn/wake 的主 Agent 边界事实，处理等待和 yield，不展示子内部状态。
- [ ] 从已发布 Hook 注册表生成位置标记，过滤 stub 与不支持的 Provider；不运行 Hook，不记录执行结果。
- [ ] 第一个观察者开启细分投影，最后一个关闭后释放；中途打开用现有事实补当前状态，无法确认的短阶段明确未知。
- [ ] 处理异常回调、重复帧、会话删除、归档只读、断线与重新打开，不改变其他观察窗口或原消息树订阅。

## 定向自动验证

执行 `pnpm type-check` 与 T01 登记的隔离验证入口，重点断言：

- 无订阅时不产生专用通知/追踪写库；观察失败不改变业务结果。
- 两窗口观察同一主 Agent，关闭一个仍能向另一个更新；观察断线不 park 任务。
- 主 Agent 可更新，子 Agent 内部事件被排除；派发与回传可更新边界。
- 全批次快照先于首项执行；重复工具按 ID 分开；审批调用真实顺序保留。
- 模型重试、等待审批/回答/子返回、真实暂停、pending 续接与终态分别正确。
- 初始快照与并发通知无漏更新，旧 stream 和旧会话帧不能覆盖新状态。

仅使用隔离数据和 mock 执行，不启动图形界面。将真实 UI 场景登记到最终人工手册，不作为本子任务完成条件。

## 完成标准

协议客户端可从中途加入、接收并恢复主 Agent 当前基础状态；不改变运行策略或其他订阅；关键异步场景通过定向验证。回写模块入口、验证命令和 T05 接入说明后删除本文件。
