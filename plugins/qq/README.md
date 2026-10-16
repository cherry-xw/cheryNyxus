# QQ 持续助手模块

QQ业务由本包负责，NapCat适配器只整理事件和收发，Manager仅提供受保护的设置页面。入口为 `src/index.ts`，协议为 `../../packages/protocol/src/qq.ts`。

## 实现与使用边界

群消息只在允许群缓存；@唤醒后普通接话进入内部参与判断。`qq_participation_decide`给出reply/wait/end，wait/end不发送空回答，end关闭活跃状态。请求顺序执行，不因新消息中断；连续输入按合并等待处理。同群与预设复用会话，后台收尾摘要不会发到QQ。

私聊记忆按个人隔离；群事实统一归属于群，主题、事件和成员公开经验保留来源与证据类型，不再只读取当前发送者成员记忆。群工具为qq_group_memory_search和qq_group_memory_manage，默认80条、每条160个Unicode字符，注入文字有单独预算。旧group/member记录不兼容、不导入，新群事实库从空记录开始；旧文件仅留备份用途；新事实须校验当前群消息来源。压缩提交前沉淀候选，失败保留原历史。共享文件仍必须通过专用工具写入个人QQ号目录，仅share子目录公开。通用个人文件读写不接受 `apps/` 路径；受管应用文件须通过 `managed_app` 在工作容器内操作，权限边界见[角色安全](../../docs/backend/agent/role-security.md#受管请求)，验证入口为 `test/managedAppFiles.test.ts`。

## 对话与语音

任务理解与事实优先于人设。请求携带当前及合并输入、可查的引用、最近四次请求与最近八条实际动作状态；回复正文只标为AI自述。背景最多30条，按有效期过滤，使用上海时间。系统对话规则与摘要证据规则由 `src/conversation.ts` 提供，风格设置不能要求否认事实或忽略合理任务。

语音设置 `voiceMode` 为 off/requested/auto，默认 requested；不保留 voiceEnabled。requested 仅允许明确要求或同一发送者对最近已确认语音的修改，情绪反馈不授权语音或戳人。每请求最多一条语音，工具不接受声音参数，由后端固定填入 voiceDefaultCharacter 并检查真实目录；不可用不随机替换。设置页面选择允许群，经受保护 GET voices?groupId 查询 NapCat 真实目录，显示名称下拉与离线/加载/空状态，不写死列表，不自动发测试音。

历史重置使用持久 contextEpoch 隔离新会话，同时清空讨论缓存和摘要，不清投递记录、去重、任务、登录、配置或文件。运行中不直接改文件，维护时须停写并核对非终态任务；旧任务保留原会话，不能作为新上下文读取。重置隔离不是物理删除历史数据库。部署前旧配置和旧任务快照须一次性更新语音字段，不提供运行时兼容层。

## 只读信息查询

QQ 请求通过 `qq_information` 查询当前群或自己的私聊，不接受模型指定群号、其他私聊或任意 Action。随包技能 [`qq-information`](skills/qq-information/SKILL.md) 由宿主按 QQ 身份提供，脚本负责输入检查，`src/information.ts` 注册工具，`src/index.ts` 绑定当前执行任务，NapCat 的 `queryInformation` 只执行固定只读调用。

私聊 history 使用宿主 `recentConversationMessages`，SQL 限制最多100条，读当前机器人会话已经记录的用户和助手正文，可跨上下文压缩点；不返回撤回、排除、压缩摘要和工具记录。每条最多400字符，输出标注限制；这不是QQ客户端全部历史。群消息使用 NapCat 的近期历史，不扫描全群计算排名。群资料包括成员、资料地区、公告、群文件与链接、精华、相册和荣誉；资料查询先校验当前群成员身份。空值不推断，接口错误不自动重试。

工具只在可信 QQ 请求中加入本次执行，沿用原有预设和允许名单；插件技能不会复制到全局技能目录。技能随启用的 QQ 安装包按请求身份提供，无须在每个角色上复制；角色若设置技能允许名单，仍须允许该插件技能。私聊名单为空仍不允许私聊，不为启用技能擅自添加用户。查询结果是资料而非指令，下载链接仅按需提供，不自动执行或公开文件。协议与验证见[QQ插件协议](../../docs/shared/protocol/qqbot-plugin.md)；定向测试为 `test/information.test.ts`、`test/informationWire.test.ts`，宿主历史及安装资源验证为 `apps/backend/test/service/qqInformationHistory.test.ts` 与 `qqInformationResources.test.ts`。本地历史限当前月份消息库，不代表跨月查询。

## 定时提醒与引用回复

群提醒通过qq_reminder_create/list/cancel创建、查询与取消，仅发送者能管理自己在本群的任务。一次性时间使用带时区ISO格式，到期直接加入QQ队列，不额外调用模型。重启恢复未投递任务；投递不确定禁止自动重发。引用回复工具qq_quote_reply只允许当前群背景内的消息ID，NapCat发送原生reply段。

## 应用到期通知

宿主通过可选 `appNotifications` 接口领取受管应用的持久通知，QQ 模块复用现有 Outbox 与原生投递确认。优先选择已有记录且当前允许的本人私聊，否则仅使用创建时记录且当前允许的群；没有可信目标则不发送、不扩大名单。通知不含激活链接；投递不确定不重发。实现入口为 `enqueueAppNotifications`，测试见 `test/appNotifications.test.ts`。源码测试不代表新通知已经部署或完成真实 QQ 验收。

## 媒体下载与清理

公开B站视频及抖音分享文字走固定下载流程，不需要模型。B站使用yt-dlp读取格式、检查音视频合计长度，在150 MiB内选择最高不超过1080P的版本，用ffmpeg合并。抖音使用Playwright读取作品数据，可用多版本时选择已核实大小的适合版本。大小未知拒绝，下载过程限制大小；JSON卡片只提取允许域名的链接，只有标题封面不猜。两站复用media目录及下载锁，每日清理超过24小时文件，未确认投递文件受保护。图片仍有独立的单图限制，不能把视频限制解释为相册总量限制。

## 开发入口

- `src/participation.ts`：决策工具参数及可信请求检查。
- `src/state.ts`：队列、发送确认、群讨论与重启恢复。
- `src/memory.ts`：私聊记忆保存、容量与整理。
- `src/groupMemory.ts`：群主题事实、来源及检索。
- `src/reminders.ts`：提醒持久存储与可信身份管理。
- `src/replyTools.ts`：原生动作与引用回复工具。
- `skills/douyin-download-send/scripts/`：两站下载、大小限制及合并。
- `ui/QqPanel.vue`：QQ配置页面。
- `test/`：个人文件、当前记忆格式与队列测试。

构建使用 `npm --prefix plugins/qq run build`；Backend通信与请求循环测试位于 `../../apps/backend/test/service/qqPluginWire.test.ts` 和 `../../apps/backend/test/agent/middleware/qqRequest.test.ts`。

## 当前限制与验证边界

真实 QQ 发送和媒体功能已通过用户验收，不再等待这两项实际业务验证。该结论不扩展为所有异常场景、Manager 页面或其他模块均已验收，也不表示下列已知问题已修复。

QQ安装包独立持久化，Backend镜像标签不能代表已安装插件版本，源码版本也不能作为当前部署版本的证据。Manager是可选设置面，不是消息链路依赖。

构建、类型与定向测试通过不代表所有群场景已验收。后续修改按影响范围核对多人合并、参与判断、摘要、群事实、提醒、投递异常和重启恢复；不能将这些异常场景的待核对项解释为真实发送或媒体尚未验收。真实群动作由用户触发，不自动发送测试。

声音设置与语音策略见[对话与语音](#对话与语音)，未配置可用固定声音或当前输入未授权时隐藏语音工具。群事实保存在 `memory/topics`，但 `src/index.ts` 的 `qq.memory.stats` 仍只遍历 `personal/group/member`，未统计新群事实；该接口返回 `files`，`ui/QqPanel.vue` 却读取 `scopes` 和 `entries`，统计展示尚未正确接入。来源消息存在不能证明事实结论正确。RUN_UNKNOWN_FAILED的原始底层异常尚未定位；投递不确定的旧动作不得重发。

自动验证还有明确限制：`qqProcessRestart.test.ts` 依赖预构建的子进程程序，`qqRestart.vite.config.ts` 的 `@` 路径仍指向不存在的根 `src`；即使在独立验证副本纠正路径，未知投递用例仍期望 `paused`，而 `confirm` 写入 `failed/DELIVERY_UNKNOWN`，不能将该用例标为通过。抖音 `saveMedia` 仅检查大小上限及文件开头，没有比较收到字节数与 Content-Length；短响应可能被接受，完整性保护尚不完整。上述限制不等于新的开发授权，发现实际问题后单独处理。

群聊确认表情先持久化入发送队列，再按 `notBefore` 延迟 1.5–5 秒发送；正文不能越过队列中的确认表情。避免正文先完成后，延迟回调追加的确认无人处理。已重建本地安装包，`qqPluginWire.test.ts` 与工具说明测试合计 16 项通过；此结果不是实际 QQ 发送验收。

持久数据使用严格校验，未知字段或格式损坏直接报错，不自动剥除字段或覆盖原文件；损坏记忆回归已通过，插件 11 文件 38 项通过。

修改本模块前读取项目AGENTS.md及相关规范，同步本说明、协议与验证入口；需要跨会话跟踪的新工作按项目要求建立独立计划。
