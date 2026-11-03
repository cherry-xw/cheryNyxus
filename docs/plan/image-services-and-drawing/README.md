# 图片服务与会话绘图验收

**文档创建时间：** 2026-10-22T22:52:37+08:00

**状态：** 执行中

**计划形式：** 拆分计划；分别处理 Imagen 破坏性移除、厂商真实验证、多轮绘图交互与跨所有者查询提示。

## 目标、确认与边界

用户已批准本轮设置与常规文件交互结束，将剩余图片服务和绘图事项独立移交。已确认 D21—D23 的单次原生多图、统一全局默认与选图/反馈/定稿设计继续有效。目标是实际服务、发送前参数、请求、固定候选和用户定稿相符，而非只有入口和离线测试。

已确认但仍需核对的完整设计见[绘图设计](design.md)；现行契约归[模型能力](../../backend/agent/model-capabilities.md)、[模型目录](../../backend/agent/model-catalog.md#图像服务参数与实现边界)、[会话绘图协议](../../shared/protocol/websocket.md#会话绘图请求与记录已批准实施中)与[工作台文件](../../frontend/workbench-files.md)。默认显示与保存已完成，四项外部默认未核实字段的显示与原值保护归[设置中心](../../frontend/settings.md#默认显示与明确编辑)，不重复实现设置。

接手人为恢复本任务的执行者，复杂度 4/5：厂商能力、持久轮次和双窗冲突相互依赖，需按接口核实与恢复分析能力；沿用已确认模型，不分配其他执行者。

## 授权与准备条件

- 2026-11-02 用户明确选择 `1A`（破坏性移除 `google-imagen`）并授权使用现有网关与密钥（`https://ai.xcherry.top`）执行全面真实验证。
- 浏览器、图片和交互由用户查看，执行者不启动浏览器、不截图、不读图。
- 历史普通文件不伪造为绘图记录。

## 小任务台账

| 编号 / 小任务 | 状态 | 复杂度及依据 | 依赖、下一步与完成条件 |
| --- | --- | --- | --- |
| ID01 Imagen 破坏性移除 | 已完成 | 4：跨协议、目录、执行器与审计快照同步 | 官方 Gemini API Imagen 已关闭且 Vertex AI `imagen-4.0-*-001` 于 2026-06-30 退役；用户选择方案 1A 破坏性移除 `google-imagen` 适配器与 `google-imagen-4` 目录项，仅保留五类有效 HTTP 图片适配器 |
| [ID02 各厂商文件服务真实验证](design.md#4-剩余验收矩阵) | 进行中 | 4：同厂商不同接口不等同 | 已在 `https://ai.xcherry.top` 与 MiniMax 官方入口完成 `openai-images`（`gpt-image-2`、`gpt-image-2.5`、`image-01`、`image-01-live`）、`openai-responses-image`（`gpt-5.6-sol` + `image_model: gpt-image-2`）、`minimax-images`（`image-01`、`image-01-live` 生成与人物参考）及 `google-gemini-image`（`gemini-3.1-flash-image`、`gemini-3-pro-image` 生成与编辑，含复用 `/v1` 大脑连接）真实生成与多轮定稿验证；仅剩 `doubao-seedream` 待火山方舟渠道接入后补验 |
| ID03 多轮绘图与用户选图 | 已完成 | 4：固定候选、反馈、定稿和多窗 | 已通过真实服务完成首轮多图请求（`desiredCount: 2` 网关返回 1 张触发 `partial` 保留有效候选且不自动重画）→ 选中候选反馈编辑（`image.edit`）→ 生成新候选 → 用户定稿（`selectionRevision=1`）→ 同 `requestId` 幂等重试（200）→ 过期版本双窗冲突（409 `file.state_conflict`）→ 定稿后第 3 轮继续生成不覆盖已有 `finalCandidateId`，证据存于 [verify/live-evidence-20261102.json](verify/live-evidence-20261102.json) |
| [ID04 GLM/GPT/MiniMax 图片产品验证](design.md#5-共享流程与恢复要求) | 阻塞 | 4：局部请求不等于完整角色运行 | 服务端工具路径归[对应任务](../server-tools-completion/README.md) `SC01`—`SC04`。本项接手 MiniMax 完整角色与生产一轮策略、图片准确性及一般混合输入/联合理解；既有三次携图描述不重测、不扩大结论 |
| ID05 首次绘图查询 400 定位与修复 | 已完成 | 3：跨所有者会话权限状态码映射 | 定位生产数据库 `minimax预设` 最新根会话 `fileOwnerId` 为 `cherynyxus-qq-module`，浏览器以 `manager-internal` 查询 `POST /api/file-services/drawings` 时 `fileAccessForChat` 抛无 `code` 异常被映射为 400 `file.operation_rejected`；已为跨所有者拒绝附加 `code: 'EACCES'`，明确返回 403 `file.permission_denied` |
| [ID06 综合验证与用户验收](design.md#4-剩余验收矩阵) | 进行中 | 4：厂商、运行依赖和视觉分别判断 | 已完成全量类型检查、后端/前端测试套件、构建、文档检查与生产容器 Sharp 0.35.5（libvips 8.18.7）核验；三视图/快速发送、候选、窄窗/键盘/触屏与视觉效果交由用户人工验收 |

## 实现与检查入口

- 数量与能力：`packages/protocol/src/imageGeneration.ts`、`settings.ts`，后端 `utils/modelCatalog.ts`、`fileConfigMigration.ts`、`service/fileServices/imageOutput.ts`。
- 操作和持久记录：`service/fileServices/operations.ts`、`adapters/providers.ts`、`drawings.ts`、`service/chat/input.ts`、`db/fileDeliverables.ts`；服务调用前再查权限/启用与排队快照变化。
- 界面：`composer/useDrawingDraft.ts`、`DrawingPanel.vue`、`DrawingTaskList.vue`、`useDrawingRecords.ts`、`useFileServiceTrial.ts`。试用不自动保存配置，模型选择不修改聊天大脑。
- 集中测试：`drawingWorkflow.test.ts`、`imageCount.test.ts`、`fileServiceAdapters.test.ts`、`fileOperationRecovery.test.ts`、配置采用测试与 Web `drawingDraft.test.ts`/`fileServiceTrial.test.ts`；可执行命令归[文件能力验证](../../quality/verification/file-capabilities.md#自动检查入口)。模拟传输只能证明其断言，不能证明厂商可用。

## 当前恢复检查点

已完成 `ID01`（破坏性移除 `google-imagen`）、`ID05`（跨所有者会话绘图查询返回 403 `file.permission_denied`）、`ID03`（基于真实网关的多轮绘图、部分产出保留、选图编辑、用户定稿、409 冲突拦截与定稿后继续生成保留原定稿）以及 `ID02` 中 GPT（`openai-images` / `openai-responses-image`）、MiniMax（`minimax-images` / New API `openai-images`）与 Gemini（`google-gemini-image`）在标准后端配置下的全链路实测（脚本 [verify/run-live-verification.mts](verify/run-live-verification.mts)，证据 [verify/live-evidence-20261102.json](verify/live-evidence-20261102.json)），生产容器 `cherynyxus-backend-1` 已核实安装 Sharp `0.35.5`。

剩余未闭环项：
1. `ID02` 中 `doubao-seedream` 待火山方舟渠道与凭据接入后补测。
2. `ID04` 依赖[服务端工具完整流程](../server-tools-completion/README.md) `SC01`—`SC04`。
3. `ID06` 浏览器三视图、窄窗/键盘/触屏与实际成图视觉效果由用户人工验收。
