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
| 跳过与未完成 | 7A3 设置页文件服务草稿/角色能力检查按用户决定跳过，不标通过。其余未完成事项分别由下方独立跟进任务管理，不表示整个文件能力均通过 |

适用部署为 `cherynyxus-runtime:image-variant-reuse-fix-20261022`，设置插件 `2.0.7`。仓库外 `releases/image-variant-reuse-fix-20261022/` 保存发布及 `step8-batch7b-history-card-check.json`，`releases/settings-defaults-fix-20261022/` 保存设置实测证据；均位于 `/home/chery/docker/cherynyxus/`。证据由后续执行者在剩余核对结束前保留，不公开凭据或业务正文，不重跑一次性发布及真实调用脚本。

### 独立跟进入口

用户已批准本轮结束并将剩余事项独立移交。以下任务各自承担准备、处理、验证及结束责任，不能用移交或延期冒充完成：

- [文件权限与交付验收](../../plan/file-access-and-delivery/README.md)：业务账号隔离、登录 HTTP 权限、QQ 文件/普通回复、工作区导入导出和异步交付/清理组合。
- [图片服务与会话绘图验收](../../plan/image-services-and-drawing/README.md)：Imagen、各厂商实际服务、完整绘图与图片产品验证、首次绘图查询 400。
- [服务端工具完整流程](../../plan/server-tools-completion/README.md)：真实任务验证管理、完整事件顺序、受保护续接及 GLM/GPT 多轮；其中仍有实现缺口。
- [外部设置默认核实](../../plan/external-setting-defaults/README.md)：四项默认的官方依据与后续具体方案；继续显示未核实并保护原值。

已通过第 1—7 批的适用项不重测，7A3 保持跳过。下一执行者按各入口检查所缺条件和权限，不自动恢复已关闭的真实调用批次。

### 设置保存与最近回读

现有 `85 ↔ 84` 的双端保存/恢复、无额外变化与无警告证据继续适用，不重复保存。最近只读核对为质量 `85`、修订 `config-135364019cfd311f97cc4bffda404fa9c55531eb7f168afa204d40217d6e2d9b`、`applied`，不是本次恢复 `84` 的证明，也不作为环境永久当前值。证据在 `/home/chery/docker/cherynyxus/releases/settings-defaults-fix-20261022/`：

- `step1-web-save-84.json`、`step2-manager-restore-85.json`、`step3-save-84-no-warning.json`：双端实际保存与采用、仅质量变化和受保护摘要保持。
- `step4-manager-invalid-101.json`：Manager 页面非法值拒绝且配置未变；`step5-stale-manager-conflict-85.json`、`step6-settings-acceptance.json`：旧页面拒绝覆盖、保留草稿及最近回读。
- `backend-invalid-input-1792659368651.json`：机器维护身份的核心 `config.preview` 和设置插件管理 `PUT files` 对质量 101 均为 400，未写配置。不扩大为直接无效 `config.save`、浏览器模块 HTTP 或跨业务账号权限通过。

两项未登录拒绝已有证据：Manager `GET /api/modules/capabilities/files` 401、Web `POST /api/file-services/drawings` 401。它们只证明对应入口无凭据请求拒绝，不证明登录后全部权限正确。

### 文件草稿与绘图查询边界

草稿已完成附件预览、失败查询停止自动重复的固定 Web 发布证据位于 `/home/chery/docker/cherynyxus/releases/file-draft-fix-20261021/`：`verification/web-results.json`、`regression-before.*`、`source-manifest.json`、`image-comparison.json`、`deployment-result.json` 和配置/凭据/入口保护记录。原版本为 `cherynyxus-runtime:file-draft-fix-20261021`，后续已叠加发布，不冒充实时版本；维护命令归该目录 README，原六份 Compose 清单加本目录 `release.yaml` 不能省略。

