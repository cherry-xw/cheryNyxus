# 文件能力验证

## 范围与判断

覆盖资产保存与迁移、有序消息、模型输入与图片保留、文件服务、角色交付、Web 草稿/试用及 QQ/NapCat 文件协议。契约分别见[模型能力](../../backend/agent/model-capabilities.md)、[Provider](../../backend/agent/provider.md)、[消息](../../backend/core/message.md)、[工作台文件](../../frontend/workbench-files.md)和[QQ 协议](../../shared/protocol/qqbot-plugin.md)。

当前验证说明仅描述状态、原因判定规则和错误结构化证据的形成方式；不要把待提交源码、自动测试输出或生产部署结果当成用户侧错误提示验收。QQ 普通群接续问答另有生产群实测证据，但不属于这里的文件能力验证范围。

- 自动检查只证明其实际断言；配置检查不发真实请求，模拟输出不能证明服务商执行。
- 云端工具成功必须有可关联的执行事件、非空结果/来源和有依据的最终答案；HTTP 200 或 `completed` 本身不够。显示记录不得回传为伪造的本地执行结果。
- 图片测试核对实际请求中的固定版本、轮数与提示，明确区分原图、文字观察和未携图；模型实际回答另行验收。重读成功不能代替普通保留轮成功。
- 部分结果保存失败只重试保存，不重新调用生成；角色成果冻结后交付，不能从最终文字中的 URL 推断文件。
- QQ 结果未知不自动重发，文件读取依赖已认证身份、事件及固定版本，不公开资产链接。
- 真实服务先取得限定账号、型号、输入和次数的批准。生产、QQ 实发与人工界面各自授权；不启动浏览器、不读图，不用 DOM/CSS 检查代替界面验收。

## 设置与常规文件交互的当前验收范围

