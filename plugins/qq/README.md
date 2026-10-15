# QQ 持续助手模块

QQ业务由本包负责，NapCat适配器只整理事件和收发，Manager仅提供受保护的设置页面。入口为 `src/index.ts`，协议为 `../../packages/protocol/src/qq.ts`。

## 实现与使用边界

群消息只在允许群缓存；@唤醒后普通接话进入内部参与判断。`qq_participation_decide`给出reply/wait/end，wait/end不发送空回答，end关闭活跃状态。请求顺序执行，不因新消息中断；连续输入按合并等待处理。同群与预设复用会话，后台收尾摘要不会发到QQ。

私聊记忆按个人隔离；群事实统一归属于群，主题、事件和成员公开经验保留来源与证据类型，不再只读取当前发送者成员记忆。群工具为qq_group_memory_search和qq_group_memory_manage，默认80条、每条160个Unicode字符，注入文字有单独预算。旧group/member记录不兼容、不导入，新群事实库从空记录开始；旧文件仅留备份用途；新事实须校验当前群消息来源。压缩提交前沉淀候选，失败保留原历史。共享文件仍必须通过专用工具写入个人QQ号目录，仅share子目录公开。

## 定时提醒与引用回复

群提醒通过qq_reminder_create/list/cancel创建、查询与取消，仅发送者能管理自己在本群的任务。一次性时间使用带时区ISO格式，到期直接加入QQ队列，不额外调用模型。重启恢复未投递任务；投递不确定禁止自动重发。引用回复工具qq_quote_reply只允许当前群背景内的消息ID，NapCat发送原生reply段。

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

声音选择仍为ID输入，未配置有效默认声音时隐藏语音工具。群事实保存在 `memory/topics`，但 `src/index.ts` 的 `qq.memory.stats` 仍只遍历 `personal/group/member`，未统计新群事实；该接口返回 `files`，`ui/QqPanel.vue` 却读取 `scopes` 和 `entries`，统计展示尚未正确接入。来源消息存在不能证明事实结论正确。RUN_UNKNOWN_FAILED的原始底层异常尚未定位；投递不确定的旧动作不得重发。

自动验证还有明确限制：`qqProcessRestart.test.ts` 依赖预构建的子进程程序，`qqRestart.vite.config.ts` 的 `@` 路径仍指向不存在的根 `src`；即使在独立验证副本纠正路径，未知投递用例仍期望 `paused`，而 `confirm` 写入 `failed/DELIVERY_UNKNOWN`，不能将该用例标为通过。抖音 `saveMedia` 仅检查大小上限及文件开头，没有比较收到字节数与 Content-Length；短响应可能被接受，完整性保护尚不完整。上述限制不等于新的开发授权，发现实际问题后单独处理。

`test/qqBusiness.test.ts` 的损坏记忆用例当前也存在失败：写入损坏记录后，`prepare` 未按断言拒绝，单独重跑仍失败；原因尚未确认，不能标为通过或删除该断言。

修改本模块前读取项目AGENTS.md及相关规范，同步本说明、协议与验证入口；需要跨会话跟踪的新工作按项目要求建立独立计划。
