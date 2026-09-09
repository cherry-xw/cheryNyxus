# 主 Agent 运行流程观察契约

运行流程是独立、只读、默认关闭的观察能力。共享类型与校验由 `packages/protocol/src/workflow.ts` 维护，RPC 名称由 `packages/protocol/src/rpc.ts` 注册。

## 订阅与版本

`chat.workflow.open` 接收主 `chatId` 和窗口稳定的 `observerId`，返回独立 `subscriptionId`、`streamId` 与完整快照。同连接、窗口、会话重复打开幂等；切换目标释放旧租约。`chat.workflow.close` 只释放调用连接持有的租约，断线自动回收。观察不注册执行 owner，不触发发送、恢复、审批或中止。

`workflow.updated` 直接向观察连接发送完整快照，不写 chat/root journal。每个流的 revision 单调增加；客户端只接受当前 chat、subscription、stream 匹配且更新的版本。先监听再打开；响应前通知暂存并按版本合并。最后一个观察者关闭后释放投影；无观察者不构造细分通知。观察异常不能影响执行。

## 事实与状态

节点为 context、command、input、model、retry、tools、checkpoint、decision、compact、result。等待模型、审批、回答和子返回均属于 running，waitReason 区分原因。paused、completed、failed、cancelled 必须有控制事实；生成器退出不独自证明完成。仅主 Agent 内部边界可高亮，子 Agent 只提供派发和回传关联。

工具以调用 ID 区分，同名不合并。第一项执行前发布完整批次，列表保持模型顺序，活动项遵从执行顺序。派发成功不等于子任务成功。Hook 仅表示已发布注册表中实际接线且匹配的前/后挂载，历史未知时省略。

`contextStageId` 表示实际采用的压缩摘要边界，独立于配置 `epochId`。压缩请求和摘要产生不能清空实时状态；裁剪真正生效才切阶段。冻结提示词资源计数来自同一次提示词构建；旧快照缺失保持未知。loadedSkillCount 仅计有效上下文中可靠确认的技能正文，去重且排除撤回、替换和裁剪内容。

`compactRequested` 是可选的请求参与标志，不是成功状态。历史调用可携带结果时的 `resources` 摘要；前端只在该结果步骤应用，不把最终计数提前套到过去。缺失历史纪元关联不套用当前冻结配置。

## 历史

`chat.workflow.history` 只读持久消息与执行事实，按 contextStageId、受限 limit 和不透明 cursor 分页。第一页固定历史上界，后续页面沿用；新事实不进入已有回放。返回阶段索引、完整逻辑事实及完整性说明。批次跨页时先补齐再播放。顺序无法精确还原时标记 reconstructed，缺失证据不补造准备、重试或 Hook 步骤。

上界内结果在分页期间变更时返回 CONFLICT，要求重新加载；无效或跨目标游标返回 INVALID_PARAMS。`complete` 只说明分页结束，`historyComplete` 与 `orderQuality` 说明证据质量，两者不能混用。

历史查询不得创建 Agent、激活纪元、写入配置或修复旧数据。归档主会话可读；不存在或子会话明确报错。长期存储仅在既有冻结 JSON 加资源摘要、执行节点 JSON 加必要最终结果 workflow 附注；嵌套附注合并保留，不新增追踪表或变更保留期。

实现定位见[服务层](../../backend/service/README.md)，界面行为见[运行流程图](../../frontend/runtime-diagram.md)。验证使用类型检查、隔离事实 fixture 与前端纯状态测试；真实界面由用户验收。