设置默认显示、按原始值保存、完整候选校验及 Web / Manager 同步已完成发布和用户验收。可选字段不因查看补写、显式默认值保留、缺少必填值拒绝保存、MCP 默认不启用；长期规则归[设置中心](../../frontend/settings.md)和[设置保存契约](../../shared/protocol/websocket.md#设置原始值与保存校验)。

2026-10-22，用户确认本轮设置与常规文件交互收尾。以下仅为实际反馈覆盖的范围，不代表全部文件能力或全部模型通过：

| 范围 | 当前结果与边界 |
| --- | --- |
| 设置保存 | 双端回显与保存同步、保存无额外警告、Manager 页面非法值拒绝、旧页面覆盖保护通过；核心 `config.preview` 和设置插件 `PUT files` 对质量 `101` 的直接请求拒绝通过，不扩展为所有保存入口或业务权限通过 |
| 草稿文件 | 切会话保留、TXT 查看下载、复制引用的独立用途及单份移除、图片版本切换与预览、编辑器附件删除/撤销/重做通过 |
| 历史文件 | 用户反馈“7B ok”：一次 `reference-only` 提交后的历史卡片预览、固定版本下载、重新引用及重复点击提示通过；后台只读核对 1 条会话授权和 1 条消息引用，固定版本为 `original`，请求计划 `completed/omit`、图片二进制用量 0。该用量仅说明本次附件未作为内容输入，不代表没有文字模型请求 |
| 可读性 | 已反馈的键盘焦点、窄窗和 200% 缩放通过；未据此推断触屏、全部主题或绘图候选界面通过 |
| 跳过与未完成 | 设置页文件服务草稿/角色能力检查按用户决定跳过，不标通过。跨账号、真实服务/绘图、QQ 文件、四项外部默认、Imagen 和服务端工具实现仍由[剩余事项](../../plan/file-capabilities-and-model-collaboration/README.md#单独跟进的剩余事项)管理 |

适用部署为 `cherynyxus-runtime:image-variant-reuse-fix-20261022`，设置插件 `2.0.7`。仓库外 `releases/image-variant-reuse-fix-20261022/` 保存发布及 `step8-batch7b-history-card-check.json`，`releases/settings-defaults-fix-20261022/` 保存设置实测证据；均位于 `/home/chery/docker/cherynyxus/`。证据由后续执行者在剩余核对结束前保留，不公开凭据或业务正文，不重跑一次性发布及真实调用脚本。

## 自动检查入口

以下从仓库根执行。pnpm 11 的自动依赖检查可能触发安装与初始化；验证时临时加 `--config.verify-deps-before-run=false`，不改变仓库或全局设置。不要为通过检查清除已有配置事务锁。

```sh
pnpm --config.verify-deps-before-run=false exec tsc --noEmit -p apps/backend/tsconfig.json
pnpm --config.verify-deps-before-run=false --dir apps/web type-check
pnpm --config.verify-deps-before-run=false exec tsc --noEmit -p plugins/qq/tsconfig.json
pnpm --config.verify-deps-before-run=false exec tsc --noEmit -p platform/napcat-plugin/tsconfig.json
```

后端文件回归：

```sh
pnpm --config.verify-deps-before-run=false exec vitest run --config apps/backend/vite.config.ts apps/backend/test/service/fileStorage.test.ts apps/backend/test/service/fileMigration.test.ts apps/backend/test/service/fileCapabilityResolver.test.ts apps/backend/test/service/fileServiceAdapters.test.ts apps/backend/test/service/fileInspection.test.ts apps/backend/test/service/fileOperationRecovery.test.ts apps/backend/test/service/imageContext.test.ts apps/backend/test/service/ingressFiles.test.ts apps/backend/test/service/mcpFileResults.test.ts apps/backend/test/agent/fileInputPlanning.test.ts apps/backend/test/agent/provider apps/backend/test/db/fileDeliverables.test.ts apps/backend/test/db/serverToolCalls.test.ts apps/backend/test/utils/fileConfigMigration.test.ts apps/backend/test/utils/modelCatalogAndFileContracts.test.ts apps/backend/test/utils/modelCatalog.test.ts apps/backend/test/utils/imageDimensions.test.ts --no-file-parallelism
```

服务端工具和既有本地授权边界：

```sh
pnpm --config.verify-deps-before-run=false exec vitest run --config apps/backend/vite.config.ts apps/backend/test/agent/middleware/serverTools.test.ts apps/backend/test/agent/middleware/checkpointState.test.ts apps/backend/test/agent/middleware/checkpoint.test.ts apps/backend/test/agent/middleware/chat.test.ts apps/backend/test/agent/middleware/tool.test.ts apps/backend/test/agent/middleware/qqRequest.test.ts apps/backend/test/core/messageJournal.test.ts apps/backend/test/scripts/cheryTemplateSync.test.ts --no-file-parallelism
```

其中 `server-tools-observed.json` 是已保存 GLM/GPT 搜索事件的脱敏选定字段，带原响应哈希，不依赖临时目录、不发模型请求。边界用合成事件覆盖：嵌套/部分 JSON 凭据与 Base64、带签名 URL、结构化错误、孤立结果、参数分流、未知完成、重复快照、混合响应审批时机、持久化更新/清空与独立续接字段保留。完整有序事件与产品多轮不能由这些局部断言推导为通过。

会话绘图与配置生效：

```sh
pnpm --config.verify-deps-before-run=false exec vitest run --config apps/backend/vite.config.ts apps/backend/test/service/drawingWorkflow.test.ts apps/backend/test/utils/imageCount.test.ts apps/backend/test/service/config/applyCoordinator.test.ts apps/backend/test/service/config/runtimeApply.test.ts apps/backend/test/service/fileServiceAdapters.test.ts apps/backend/test/service/fileOperationRecovery.test.ts --no-file-parallelism
pnpm --config.verify-deps-before-run=false exec vitest run --config apps/web/vitest.config.ts apps/web/test/workbench/drawingDraft.test.ts apps/web/test/settings/fileServiceTrial.test.ts --no-file-parallelism
```

核对真实输入处理器的 ACK 重发、持久排队和绘图轮关联，配置变化拒绝后的事务撤销，以及默认张数和按操作限制的实际运行态采用。采用测试须确认旧快照不变、未知字段仍拒绝；只测试数量计算不能证明设置已生效。生成传输使用替身，不发真实请求；没有浏览器、图片内容或实际厂商可用性结论。

Web 状态逻辑：

```sh
pnpm --config.verify-deps-before-run=false exec vitest run --config apps/web/vitest.config.ts apps/web/test/workbench/imageContextUi.test.ts apps/web/test/agents/draftTextHistory.test.ts apps/web/test/agents/fileDraftLeases.test.ts apps/web/test/chats/fileReplyReducers.test.ts apps/web/test/chats/toolRiskProjection.test.ts apps/web/test/settings/fileServiceTrial.test.ts apps/web/test/workbench/fileMessageParts.test.ts --no-file-parallelism
```

QQ 必须先完整构建安装包，包含 UI 和配置资源；仅构建 Vite 入口不够。

```sh
pnpm --config.verify-deps-before-run=false --dir plugins/qq build
pnpm --config.verify-deps-before-run=false exec vitest run --config plugins/vitest.config.ts plugins/qq/test
pnpm --config.verify-deps-before-run=false exec vitest run --config platform/napcat-plugin/vitest.config.ts
pnpm --config.verify-deps-before-run=false exec vitest run --config apps/backend/vite.config.ts apps/backend/test/service/qqPluginWire.test.ts apps/backend/test/service/qqProtocolContract.test.ts --no-file-parallelism
pnpm --config.verify-deps-before-run=false --dir apps/backend build
pnpm --config.verify-deps-before-run=false --dir apps/web build
pnpm --config.verify-deps-before-run=false --dir platform/napcat-plugin build
node --test scripts/docs/tests/*.test.mjs
node scripts/docs/check.mjs
```

按变更影响补配置管理/加载/脱敏、技能依赖、工具编译、消息日志、委派/检查点/过期结果和协议消费者的相关测试。构建与类型通过不表示真实接口或视觉验收通过。存在其他任务修改时，单独核对准备提交的完整内容，不能只验证混合工作区。

## 真实与人工验证前提

- 模型：明确入口、协议、型号、次数、原始输入与重试规则；保留关联事件、来源、真实回答及脱敏证据。不同型号、原生视觉和服务端辅助理解分别下结论。
- 上下文：核对首次采用、普通轮到期、重启计数、明确重读及同轮后续请求；压缩或新运行不重置用户轮计数；预算排除不能仍显示已附图。
- 生产依赖：只在获准环境验证 Sharp 安装与适配，合成编码/尺寸断言不代替视觉质量确认。
- QQ：准备已部署版本、账号/群、连接和授权；验证纯文件完成、身份隔离、断流、重放回执与停止保护。
- Web：用户在实际环境核对配置保存/生效、显式收费试用、混合输入、固定版本预览/下载、草稿引用/撤销、权限错误和键盘/触屏/窄窗/缩放。环境未准备不编造地址。

具体任务结果和未完成验收归对应活动计划；本文件只维护可复用方法与判断边界。