首次 `POST /api/file-services/drawings` 400 缺同一次原始请求与响应，原因未定位。空绘图列表查询不要求配置服务，不能推测无服务、GIF 或权限是原因；停止重复查询不代表首次拒绝已解决，后续定位归[ID05](../../plan/image-services-and-drawing/README.md#小任务台账)。

合规原图直接复用时，前端现按返回版本标识引用，不再把原版本误标为 adapted。7B 用户反馈和固定版本证据在 `/home/chery/docker/cherynyxus/releases/image-variant-reuse-fix-20261022/step8-batch7b-history-card-check.json`：`360.gif`、版本 `a6a0fc04-7719-41f1-9dbb-89d9077faa94`、`original`，请求 `completed/omit`、`binaryBytes=0`。仅说明该附件未读入，不代表没有文字模型调用。

### QQ 完整纯文字收发

文字收发通过，输入中的“不调用工具”条件未通过；普通 `qq.reply.part`、文件及断线恢复仍未验收。不要求用户重发，也不修改“不调用工具”的含义。

- `/home/chery/docker/cherynyxus/releases/file-capabilities-live-20261021/qq-send.json`、`user-feedback.json`：直接 NapCat 通道向群 `980129567` 发 1 条测试标识纯文字，消息 `1317856517`，用户确认群内看到；仅直接通道送达通过，原最多 2 条授权不自动消耗剩余次数。
- `/home/chery/docker/cherynyxus/releases/file-capabilities-qq-resume-20261021/`：同镜像解除部署暂停和获准插件替换的 `plugin-replacement-result.json`、`qq-after-plugin-replacement.json`、`online-probe.json`。当时 QQ `0.1.42`、连接/身份及原生在线通过，NapCat 本体未重启，配置/凭据和 4 群保持；管理状态的在线 null 不冒充在线证据。后续维护须重新核对配套版本，不重跑一次性恢复脚本。
- 同目录 `qq-full-text-result.json`、`qq-full-text-user-feedback.json`：用户触发任务 `7f6a82ab-740d-4f7d-8d07-4dd132c165f2`、Core 请求 `d4927caf-d6ef-412f-9505-7837520cd9f4` 完成，引用回复回执 `52340882` 与用户“已收到”反馈关联。
- 同目录 `qq-tool-use-investigation.json`：用户“不调用工具”原文未丢，实际调用 `qq_quote_reply`、`completeReply=true`，经 `qq.reply.action/quote` 发出，收尾不再发普通 part；没有当次完整模型请求响应，不能确定模型选择工具的原因。不新增关键词禁用或自动重试来凑通过。

QQ 文件、混合输入、纯文件完成、普通回复及未知发送由[FA02](../../plan/file-access-and-delivery/README.md#小任务与恢复条件)接手。回执、任务完成和用户收到分别核对，不能互相替代。

### 模型与绘图证据适用范围

MiniMax 本批三次已有携图描述，证据位于 `/home/chery/docker/cherynyxus/releases/file-capabilities-live-20261021/authorization.json`、`minimax-results.json`、`workspace.json`：2026-10-21 的混合源码，型号 `minimax-m3.1-flash-preview`，隔离保留配置 2 轮，首次、普通保留轮和脚本明确重读均实际携带同一原图并返回非空描述。三次已用完，不重发；准确性、完整角色运行、模型自主重读和生产 1 轮策略不在该通过范围。生产配置摘要前后相同，未把 2 轮测试配置写回。

绘图离线证据为 `/tmp/opencode/file-capabilities-drawing-20261021/` 与 `/tmp/opencode/file-capabilities-drawing-recovery-20261021/`，对象是基于 `77af4f3214b309e76f5947b89c85201a5809cabd` 的混合源码，不是固定提交或生产验证；目录 `workspace.json` 和各同名 JSON 标识实际断言与日志。后端 26 文件/284 项、Web 10 文件/51 项、设置插件 2 文件/8 项、当时类型/构建与协议辅助检查通过，不证明真实生成、编辑、运行配置迁移或界面通过。原始输出在相应剩余核对结束前由接手执行者保留；临时目录缺失时如实报告证据不可访问，不新增收费请求补证。

GLM/GPT 成功与失败样本、次数、接口差异及未决条件由[服务端工具设计](../../plan/server-tools-completion/design.md)保留；原生能力、服务端执行、目录说明和已观察事件分别判断。

### 已提交内容的离线检查限制

本地功能提交范围 `becb90ca..96679b95` 的最终 tree 为 `3762e045d5d3be8219328a9041437fe697b50dd6`，与拆分前选定的 201 文件内容一致。证据为 `/tmp/opencode/file-capabilities-split-20261022/commits.json`、`rewrite-result.json`，原副本/基准比较在 `/tmp/opencode/file-capabilities-closeout-20261022/`，基准 `f335b594ae2e0ec91c9e69cef414169938effcc6`；本地备份引用 `refs/backup/file-capabilities-before-split-20261022`。这些是固定对象检查，不推广到共享工作区的其他改动。

相关后端 26 文件/414 项、设置插件 2 文件/10 项和 Backend/Web/设置插件构建通过；Web/设置插件类型通过。后端 `service/chat/send.ts` resume 签名、`service/ingress/coreAdapter.ts` 未使用 `submitting` 两项类型错误，Web `lite/singleConnection.test.ts` 一项源码断言，协议 `responseParameterMatrix.test.ts` 八项样例失败，均在该基准复现。独立文档副本有四项既有问题；不能宣称所有检查通过，也不为隐藏错误夹带其他任务修复。恢复时先核对后续任务是否已修正，再决定是否重验；已批准的设置/常规文件人工结论不因此自动作废。

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
