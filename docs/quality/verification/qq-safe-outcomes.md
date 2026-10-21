# QQ 图片、错误事实、Manager 平台与指令停止归档后续审核清单

## 范围

本清单归档以下已结项任务中尚未在生产或浏览器人工完成的细枝末节验证项与外围边界。正式功能与协议事实以 [`plugins/qq/README.md`](../../../plugins/qq/README.md)、[`docs/shared/protocol/qqbot-plugin.md`](../../shared/protocol/qqbot-plugin.md)、[`docs/shared/protocol/errors.md`](../../shared/protocol/errors.md)、[`docs/shared/architecture/manager-management.md`](../../shared/architecture/manager-management.md)、[`docs/shared/architecture/manager-plugins.md`](../../shared/architecture/manager-plugins.md) 和 [`docs/guides/backend-runtime.md`](../../guides/backend-runtime.md) 为准。

## 1. QQ 错误事实与受控问答外围验证

普通群问答已于 2026-10-20 在 `980129567` 群完成生产实测（问题和最终回复均有 `sent` 回执，同一 run 续接完成且 Core 只记录一次用户输入）。以下外围边界留待后续统一验证：

- 真进程重启窗口和并发恢复：安全错误事实到达后进程重启，同一 run 晚到的通用事件不得覆盖原因或发重复通知。
- 权限边界：原发起者之外的群成员、跨目标或连接的引用不能续接；权限与配置变更应使旧问题失效。
- 问题审批拒绝、取消以及工具审批等待后输入闭环；群消息不能批准工具。
- 全部错误生产者、错误码与渠道投影的独立审查，包括断开的 WS 与迟到错误事件。
- 问题送达确认未知、答案持久化后续接确认未知：不重放物理消息，不创建第二条输入；后续相同输入只核对原命令。
- 多个目标同时处理与同目标并发消息的恢复/串行边界。

## 2. QQ 群图片上下文后续验证

原生图片采集（QQ `0.1.40`、NapCat `0.2.14`）及 `settings 2.0.4` 严格 schema 已部署，真实群新消息（`640413920`）自动单图采集、资产提交及会话授权已通过生产验证。以下项目留待后续统一验证：

- 真实模型视觉理解与多图背景：普通群图作为背景、同群引用复用固定资产、不同发言者关系、感知相似去重边界及一轮到期后保留原件。
- Manager 浏览器登录后设置页实际操作：在浏览器登录 `http://10.2.3.6:39980/` 操作文件策略与 QQ 图片原件配额界面（当前仅完成认证 API 与 UI 静态资源摘要核验）。
- 原生撤回与监听物理注销：QQ 原生撤回事件入站协议（当前核心撤权测试不代表 QQ 原生撤回）、`removeKernelMsgListener` 物理注销实机效果，以及全链路高负载峰值/真实磁盘写满边界。

## 3. Manager 平台化与 Backend 启动监控（第一阶段）人工审核清单

同容器受管模式（`cherynyxus-runtime:managed-20261020`）与外部模式监控修正已部署，预装 `backend-manager` 插件、5s/15s/30s 最多 3 次异常重试、5 分钟稳定清零、离线平级插件置灰及自动测试已通过。以下浏览器人工操作留待后续统一审核：

- 登录 Manager（`http://10.2.3.6:39980/`）进入「插件管理」，确认默认预装 Backend 管理插件与 QQ、设置等平级展示。
- 检查 Backend 管理插件面板的服务状态、CPU/内存/运行时长、进程日志、“随插件启动 Backend”开关持久化，以及 Backend 未启动时平级插件卡片的“依赖 Backend 运行，当前不可用”置灰提示。
- 旧 Manager 独立性测试文件（`auth.test.ts`、`crossEndCompletion.test.ts`、`independence.test.ts`、`regression.test.ts` 中针对已退役旧路由与旧字段的断言）留待后续统一清理对齐。

## 4. Agent 命令监控与 Backend 停止（第二阶段）部署与人工审核清单

共享协议（`agent.command.*`）、分块 gzip 日志与流式 Drain 摘要、10 MiB / 200 MiB 配额淘汰、Manager / guardian / worker 停止协调（等待任务结束、取消关闭、10 秒强制中断）、Web 暂停现场与显式“继续”、QQ / NapCat 服务关闭通知（`qq.service.state`）与空队列恢复均已完成源码实现并通过全套类型检查、构建及 24 个后端/协议测试（191 用例）、插件测试（130 用例）、NapCat 测试（42 用例）、Manager（35 用例）与 Web（19 用例）回归。以下真实运行环境部署与人工界面审核留待后续统一执行：

- 生产环境镜像构建与升级部署（包含新 `agent.command.*` 与停止协调协议的 Backend、Manager、Web、QQ 插件及 NapCat 插件）。
- Web 端全局命令监控窗口与会话内入口、实时/分页原始日志与 Drain 摘要切换、单条命令停止交互。
- Manager 端点击“停止 Backend”或停用 `backend-manager` 插件时的“等待任务结束后关闭”、“取消关闭”、“中断任务并关闭（10 秒宽限期）”真实交互，以及重启后 Web 点击“继续”恢复队列、QQ 停止期间回复“服务已关闭”的实机表现。

离线自动测试不替代上述尚未执行的生产或浏览器人工检查。不得为这些检查重放旧任务、清理生产数据或故意制造未知发送。
