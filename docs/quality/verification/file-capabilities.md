# 文件能力验证

## 范围与判断

覆盖资产保存与迁移、有序消息、模型输入与图片保留、文件服务、角色交付、Web 草稿/试用及 QQ/NapCat 文件协议。契约分别见[模型能力](../../backend/agent/model-capabilities.md)、[Provider](../../backend/agent/provider.md)、[消息](../../backend/core/message.md)、[工作台文件](../../frontend/workbench-files.md)和[QQ 协议](../../shared/protocol/qqbot-plugin.md)。

- 自动检查只证明其实际断言；配置检查不发真实请求，模拟输出不能证明服务商执行。
- 云端工具成功必须有可关联的执行事件、非空结果/来源和有依据的最终答案；HTTP 200 或 `completed` 本身不够。显示记录不得回传为伪造的本地执行结果。
- 图片测试核对实际请求中的固定版本、轮数与提示，明确区分原图、文字观察和未携图；模型实际回答另行验收。重读成功不能代替普通保留轮成功。
- 部分结果保存失败只重试保存，不重新调用生成；角色成果冻结后交付，不能从最终文字中的 URL 推断文件。
- QQ 结果未知不自动重发，文件读取依赖已认证身份、事件及固定版本，不公开资产链接。
- 真实服务先取得限定账号、型号、输入和次数的批准。生产、QQ 实发与人工界面各自授权；不启动浏览器、不读图，不用 DOM/CSS 检查代替界面验收。

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
