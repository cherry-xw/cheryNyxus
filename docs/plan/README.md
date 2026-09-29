# Plan 工作区

本文件是当前实施计划的唯一总入口。先在下表选择任务，再进入对应目录的 `README.md`；只有执行具体小任务时才读取其详细文档。

| 任务                                                                           | 状态       | 范围                                                           |
| ------------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------- |
| [万象台](wanxiangtai/README.md)                                                | 规划中     | 多 Agent 团队协作、独立工作区、交付集成与桌面呈现              |
| [上下文统计、待办进度与连续消息交互](conversation-observability-and-input/README.md) | 规划中 | 基于现有实现的设计初稿：上下文组成与增长、To-do 三模式展示、连续消息采用时机与状态 |
| [排队消息三模式虚化展示与撤回](virtual-message-interaction/README.md) | 执行中 | 精简模式发送后即时显示修复、死亡 RPC chat.send/chat.resume 清理、chat.input.withdraw 撤回 RPC、树/对话/精简三模式排队消息虚化展示与末尾定位 |
| [工作台任务进度标记](workbench-todo-progress/README.md) | 执行中 | 精确任务归属协议，以及节点树、对话、精简三种工作台模式的 To-do 进度标记 |
| [工作台文件引用与 Terminal](workbench-files-terminal/README.md) | 待综合验证 | 三种工作台模式统一输入、工作区文件列表与只读查看、文件引用执行、本机与 SSH Terminal |
| [独立后端与中转网关](relay-gateway/README.md) | 执行中 | 独立后端、rathole 中转、Pocket ID 与密码双认证、动态端口、本地管理器、浏览器前端和子路径部署 |
| [MiniMax 多模态图片能力对接](minimax-multimodal/README.md) | 规划中 | MiniMax 图片理解/生成接入：上传、展示、对话携带、多轮上下文保留与回溯的完整链路 |
| [媒体外部服务化与工具能力声明](media-external-service/README.md) | 待综合验证 | 多媒体并入自定义工具机制（外部服务）：工具能力声明 accepts/produces/preprocess/batchSize、生成类从大脑双门解放、理解类前置执行、密钥 env 解耦、CherryNexus 自动生成；破坏性收尾删除旧媒体网关链路（config.media / 内置 generate_* / 旧路径兜底 / MediaTab），媒体能力统一由自定义 sense + .env + 感官组承担 |
| [预设与角色 Tab 合并](presets-roles-merge/README.md) | 执行中 | 设置中心合并「预设」与「角色」为单一 Tab：外层预设列表 + 内层该预设角色工作台；阶段一只做前端，结构变更为后续任务 |
| [模型请求超时与运行时长反馈](llm-request-timeout/README.md) | 执行中 | 单次模型请求限时与截断历史、底部统一停止入口、节点和任务运行时长反馈 |
| [F 表大文件拆分](refactor-f-table/README.md) | 执行中 | 按重构基线完成 F-01～F-19，保持行为并直接切换到拆分后的实现 |
| [精简模式工具展示层重构](lite-tool-display/README.md) | 待综合验证 | 精简模式工具展示层：工具线框标记、正文消失 bug 修复、详情抽屉工具展示破坏性重构（工具链分割线/简介入口/内置工具专有 UI/第三方通用渲染） |
| [节点树折叠系统：轮次档位替换与阅读导航设计点](node-tree-fold-round/README.md) | 待综合验证 | 第四档替换为整轮压缩节点，补充四档必要性调研和后续阅读导航设计点 |
| [登录优先启动与后端能力分级](login-first-capabilities/README.md) | 执行中 | 依据独立后端与中转网关需求实现服务选择、Pocket ID/后端密码认证、能力说明和按能力启动 |
| [移除 Electron 前端壳](remove-electron/README.md) | 待综合验证 | Electron 原生入口、桥接与打包已移除；自动回归尚有已记录失败，人工浏览器回归已由用户完成 |

## 使用规则

小型即时任务按 [Plan 适用范围](../standards/global/plan-operation.md#0-是否需要建立计划) 直接完成，无需在此登记。

- 本页只维护任务目录、当前状态和一句话范围，不复制任务清单。
- 每个任务目录的 `README.md` 是该任务唯一恢复入口，详细小任务与验证资产只从那里进入。
- 新建或维护任务文档时，按[创建时间规则](../standards/documentation/plans.md#11-文档创建时间)在任务名称下记录文档创建时间。
- 完成的小任务删除独立文档；其回写内容只保留“执行记录”（变更对象 / 命令 / 退出码 / 关键断言行 / 产物），不写叙述性段落，不使用“全面验证”“理论上”“应当”“应该”等模糊词。
- 人工/UI 验收只放在最后的综合验证子计划：综合验证小任务顶部固定维护“反馈回填槽”，实施过程中所有反馈、待补项、用户临时意见必须登记在这里，阶段一收口前槽内清零；自动清单每行 6 列（编号 / 目标 / 命令 / 退出码 / 关键断言行 / 日期+产物），不写“通过”二字即视为尚未执行；人工清单只保留四类（真实视觉与交互、主观 UX 判断、跨设备/窗口/无障碍、性能体验），每条 ≤1 分钟；用户对自动清单采取抽样信任。
- 台账新增、删除或改变小任务范围时，同步重建最后综合验证子计划的反馈回填槽、自动/手动清单与 `verify/manual-final.md`，不留失效验证项。
- 任务经用户批准后整目录删除：移除本页任务行并删掉整个 `docs/plan/<task-id>/`（含 `verify/` 与产物）；删除前必迁长期证据到 `docs/quality/verification/<task-id>/`（含 `auto-output.md` / `manual-conclusion.md` / `approval.md`），迁出前不得删除 `verify/` 与 `verify/out/`；删除条件与诊断矩阵见 [Plan 操作方案](../standards/global/plan-operation.md)。
- 新建、完成、暂停或恢复任务时同步本页状态。所有内容遵守 [Plan 操作方案](../standards/global/plan-operation.md)。
