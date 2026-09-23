# 工作台 Lite 极简 UI（交互设计）

> **状态：定稿 v0.2（T31 评审通过；W1-W5 契约修正已落盘，5 个遗漏场景与 A-E 定案由本版补全）**。实现状态：**L0-L4 全部已实现（implemented，T33-T37）**。目标：在 Web 工作台模式中，基于已实现的 lite profile API（P0+P1）增加一套全新的极简 UI，顶层一键切换，突出展示「极少量流量即可完成完整交互」这一方案核心优势。
> 本文件是**交互设计定稿**，按 doc-first 规范可进入 L0 实现；后续变更须先改本文并标注状态。

## 修订记录

| 版本 | 变更 |
|---|---|
| v3.0（增量） | **cluster 工具小图标放大 + 上移避让状态条（用户需求 2026-09-21，§4.13）**：①**图标 13→15px**——`.lite-cluster-node` 内 MorphIcon `size` 由 13 提为 15，图标更大更清晰；②**图标微上移**——`.lite-cluster-icon` 加 `margin-bottom: 4px`（flex 居中下图标本体上移约 2px），与贴底的状态条（bottom 0 / 高 3px）留出约 2.5px 空隙，不再粘连；③**全部任务卡片**（同批，TaskBrowser.styles.less）：去掉固定 `height: 200px` + `overflow: hidden`——卡片随内容撑开、全部区块可见，卡片内「•••」下拉菜单不再被 `overflow: hidden` 误裁剪；「最近要求/详情」仍保持单行省略（`overflow:hidden` 只留在省略处）；④**卡片去边缘高亮**：删除 `status-*` 顶部彩色描边线（`border-top-color`）与未读左侧亮条（`inset 3px 0 var(--accent)`）——状态改由卡片内状态徽章 + 整卡 4% 极淡状态底色表达，未读由「未查看结果」徽章表达；⑤**诊断/桌面窗口标题栏按钮右对齐修复**（CyberWindow.vue）：`margin-left: auto` 从 `.cyber-window-signal` 移到 `.cyber-window-actions`——原挂在 signal 上，窗口 ≤620px 触发容器查询隐藏 signal 后最小化/最大化/关闭按钮会失去右对齐而贴到标题后；改挂 actions 后按钮组始终居右、与标题保持间隙。回归测试 `web/test/ui/uiRegressionFixes.test.ts` |
| v2.9（增量） | **cluster 工具小图标换可变形图标库 + 按工具类型固定差异化（用户需求 2026-09-20，§4.13）**：①**图标改 lucide 矢量（morphicons 渲染）**——cluster 小方框图标由 ASCII glyph（命令 `>_`/读取 `<`/写入 `>`/网页 `@`/委派 `>>`/其他 `*`）改为 lucide 家族本源图标（exec=SquareTerminal / read=BookOpen / write=PenLine / web=Globe / dispatch=Forward / other=Wrench），与节点树 workflowVisuals 同族；图标与颜色**固定关联工具类型**（六类专属色，与详情抽屉 `.lite-drawer-type` type chip 同色板：exec 紫 / read 灰蓝 / write 绿 / web 青 / dispatch 橙 / other 金黄），不再把终态统一替换成勾/叉状态图标——**运行状态与成功/失败改由底部状态条表达**（running 绿闪 / completed 绿 / failed·rejected 红 / cancelled 灰）；②**底部状态条收敛**——左右内缩 2→5px（变短）、高度 2→3px（变粗），视觉更克制；③非工具节点（user/root-agent/child-agent/return/dispatch/spawn/system）各配 lucide 图标，未知工具回退 Wrench；`clusterIcons.ts` 为唯一映射源，测试 `clusterIcons.test.ts` 锁定 |
| v2.8（增量） | **工具 icon 闲启动效 + 最终响应去详情按钮 + 行内思考折叠 + 用户指令 token 样式（用户需求 2026-11，§4.1/§4.4/§4.13）**：①**工具 icon 动效**——cluster 工具小按钮的 ASCII glyph 在**运行结束后**按工具类型做小幅循环动效（命令=上下轻跳 2px / 读取=左右微移 1.5px / 写入=轻压+2° 微转 / 网页=7s 慢速旋转一周 / 委派=右移 2px / 其他=1.08 呼吸缩放），幅度克制不抢眼；运行中仍由底部状态条闪动反馈、取消态静止，`prefers-reduced-motion` 全部关闭；②**最终响应去「详情」按钮（§4.1）**——最终回复正文全文已直接在页面内滚动展示（v1.3 full 渲染），右上角「详情」按钮删除（用户提问行同删）；工具调用细节仍由 cluster 小按钮 / 轨迹块进入抽屉，信息不丢失；③**行内思考分节（§4.1/§4.4）**——「思考」直接展示在正文行上方，**默认折叠**（▸ 思考，点击展开，文字弱化为 secondary 与正文区分，同详情抽屉 v2.2 交互）；`projectLiteHistory` 为非工具节点透出 `node.thinking`；④**用户指令性消息 token 样式（§4.1）**——用户消息正文中的 `[[command:/…]]` / `[[role:@…]]` token 样式化为彩色小标签（命令=主题金色、角色=蓝，与对话模式 `MessageBubble` 同源 `splitCommandPrompt`），不再裸显示 `[[ ]]` 包裹文本 |
| v2.7（增量） | **展开钮默认隐藏 + 图标重设计 + 空输入滚动条修复（用户需求 2026-11，与对话模式同步，§4.5）**：①**显示逻辑**——发送钮正上方的展开钮（`.lite-expand-btn` / `.conversation-expand-btn`）**默认隐藏，仅当输入内容超过 2 行时出现**（行数按可视行计、含自动换行，`autoGrowInput`/`refreshInput` 重算高度时顺带测量 `inputLines`；内容回落 2 行以内自动收起展开态，避免「已展开却无法收起」）；②**图标重设计**——字符 ▲/▼/⤢/⤡ 改为 Element Plus `Top` 矢量图标（14px，展开态旋转 180° 表「收起」），按钮由 20×20 带边框小方块改为 24×24 无边框幽灵按钮（hover/展开态主色淡底 + 主色，直角）；③**空输入滚动条修复**——输入框高度公式在 `box-sizing: border-box` 下补上边框高度（原 `height = scrollHeight` 使盒子比内容矮 1px×2，空内容也挤出右侧细滚动条） |
| v2.6（重构） | **交互入口迁入详情抽屉（§4.3/§4.4，用户需求 2026-11「参考对话模式，把精简模式提问交互放进页面内容」）**：①**待处理面板移除**——输入区上方常驻的审批/提问面板（浏览器式多页签、收起/展开、`pendingCollapsed`/`pendingTab` 状态）整体删除；**交互入口 = 点击大模型响应回来的工具调用簇按钮** → 详情抽屉，在该**工具调用卡内**完成审批/提问（`LiteInteractionView`），交互完成后卡片自动切回只读展示；②**交互逻辑收敛**——原 `useLiteViewController` 的审批/提问/草稿/提交逻辑整体搬入新组合式 `useLiteInteractions`（单一事实源），详情抽屉（DetailDrawer → LiteToolCallDetail）直接消费；草稿仍持久化 `rootUi.interactionDrafts`（按窗口 × 根会话），关抽屉再开不丢已答内容；③**铃铛语义更新**——精简模式点击铃铛 = 打开**最早待处理交互**所在节点的详情抽屉并聚焦其工具卡（`rootUi.attentionOpenRequest` 请求，lite 视图消费后清空），角标仍显示待处理数量；④**配置管理工具（config_manage）安全判定**：由「未知」改为**中风险**（写操作须审批，读操作 get/asset_get 直接放行且无判定），风险等级固定四档：未知 / 高风险 / 中风险 / 安全（§4.4 徽章，后端 rolePolicy §见 role-security.md）；⑤**精简模式配置管理参数展示（LiteFieldRows）**：标题在上、内容在下两行式（原左右单行），内容允许任意位置断点换行（`word-break: break-all`，原 break-word 错误）；⑥**工具卡标题去重**：`LiteToolCallDetail` 头部只留 icon + 风险徽章（未知/安全/中/高）——工具名/类型/状态/耗时已由抽屉标题栏承担，工具卡内「写入」「已完成」等冗余标签删除 |
| v2.5（增量） | **工具详情「执行说明」去重 + 提问工具专用展示 + 结果区统一（用户需求，§4.4）**：①**执行说明区只保留标题栏没有的信息**——抽屉标题栏已含工具名/状态/耗时，工具卡删除动作句（已读取文件…）与状态句（执行完成），仅留「目标」代码块与「本次变更」列表，皆无则整区不显示；②**提问工具（ask_user_question）展示名改「询问用户」**（approvalPresentation，原「用户交互」）；③**提问工具标题 + 说明移到「参数」上方**——header 作标题、rationale/nextStep 用「为什么需要你决定」「决定后会发生什么」中文标签（这三个键是大模型写的数据，参数字段行与「更多」折叠区同步排除）；对话模式提问卡片（QuestionRenderer）与树视图悬停详情（QuestionAnswerDetail）补上同两条说明（数据一致）；④**选项说明完整展示在选项文字下方**（去掉 45% 省略号截断）；⑤**结果直接渲染进选项**——已答选中项 ✓ + 主色高亮、取消显示「用户已取消该问题」、自由文本/补充注记照树视图样式，提问工具不再单列「原始结果」；⑥**结果区统一（非提问工具）**——短结果（原文 ≤200 字符）默认展开直接展示；长结果默认折叠 + 一句摘要预览，展开后完整内容替换预览；⑦**删除代码写死的说明上 UI**——未知工具首行的 `sense.tools` description 说明行删除（`toolDescriptionLine` 随之移除），任务中心提问面板的兜底文案（context.source='fallback'）不再展示 |
| v2.4（增量） | **精简模式 icon 全局放大 + 对话模式折叠标签悬浮详情字号加大（用户需求 2026-10）**：①**lite icon 统一放大**——`LiteView` 页面 6 处 icon（lane 页签 12→15px、历史行/委派入口 icon 18px 宽→20px 宽 + 15px 字、cluster 工具 tag 13→15px、待处理页签 14→16px、时间轴 tip icon 继承→15px）；②**对话模式折叠工具标签悬浮弹出框（`.sense-tag-detail-popper`）内容字号再放大一档**——内层渲染器（SenseCallBox + 全部专用渲染器）主体/名称 15px、参数/代码/内容区 14-14.5px、状态符号 16px（对比对话流展开态再大 2px，悬浮临时查看更易读）。改动只调字号，不影响组件结构。**像素卡片豁免**：桌宠纸牌卡（`PaperGameCard.styles.less`/`NodePaperStack.styles.less`）保持 pixel-font 契约字号（`--paper-font-caption: 10px`、body 13px、title 16px，测试 `paperStackIntegration.test.ts` 锁定），不随全局放大；上轮 v2.3 误触及处已按行级回退。 |
| v2.3（增量） | **工作台全局字号放大 +2、最小 12px（用户需求 2026-10「大量内容字号小于 12px，全部放大」）**：对工作台三视图（树/对话/精简）及其弹窗、输入框、内容文本统一执行「原字号 +2px、下限 12px」——10px→12、11px→13、12px→14、13px→15…，半像素字号同步 +2（10.5→12.5、11.5→13.5、12.5→14.5）；覆盖 `web/src/features/agent/`（弹窗/消息内容/工具渲染器/设置/待处理等）+ `web/src/features/lite/`（精简视图 + 详情抽屉 + 思考正文）+ `web/src/features/desktop/`（窗口外壳/连接状态）+ `web/src/features/pets/nyxus/`（树视图节点弹窗，`nyxusPopoverTheme.less` 原 8.5-11px→12-13px→现 14-15px）+ `web/src/components/media/`（内容播放器控制条）+ **全局 Markdown 渲染 `web/src/styles/markdown.less`**（标题 12→14px、行内 code 10.5→12.5px、代码块 10→12px、表格 9.5→12px，消息/工具内容正文统一受益）+ `font:` 简写与字号 CSS 变量（`--popover-content-font` 12/13→14/15px 等）同步处理。桌宠本体（`pets/components/` 气泡/名字/图标等装饰性小字号）与纯数字徽标（App.vue 8px 计数徽章）不在本次范围（规范豁免的装饰设计）。改动只调字号值，不影响组件结构；`docs/standards/frontend/design-language.md` 字号基线同步更新。 |
| v2.2（增量） | **输入框展开交互 + 思考分节默认折叠弱化 + 未知工具卡片不透明背景（用户需求 2026-10）**：①**输入框展开交互（§4.5，与对话模式同步）**——默认保持 6 行（120px）上限；发送钮正上方新增展开钮（`.lite-expand-btn`，⤢/⤡，el-tooltip 提示，状态存 `LiteView` 组件内 ref 不持久化），点击后输入框高度提升到**至少 12 行（`min-height: min(240px, 50vh)`）、最高窗口一半（`max-height: 50vh`）**，大段内容输入不再在小框中翻页滚动；②**详情抽屉思考分节（§4.4）默认折叠 + 文本弱化**——「思考」标题改可点击切换钮（▸/▾，aria-expanded），默认收起；展开后思考内容文字色降为 `--el-text-color-secondary`（与正文 `--el-text-color-primary` 区分，降低视觉权重）；③**未知工具通用渲染器 `SenseCallBox` 背景改不透明 `var(--surface)`**（原半透明 `var(--surface-soft)` 在深色主题/折叠 tag 悬浮层上与背后内容重叠导致文字不清，与已注册专用渲染器背景一致） |
| v2.1（增量） | **右侧 rail「对话模式」按钮移除 + 工具风险 tag 圆角化/折叠小圆点 + 按钮说明 tip 化（用户需求 2026-09-17）**：①**右侧 rail「会话工具」组的「对话模式」按钮（↺）移除**——对话模式入口统一由**标题栏三档切换钮（树/对话/精简）**承担，rail 不再放第二入口；`useWorkbenchDialogController.toggleConversationView` 随之删除（唯一调用方即该按钮），`conversationViewVisible` 保留（shell 样式/条件渲染仍用）；②**风险徽章（安全/中/高/未知）圆角化**——共享 `RiskBadge` 的 `.risk-chip` 由直角改 `border-radius: 999px` 圆角 tag，与消息区/工具标签的圆角风格一致（用户确认，覆盖 v1.2「lite 直角化」对风险 chip 的直角要求，lite 端头部 tag 同步改圆角保持一致）；③**折叠工具调用标签模式风险 tag 改小圆点**——`MessageBubble` 折叠标签内 `<RiskBadge compact>` 改 `dotOnly`：仅显示 8px 语义色圆点，hover 圆点 el-tooltip 显示「等级（N 项判定）」，不再用原生 title（且同步移除 sense-tag 上冗余的 `title="工具名"`——hover 已弹完整渲染器内容，双 tooltip 重叠）；④**抽屉右上角按钮说明 title→tip**——`HistoryDrawerPanel` 的「折叠工具调用」🧰 与「消息折叠层级」👥🙈🎯 按钮的 `title` 改 `el-tooltip`（含 aria-label 保持无障碍），遵守 AGENTS.md 新增「说明呈现方式优先级」（title 最后考虑） | **工具详情展示重排（§4.4，用户需求「详情内容排版优化」）**：①**字号整体加大（不加粗，字重仍 400）**——工具卡头部/故事/字段/结果全部字号上调（正文 12→13.5px、标题 12.5→14px、代码 11.5→13px 等），细节见实现；②**工具调用右上角 tag 统一尺寸**——工具类型徽标、执行状态、风险判定（RiskBadge compact）统一为 12px 字 / 20px 高 / 8px 横内距（`LiteToolCallDetail` 与 `DetailDrawer` 头部同套）；③**「加载更多工具」按钮改「继续加载更多工具内容」**——原文案像「执行完成状态下的说明」语义不明；新文案 + title 提示「参数或结果内容较长，未全部取回」，样式改虚线通栏按钮；并修复游标页 hasMore 卡死边界（最后一块恰好凑满 limit 时按钮恒真无法终止，`detailSections.ts` 不再对游标页套 fullPage 兜底）；④**工具详情首次打开自动走完游标链**——`chat.timeline.node.get` 协议每页只返回一个调用的一个字段，原实现一次只显示一条工具、其余要反复点「加载更多」（用户抱怨「每个都需要点击展开，下面全空白」）；现 `DetailDrawer.loadToolCallsChain` 沿 `page.nextCursor` 顺序拉取（上限 24 页）一次取回全部工具调用，剩余由续拉按钮承接；⑤**参数默认展开**——`LiteToolCallDetail` 参数 `<details>` 默认 open（原「查看完整参数」折叠），结果区保持折叠；⑥**按工具类型渲染**——「问题 + 选项」形态参数（`question` + `options` + `multi_select`，如 ask_user_question 类）用单选（○）/多选（□）选项列表区块展示，不再把 options 原文 JSON 列出；标量数组字段（文件列表/标签等）渲染为逐行点号列表；⑦**未知工具（other）首行展示工具说明**——`sense.tools` description 经 `toolMeta` 透出，`toolRendering.toolDescriptionLine` 取单行摘要，参数区首行「说明」+ 下方 label:content 行结构 |
| v1.9（增量） | **去掉原生 title 显示（§4.11/§4.13，用户需求，v1.8 后实测）**：cluster 小按钮与轨迹块**移除 `title` 属性**——原生系统 tooltip 延迟 1 秒后叠加在自定义 `lite-tip` 浮层上造成双重提示；节点/工具说明仅由自定义浮层与 `aria-label` 承担（无障碍不降级），轨迹块「点击定位下方内容」提示改由浮层底部 `tipAction` 行承接（cluster 悬停显示「点击查看详情」）。 |
| v1.8（增量） | **小图标悬停说明补全（§4.11/§4.13，用户需求「每个小 icon 加 tip，标记节点类型与工具类型名称」）**：cluster 中间节点小按钮不再只有慢速系统原生 title——**复用轨迹块同一套 `lite-tip` 跟随鼠标浮层**（悬停立即显示），浮层新增**工具类型**行（命令/读取/写入/网页/委派/工具）；`title`/`aria-label` 统一由 `nodeTipText()` 生成：节点类型 · 工具类型 · 工具名 · 状态 · 耗时。轨迹块 title 同步走 `nodeTipText()`（保留「点击定位下方内容」提示），浮层工具节点同样显示工具类型行。 |
| v1.7（增量） | **三区域底色分色（§2.2/§4.3/§4.5，实测，用户需求「窗口与列表无分界、三区无法区分」；v1.7a 修正底色归属；v1.7b 换色系）**：①**窗口基底退回页面底色 `var(--bg)`**（比区域暗一档），原 4% 横格线纹样从整窗移入对话列表区；②**区域一·对话列表（阅读区）** = 中性亮面 `var(--surface)` + 淡横格线；③**区域二·提问/审批面板（提醒区）** = **紫色系（`--violet` token 派生；v1.7b 起，原琥珀被用户判定「显脏、不贴合主题」废弃）只加在内容元素上**：tab 按钮自身有底色（非激活中性亮底 `--el-bg-color`、激活 = 内容区紫底连体 + 主色边框文字，浏览器式连体），**标签栏位置保持 v1.2 硬约束：容器恒无底色**（面板透明无边框，边框由 bar 底线 + 内容区三边承担，紫 45%）；提问内容区 = 紫淡底 20% 派生（题干区透出紫底、**选项卡片同族淡紫底 9% 派生 + 常规边框**——v1.7b 用户要求调整选项底色、底部操作栏同家族 26% 更深档 + 紫顶线）；倒计时徽章空白底 + 紫描边；浅色主题 `--nx-cyan` 覆盖块删除；④**区域三·输入区（操作区）** = 主题强调色淡底（`--el-color-primary` 8% 派生）+ 同家族 45% 顶部分隔线。三区全部走主题 token + color-mix，深浅双端自动适配，无新增硬编码色。**硬约束重申（用户多次强调）**：tab 栏位置（标签栏容器背景）任何时候不得有任何底色 |
| v1.6（增量） | **提问区层级精简（§4.3，实测）**：①**去 kicker**——提问区头部 `QUESTION SESSION` 英文标签删除，进度（已完成 x/y）单独靠右；②**去线框标题层**——fieldset 的 legend 线框标题（原 `header \|\| question` 嵌在边框上）删除，问题正文直接作为标题显示在选项上方（fieldset 去边框线框，仅留浅色底）；③**去单选说明**——「单选 · 再点已选项可取消」说明行删除（单选 radio 交互已足够直观），多选（可多选 · 再点已选项可取消）与自由回答（自由回答）提示保留；④**「其他」卡片改 radio+输入框同行**——去掉「其他 / 用自己的话补充回答」文字描述，radio 标记后直接单行输入框（高度与左侧选项卡片一致，不再是大号多行 textarea），点击输入框不触发选项切换（`.stop`），输入内容仍自动激活/勾选 |
| v1.5（增量） | **提问交互重做（占用收缩 + 两列选项 + 补充按钮 + 输入框即选项，§4.3）**：①**左侧问题导航移除**——多问题批次切换统一由底部操作栏左侧分页器承接（左下分页、右下提交）；②**选项两列卡片**——每个选项一张卡片、两两一行（窄屏回落单列），不再整行通栏；③**「补充」按钮**——每个选项卡片内新增「补充」按钮，**仅该选项选中后才可展开**补充输入框（未选中置灰），取消选中即收起并丢弃补充内容；④**默认输入框即选项**——题末常驻「其他」卡片，输入框本身作为单选/多选的一个选项：单选点击（圆形 radio 标记）即抢走其他选项的 active（再点取消；输入内容自动激活并清空其他选中），多选需手动勾选复选框（输入内容自动勾选、清空即取消勾选）；⑤**批次 tab 标签**——同一 root 下多 agent 并存时 tab 前缀 Agent 名区分归属，同一 agent 的多个提问批次显示问题批次号（tooltip 含题数） |
| v1.4（增量） | **发送/运行失败错误信息展示（§4.14）**：与节点树/完整视图同步覆盖全部错误类型——**发送失败**（发送即被拒/命令报错，`submitInput`/`retryInput` 捕获异常写入 `commandError`）→ `.lite-error-banner` 显示（沿用 §4.10 六码分支文案），与 `.lite-failed-inputs`（失败消息行 + 重试/移除，既有行为）并存；重试成功或移除全部失败消息后 banner 清除（`removeFailedInput` 同步清空）；**运行失败**（消息已发出、本轮运行中断，`session.run.status='failed'`）→ 对话流末尾新增 `.lite-run-error` 条展示 `run.error` 一行 + 可选「查看详情」折叠 `errorFact.detail`/tracingId（error-conventions detail 通道）；「继续」沿用状态条 §4.6（canResume 驱动）。互斥与去重：run 错误条仅在无 `commandError` 时显示（banner 优先）；发送失败落 `run.status='paused'` 不被 run 错误条捕获，避免重复展示 |
| v1.3（增量） | **简洁模式全文渲染**：LiteMarkdown 渲染模式由 `preview`（`MARKDOWN_PREVIEW_LIMIT` 12000 字符截断 + 截断提示）改为 `full` 全文渲染（`useRenderedMarkdown` 240ms 节流保留）——正文列表行内容（§4.1）与详情抽屉（§4.4）超 12000 字符不再被渲染层截断。数据侧不变：正文来自 canonical timeline 全文；node.get 仍受 32KB 单响应硬上限（协议层 §3.5/§3.7），由既有分页续拉（30KB/页 + hasMore + 「加载更多」）兜底取全文。`preview` 模式保留给流式气泡等次要预览面（宠物气泡 / AnchoredRunCrt），见 [design-language.md §5.4](../../standards/frontend/design-language.md#54-overlay-与流式-markdown) 模式选用 |
| v1.2（增量） | **简洁模式交互/视觉回归修正（实测）**：①**CRT 扫描光效删除**——`.lite-view::before` 扫描线纹理与 `::after` 全屏扫光带整体移除（光带 z-index 压在内容上干扰阅读，用户确认直接删除）；②**待处理面板标签栏净化**——**面板容器完全透明且无阴影**（不是卡片：无背景、无边框、无投影，按钮行区域与 .lite-view 页面背景完全一致）；**边框从按钮下一行开始**（bar 底部横线 + 内容区左/右/下三边，亮色只存在于内容区卡片与按钮自身）；tab 按钮从最左边开始依次排列，按钮自身（边框+文字）保留、**背景全透明**（激活态仅主色边框+主色文字，不加背景层；浅色主题 box-shadow 内线同步移除）；③**收起/展开按钮重做**——改为带边框 24×24 方形按钮，绝对定位挂在面板右上角、相对标签栏垂直居中（▲ 收起 / ▼ 展开）；④**收起/展开高度动画**——内容区高度 200ms 过渡（visibility 兜底防隐藏后聚焦），`prefers-reduced-motion` 直切；⑤**详情抽屉宽度可拖拽**——抽屉左缘拖拽手柄，宽度 clamp(320px, 拖拽值, 92% 容器宽)，按窗口 × 会话持久于 LiteRootUiState（`detailDrawerWidth`）；⑥**滚动条恢复**——正文区（lite-monitor）与抽屉体（lite-drawer-body）恢复主题化细滚动条（此前隐藏导致长内容只能滚轮慢滚）；⑦**滚动跳顶修复**——滚动链隔离（`overscroll-behavior: contain`）+ 内容塌陷后 scrollTop 恢复 + scrollTop 回写节流，消除「滚到底闪回顶部/无限滚动」观感；⑧**cluster 工具 tag hover 对齐修正**——icon 垂直居中（去掉 2px 底部 padding 挤压）、hover 描边框不再位移、`\|` 分隔线垂直居中；⑨**直角化收尾**——lite 剩余盒类圆角全部清零（状态药丸/按钮/面板/输入框/详情抽屉徽标的 999px/8px/6px/5px/4px → 0），状态点正圆（`border-radius: 50%`）保留 |
| v1.1（增量） | **待处理面板可收起（§4.3）**：标签栏右侧新增 ▲/▼ 收起/展开按钮，收起态仅保留标签栏（高度自适应）贴在输入区上方，内容区隐藏；收起态点击任意标签 = 展开并切换到该交互；**新审批/提问到达不自动展开**（保持收起，激活 tab 的倒计时徽章照常跳动提示）；收起状态按**窗口 × 根会话**隔离存于 LiteRootUiState（`pendingCollapsed`，与 `pendingTab` 同套），切会话互不影响 |
| v1.0（增量） | 浅色可读性与 rail 交互修正（§2.1/§2.2/§4.5/§4.13，实测）：①**切换钮 ⚡ 改 switch**——标题栏切换入口由字符按钮改为 el-switch 开关（选中态实心主色轨+白钮，取代原 26×26 字符按钮的 icon 歪斜/active 不突出）；②**状态条浅色加深**——状态条/链路标签/轨迹行头文字由 `--el-text-color-secondary`（浅色 #909399 过浅）提为主文字色 `--el-text-color-primary`，链路标签非激活加边框、激活实底主色，浅色下可读；③**cluster 工具 tag 状态线弱化 + icon 增强**——底部 2px 状态条不再喧宾夺主（弱化透明度/收窄），icon 字号加大以清晰为主；④**发送按钮高度对齐**——发送按钮与左侧单行输入框等高（同 34px 单行），消除对齐错位；⑤**代码高亮浅色暖色调**——浅色模式不再用 highlight.js 默认蓝系（github.css），改暖色系覆盖（见 design-language.md §2.3） |
| v0.8（增量） | 工具 tag 进一步缩减为**纯字符 + 角标状态**：删除全部可见中文类型标签，状态点从字符左侧移到字符右上角并缩小为 `3px`，不再占用横向布局；tag 可见主体只剩一个 1–2 字符的 ASCII glyph。 |
| v0.7（增量） | **工具调用 tag 与 MCU 显示定稿**（§4.13）：删除 tag 内的工具参数/结果与可见耗时，只显示 `4px 状态点 + ASCII 类型字符 + 两字类型`；禁用 `sense.tools.icon` 的 emoji 渲染，统一字符表为命令 `>_`、读取 `<`、写入 `>`、网络 `@`、委派 `>>`、其他 `*`；tag 去掉边框和常驻底色，运行态绿点离散闪烁，成功绿常亮，失败/拒绝红，取消灰；工具详情、轨迹 tip、审批工具标记复用同一字符表，保证 Web 与字符屏/MCU 一致。 |
| v0.6（增量） | 工具/审批节点样式重做 + 节点色调与节点树统一（§4.11/§4.3/§4.12，实测）：①**cluster 工具小按钮重做**——圆角 pill 改**直角矩形**（全直角规范，§3），背景改中性、仅**边框用工具子类型特征色**（命令紫/读取灰/写入绿/网页青/委派橙/工具金，子类型信息降级为边框维度），icon 与类型文字改**易读主色**（`--lite-tone-tool`，节点树 tool-batch 暖金）；**状态收敛为唯一小色点**（运行中=主色脉冲 / 完成=绿 / 失败·拒绝=红 / 取消=灰），删除按运行时长绿→黄→红边框变色（data-duration）；②**节点色调与节点树统一（去自创色）**——lite 全部 8 类节点（user/root-agent/child-agent/tool/return/dispatch/spawn/system）改用节点树 `nodeSkins.ts` 的 accent 色（浅色 `NODE_ACCENT_LIGHT` / 深色 `NODE_SKINS`，随主题切换），经 `nyxus/public.ts` 导出 `accentForTheme` 提供，lite 以 CSS 变量（`--lite-tone-*`）绑定到 `.lite-view` 根元素，删除 lite 自创色（`#3ddc97`/`#c58af9`/`#a99df6`/`#9b59b6` 等）：历史行 icon、轨迹 bar、子 Agent 入口块（dispatch）全部换主题变量；**轨迹 bar 工具块统一 tool-batch 暖金**（子类型色不再用于窄条色块，悬停浮层仍有工具名/类型）；③**审批操作节点**——待处理页签审批标记（工具 icon）用暖金指示「工具审批」，审批面板头部增加**状态小色点**（与节点同一套状态表达：待处理=暖金 / 处理中=主色脉冲 / 失败·超时=红 / 已完成=绿），允许/拒绝按钮保留；历史行 full 工具节点 icon 同步换 tool-batch 暖金 |
| v0.5.3（增量） | ①**主题色调统一（去蓝，§2.2/§4.11/§4.12）**——深色模式 Element Plus 官方 `dark/css-vars.css` 硬编码默认蓝 `#409eff` 覆盖项目金色（特异性 `html.dark`(0,1,1) > `:root`(0,1,0)），修复为 `theme.css` 的 `html.dark` 块显式覆盖：el 语义色 primary=暖金 `#f6b73c` + 派生 light-N/dark-2 + 深色 success/warning/danger/info 变体，浅深双端统一主题色调；深色 hljs 代码高亮蓝色 token 改暖色（数字/变量→金、字符串→绿等，不含蓝）；工作台会话列表硬编码暖金 rgba 收敛为主题 token（`var(--accent)`/`var(--ink)`/`var(--border)` + `color-mix`）；主题色调规范见 design-language.md §3.3；②**链路标签栏迁移（§4.12）**——链路标签栏从正文列表顶部（monitor 上方）迁入顶部状态条（lite-statusbar）内，顶层直接展示多个 Agent 标签（主 Agent ✧ + 各子 Agent ◆ 角色名），激活高亮、点击切换 activeLane，与轨迹行头联动不变 |
| v0.5.2（增量） | 轨迹实测修复（§4.11，实测）：①**块序列化推进修遮挡**——块 left 由纯时间 gap 定位（gap 封顶 24px）改为「时间 gap 位置与前一块右缘 + 1px 取大」的序列化推进，线性流程同一轨道内块间**最低 1px 间隔、绝不互相遮挡**（gap 增量上限 24px 远小于块宽上限 180px，原模型长耗时块必然压住后续块）；时间 gap 在块不挤时仍保留占位；②**模型节点耗时匹配修正**——原「仅 `direction==='agent-to-user'` 才匹配 execution step」条件在 canonical rootTimeline（不投影 direction 字段）下恒不成立，主/子 Agent 响应节点全部回退 0 耗时 → 宽度全落 10px 下限；改为主/子 Agent 节点直接匹配 model step，耗时真实生效（1s=1px 铺开，不再「都是 10px」） |
| v0.5.1（增量） | 轨迹宽度模型修正（§4.11，实测）：①**执行节点两档 clamp**——空间足够时 1s=1px、clamp `[10, 180]`（MIN_BAR_PX=10 / MAX_BAR_PX=180）；一行放不下时切换**挤压档** clamp `[10, 30]`（COMPRESSED_MAX_BAR_PX=30）；②**挤压判定口径修正**——由「含时间 gap 的 left+width 是否超视口」改为「块固有宽之和 + 1px 间隙的紧凑口径」判定，时间 gap 只占位布局、不参与挤压判定，避免长会话时间空隙撑爆宽度导致 180px 档被跳过（挤压后 30px 由「块真排不排得下」决定，非 gap 占位）；③**事件节点下限 clamp**——用户/返回/委派等事件节点固定宽 × zoom 同样 clamp 下限 10（缩放 0.4x 时不窄于 10px，保证可点击命中） |
| v0.5（增量） | 链路展示改造（§4.12，实测）：①**正文列表顶部链路标签栏**——「一次只展示一条链路」的切换不再仅依赖轨迹行头点击（隐蔽、正文侧无任何指示），改为正文列表顶部常驻链路标签栏：主 Agent 链路（✧）+ 各子 Agent 链路（◆ 角色名），激活项高亮、点击切换 activeLane，与轨迹行头角色名按钮联动（两处均可切换）；②**子 Agent 链路入口消息**——打开子 Agent 链路时，正文列表顶部渲染「任务委派」入口块：主 Agent 角色名 + ⇢ 任务委派 + 派发任务全文（取最早一条 targetChatId=该子 Agent 的 dispatch 节点 content，direction=parent-to-child），长文截断可展开——打开子 Agent 即知主 Agent 派给它的任务 |
| v0.4.2（增量） | 页签重做 / 轨迹居中 / 输入区多行（§2.2/§4.3/§4.5/§4.11，实测）：①**时间轴任务条紧凑自适应**（修正：不固定高度、不居中大留白）——轨迹区块高度随内容自适应，上下仅对称留白 10px、多轨间距固定 28px、max-height 兜底溢出滚动；**运行中块宽增长改 CSS 动画推进**（1px×zoom/秒），轨迹布局 memo 排除 elapsedMs、与每秒时钟 tick 解耦——每秒 tick 不再重算/重写轨迹样式，消除「值未变却持续重绘」；⑥**lite-body 与标题栏重叠修复**——非 native 面 titlebar 为 absolute 40px 悬浮于 shell 顶部且 .is-lite 未隐藏（⚡ 切换钮/窗口控制在其上），`.workbench-shell.is-lite:not(.is-native)` 加 `padding-top:40px` 让 lite 内容自标题栏下方开始（native 面保持从顶）；②**审批/提问改为浏览器式多页签**（弃用独立 Tab 标签行）——面板为独立直角卡片（无圆角，用户强制规则），卡内两级结构：**标签栏**（灰背景，多 tab 靠左不撑满）+ **内容区**（亮背景）；激活 tab 亮背景与内容区同色**连体**（底部直通无分隔、内容随切换），tab 为**直角矩形**、激活略高盖过非激活（底部 padding 差），激活不收缩、空间不足时非激活互相挤压、最短只剩 icon；③**去除双层标题**——内容区顶部「审批：xxx / 提问」标题删除，名称由标签承载，风险摘要 / 问题 / 选项直接展示于内容区；④**输入区多行化**——单行输入改自适应多行 textarea（默认单行，换行/长内容自动增高），发送按钮改主色实心短小按钮；⑤**Enter 行为统一 3 处**（lite 输入区 / 快速发送 composer / 工作台 composer）——Enter 发送、Shift+Enter 换行（原 Cmd/Ctrl+Enter 发送废弃） |
| v0.4.1（增量） | 布局回归与运行反馈修正（§2.2/§4.11，实测）：①**审批/提问区块改回输入区上方**（实现曾误置于内容区顶部，回归 §2.2 设计顺序——状态条→对话流→审批/提问行→输入区）；②**时间轴区块上下内边距加大**（轨道块在区块内居中，第一条轨道不贴顶部标题）；③**运行中块移除脉冲闪烁动画**（running 块宽度随执行时间持续增长即为运行反馈，无需闪烁——§4.11 交互） |
| v0.4（增量） | 时间轴宽度模型重构（§4.11，实测定稿）：大模型执行节点改**线性耗时映射**（1 秒 = 1 像素，上限 180px）——执行时间真实区分出来（2 分钟≈120px、30 秒≈30px、10 秒≈10px），不再被 log 压缩抹平；工具节点**一律固定宽度**（等待与否依赖用户 supervision 设置、设置可变且不可追踪，故不按耗时、统一固定长度）；用户消息节点固定宽度；**行标记序号彻底移除**（轨道无任何文字/数字，纯块流） |
| v0.3.2（增量） | 时间轴改为**无间隔紧凑流式**（§4.11，实测无间隔交互最优）：删除时间刻度轴、删除空隙段与时间定位——块按出现顺序紧凑排列（块间仅 1px 间隔、无时间空余，长等待不再产生空白）；块宽仍按耗时 log 压缩 × zoom；去掉头部「时间轴」标题（仅保留缩放重置按钮，非 100% 才显示）；行标记简化为**序号数字**（去掉角色名文字与圆点）。lite 内容区字重显式收敛 400（正文/标签，避免任何覆盖） |
| v0.3.1（增量） | 时间轴分段映射修正（§4.11）：线性映射改为「活动段线性 + 空隙段压缩」（股市分时图模型——长等待切掉、只留活动段贴近，保证有效信息可交互）；均匀刻度只画在活动段内；空隙段固定小宽 + 省略号「⋯」标记被跳过的时间；头部「时间轴」改常规文档流行（不再悬浮），修复悬浮覆盖首行行标记；轨迹容器 max-height 上调保证底部时间刻度可见 |
| v0.3（增量） | 时间轴重做（§4.11）：线性时间→x 映射 + log 压缩块宽（下限 10px/上限 240px）+ 等待区间=缺口（删虚线 waits）+ 均匀相对时间刻度 + 无圆角 + 1px 块间隔 + 流水线行标记「序号 · 角色名」；保留 Ctrl/⌘+滚轮缩放（块宽随 zoom 伸缩）；全 lite 视图字体字重收敛 400 |
| v0.2（定稿） | T31 评审通过。吸收评审结论：①补 5 个遗漏场景（§4.8 断线重连状态、§4.9 审批超时倒计时、§4.10 错误码六码 UI 分支、§4.3 多选题/自由文本、§4.1 子任务状态行展开）；②A-E 定案写入正文（A turn.delta 默认关+标题栏流式开关=重连切换；B 停止 chat.abort/继续 chat.resume+canResume；C 流量计数只计应用层帧 payload；D 审批截断值+truncations 引用+node.get 全文链路与 id 映射；E 仅当前会话）；③新增 §5.1 与现有 UI 共存的操作约束；④验收标准补断线重连/超时态/错误码分支（§6） |
| v0.1（草案） | 初版交互草案；T31 评审 3 处契约错误（W1-W3）与 W4/W5 措辞已直接修正落盘 |

---

## 1. 目标与定位

**一句话**：在工作台窗口内，用一条 ?profile=lite&v=1&maxFrameBytes=2048 的独立 WS 连接，渲染一套纯文本、极低流量、可完整交互的对话 UI，与现有富 UI（节点树/拓扑/角色编制/消息气泡）互为可切换的「双子界面」。

**核心叙事（展示优势）**：
- **极少量流量**：默认只显示「用户消息 + LLM 最终回复」（lean 投影），中间过程节点只在运行中显示状态行、不传内容；事件全部 ≤512B/帧、单帧 ≤2048B（maxFrameBytes 声明），整个会话的刷新 ≤16KB（分页+nodeCount+hasMore）。
- **操作交互便捷**：极简但完整——发送 / 审批 / 提问 / 停止 / 查看详情，全部可在 lite 视图内完成。
- **按需详情**：中间节点默认折叠为状态行，点按才通过 chat.timeline.node.get 按需拉全文。

**与现有 UI 的关系**：并列不替代。同一工作台窗，标题栏三视图切换「**树 / 对话 / 精简**」（2026-09 扩展：原两档「完整视图 ⇄ lite」扩为三档，精简即对话的紧凑展示方式；`WorkbenchViewToggle` 三档分段按钮，rail「对话模式」按钮曾与标题栏同步、v2.1 起移除，对话模式入口统一由标题栏三档承担，见 [workbench-multi-window.md](workbench-multi-window.md#rail-工具栏分组与-lite对话显隐2026-08-282026-09-对话模式扩展)）。lite 视图与完整树/对话视图各自维护独立连接与状态，切换互不干扰。**范围（E 定案）：仅当前会话**——lite 视图不提供会话切换与历史回看（单 root 最简，D19 建议 ≤1-2 root），历史回看从对话模式进入（双子界面分工：lite=当前会话极低流量，完整视图=全功能）；chat.list 已在 hydration 链第一步，未来扩展成本为零。

---

## 2. 切换入口与布局

### 2.1 切换位置（用户已拍板）
- **工作台窗口标题栏**放一个**三档分段切换钮 `WorkbenchViewToggle`**（树 ⌘ / 对话 ↺ / 精简 ▤；2026-09 由两档 el-switch 扩为三档——精简即对话的紧凑展示方式，rail「对话模式」按钮曾与标题栏同步、v2.1 起移除（rail 不再放第二入口），同一 windowId 共用 `useWorkbenchViewMode`）。
- 每个工作台窗独立（windowId=presetId 维度），互不影响。
- 切换状态**按窗口持久化**（localStorage key `cherynyxus:workbench-view-mode:<windowId>`，旧两档键 `cherynyxus:workbench-lite-view` 读取时迁移；沿用 useWorkbenchWindow 的 per-window key 模式），刷新后保持。
- 不提供全局默认值开关（保持每个窗口独立，符合工作台「每预设一窗」模型）。

### 2.2 lite 视图布局（自上而下）
- 标题栏（原样 + 三档视图切换钮）——**lite 内容自标题栏下方开始**（v0.4.2 修复：非 native 面 titlebar 为 absolute 40px 悬浮于 shell 顶部，`.workbench-shell.is-lite:not(.is-native)` 加 `padding-top:40px` 让位，避免 lite-body 顶部被标题栏遮挡、上下不对称；native 面无 titlebar，lite 从顶开始）
- 状态条（连接状态 / 会话信息 / **多 Agent 链路标签** / 流量计数）——链路标签常驻状态条内（v0.5.3 迁移，§4.12；**v1.0 浅色可读性**：状态条/链路标签/轨迹行头文字由 `--el-text-color-secondary` 提为 `--el-text-color-primary`，链路标签非激活加边框、激活实底主色，浅色下不再过浅看不清）
- 对话流（可滚动）
  - [用户] 消息 A（用户消息全文）
  - ⟳ 运行中…（中间节点=状态行，无内容）
  - [agent] 最终回复摘要
- 审批/提问行（交互时出现，浏览器式页签，v0.4.2）
- 输入区（自适应多行输入 + 发送，Enter 发送 / Shift+Enter 换行，v0.4.2）
- 底栏（分页/更多 / 节点详情抽屉入口）
- **三区域分色（v1.7，用户需求；v1.7b 换紫系）**：窗口基底退回 `var(--bg)`（比区域暗一档）；**对话流 = 中性亮面** `var(--surface)` + 淡横格线（阅读区）；**审批/提问行 = 紫色系只加在内容元素上**（tab 按钮自身、提问内容区、选项卡片、底部操作栏；**标签栏位置恒无底色**——用户多次强调的硬约束）；**输入区 = 主题强调色淡底**（操作区）。三块底色家族互不相同，分界一眼可辨，不再依赖细线区分。

---

## 3. 数据流（独立 lite 连接）

### 3.1 连接
- 独立 wsClient 实例（WsClient 类加可选 query 参数 + `new WsClient()` 新实例）。**必须独立实例，严禁复用主 UI 单例**（architect 预研）：lite 连接的信封最小化会剥掉 subscriptionId/eventSeq 等字段——主 UI 的 gap-buffer/replay fence 依赖这些字段，复用将破坏其重放协议；且主 UI 会丢失 stream chunk（lite 抑制 0x01 通道），致命。URL：?profile=lite&v=1&maxFrameBytes=2048&token=...（token 沿用现有注入，profile 参数与 token 共存）。
- 握手期未知版本会被服务端 close(4001, {supportedVersions}) → UI 显示「版本不兼容」并禁用切换（提示升级）。
- 心跳沿用现有机制；断线自动重连（复用 ws.ts 的 shouldReconnect/scheduleReconnect）。

### 3.2 会话数据（hydration 链，与固件一致）
1. chat.list({stage}) → 拿到会话摘要。**注意（T31 核验）**：chat.list 响应**不做 lite 投影**（applyLiteResponse 只投影 rootTimeline 形态的响应）——lean 目录依赖 scope:'stage' 省略 preview 的既有行为，非 profile 裁剪。
2. chat.open(rootChatId, {knownTimelineRevision}) → state 快照（lean 集：activeTurns/questionBatches/runningTools/roles）+ rootTimeline（LeanTimelineNode[]，分页 + nodeCount + hasMore）。
3. interaction.list({maxItems: 20}) → 待处理审批/提问（serverNow 校准本地钟）。
4. 实时增量：run.updated（唯一权威工作态信号）+ turn.started/cancelled/completed + interaction.changed（失效信号）+ timeline.patch（lean upsert）+ turn.delta（若 turnDelta 可选开，默认关）；cancelled 到达时丢弃对应流式缓冲。
5. 每轮免费时钟校准：interaction.list 响应带 serverNow；done 投影也带 serverNow（T28 修复）。

### 3.3 视图数据模型（前端 lean store）
- 维护 leanTimeline: LeanTimelineNode[]（按 orderKey 排序），runningState: {turnId, status, startedAt}，pendingInteractions: InteractionRecord[]。
- 事件 → UI 映射表（见 §4）。

### 3.4 流量预算（前端侧展示/统计）
- 状态条右侧常驻小字显示「本会话流量 ≈ X KB」（C 定案口径：**只统计应用层 WS 帧 payload 字节**，即 ws.onmessage 累计收到的 message 字节总和；**不含 TCP/WS 握手与心跳**——连接管理开销富 UI 同样存在，计入会稀释业务流量对比的公平性）。
- 对照：默认视图（完整 UI）首刷会拉全量 timeline（数 KB~数十 KB）；lite 首刷 ≤16KB 且事件 ≤512B/帧。

---

## 4. 对话流渲染与交互

### 4.1 默认显示（§3.2 契约——只有用户消息 + 最终回复）
- **用户消息**：actorKind='user' 的节点 → 全文显示 summary（用户消息短，通常不截断）。**v2.8 指令 token 样式**：正文中的 `[[command:/…]]` / `[[role:@…]]` token 经 `splitCommandPrompt`（与对话模式 `MessageBubble` 同源）渲染为样式化小标签（命令=主题金色、角色=蓝），不再裸显示 `[[ ]]` 包裹文本；普通文本保留换行/空格原样展示。
- **最终回复（T31 修正）**：主 agent 的最终回复权威通道 = **done.finalMessage（即时终态）+ timeline.patch upsert 的 agent-to-user message lean 节点（历史权威）**，同 id upsert 去重（F2）——正文**全文**直接在页面内滚动展示（v1.3 full 渲染，不截断）。**v2.8 起右上角不再有「详情」按钮**（全文已直接展示，按钮冗余；用户提问行同删）——工具调用细节仍由 cluster 小按钮 / 轨迹块点击进入抽屉，信息不丢失。return 节点（direction=child-to-parent）是**子 agent** 回传的投影，用于子任务状态行展开，不是主回复信号。
- **中间节点**（工具/子任务/思考）：**只显示运行状态行**（⟳ 正在… / ✓ 完成），不显示内容；`toolNames` 可选显示（如 📎 read_file, write_file），`toolCalls` 轻量列表用于按调用逐个显示同一次 LLM 响应中的多个工具及各自状态。点击状态行 → node.get 按需拉全文（§4.4）。**v2.8 思考行内折叠**：最终回复的「思考」直接展示在正文行上方，**默认折叠**（▸ 思考，点击展开；文字弱化为 secondary 与正文区分，同详情抽屉 v2.2 交互）；工具节点合并的思考（同一次 LLM 响应并入 tool-batch）仍在抽屉内查看。
- **子任务状态行展开（v0.2 补）**：子 agent 按 T26 折叠规则显示为「⟳ 子任务运行中 / ✓ 子任务完成」状态行；点击展开显示该子 agent 的 lean 节点维度——`direction='parent-to-child'`（派发）与 `direction='child-to-parent'`（回传/return）的 lean 节点列表（各自 summary+orderKey），展开数据来自本地 leanTimeline 过滤（不新发请求）；return 节点的「详情 >」走 node.get。子 agent 的 lean 节点不进入主对话流（仅展开区），主回复信号不变（仍为 done.finalMessage + agent-to-user 节点，见上条）。

### 4.2 运行中状态
- run.updated 且 chatId==rootChatId 是唯一权威工作态信号（T26 规则）：running → 状态条显示「运行中…」，对话流显示 ⟳ 行。
- 子 agent 事件（chatId≠rootChatId）只驱动子任务状态行，不污染主视图（T26 折叠规则）。
- turn.delta **默认关闭**（A 定案：G1 原则「默认只展示最终回复」+lite 叙事纯度）；标题栏提供「流式」开关——turnDelta 是**连接级参数**，开关的实现 = 断开当前 lite 连接并以 turnDelta=1 重连（**不能热切换**，切换后重跑 hydration 链）；开关 tooltip/确认文案须预告「切换将断开并重连 lite 连接（约 1-2 秒）」；开启时增量文字按 ≤512B/帧分片渲染（T24）。

### 4.3 审批 / 提问交互（G4 全量下发，交互必须）
- **交互入口（v2.6 重构，用户需求「参考对话模式，把提问交互放进页面内容」）**：审批 / 提问交互**不再有常驻面板**（原输入区上方的待处理面板已移除）——入口 = 点击大模型响应回来的**工具调用簇按钮**（或时间轴工具块）→ 打开**详情抽屉**，在抽屉内**该工具调用卡**上完成交互（`LiteToolCallDetail` 卡片内嵌 `LiteInteractionView`）。**工具卡 ↔ 交互匹配**：审批 = interactionId 即该次工具调用的 callId；提问批 = 批内每题 questionId 即触发它的 callId（见下）。待处理 / 提交中的交互命中卡片 → 渲染交互视图；**交互完成后不再命中 → 卡片自动回到只读展示**。
- **审批（interrupt）**：`LiteInteractionView` 内展示：头部 `APPROVAL REQUEST` + 状态小点 / 状态药丸（非 pending 时）/ 倒计时（pending 显示剩余，超时「已超时」置灰）；下方 `ApprovalSummary`（标题「大模型需要…」+ 能力/行为/对象，2026-11 起无徽章与总结句）+ **风险摘要**（security.findings[0] 前 120 字，缺省兜底「未发现额外安全提示…」）+「技术详情」折叠区（完整操作参数 `ParsedArgs` + 文件变更 `FileChangeDiff`）；按钮【拒绝】【允许执行】——**允许后立即执行**，底部提示「批准后将立即执行，请先核对目标与变更。」。提交中 / 超时 / 断线时按钮禁用。
  - 批准 → interaction.approval.decide({interactionId, action:'accept', expectedRevision, commandId})；拒绝 → action:'reject'（interactionId=approvalId 同值）。
  - 结果经 interaction.changed（含 presetId）+ accept/rejected 事件反馈。
  - **id 映射（D 定案）**：interrupt 的 interactionId = 该 sense call id = 消息节点 toolCalls 中该 toolCall 的 call id；「技术详情」经 node.get({rootChatId, nodeId=所属消息节点, sections:['toolCalls']}) 一次拉取该节点全部调用后按 call id 定位该项。
- **提问（question_batch_requested）**：批内每题**分别挂在触发它的工具调用卡上**（questionId = callId），每题独立渲染：题干 + 类型提示（自由回答 / 可多选 · 再点已选项可取消）+ 错误行 + 选项卡区 / 自由文本输入框；**多题批次**每题头部显示进度「第 X/Y 题 · 已完成 N/Y」。提交按钮在任一卡底部（**全部题目答完才可提交**，提交中显示「提交中…」）。
  - **选项（v1.5 重做，v1.6 精简，v2.6 迁入抽屉后保持）**：选项以**两列卡片**呈现（窄屏回落单列），不再整行通栏；每个选项卡片内带「补充」按钮——**仅该选项选中后可用**，点击展开该选项的补充输入框（取消选中即收起并丢弃补充内容）。题末常驻「其他」卡片，其输入框本身作为**单选/多选的一个选项**：单选点击（圆形 radio 标记）即抢走其他选项的选中态、再点可取消，输入内容自动激活并清空其他选中；多选需手动勾选（方形复选框标记），输入内容自动勾选、清空内容即取消勾选。单选/多选均支持再次点击已选项取消选中。
  - **草稿持久化（v2.6）**：已选 / 补充 / 自由文本存 `rootUi.interactionDrafts`（按窗口 × 根会话），关抽屉再开不丢已答内容；交互完成后草稿保留供只读回看。
  - **自由文本题（v0.2 补）**：无 options 的题渲染为单行/多行文本框（freeText 提交）；Web 端可直接作答（低档 cancelled 降级仅面向 MCU 无键盘设备，Web 不适用）。
- **铃铛定位（v2.6）**：工作台右侧铃铛在精简模式点击 = 打开**最早待处理交互**所在节点的详情抽屉并聚焦其工具卡（工作台写入 `rootUi.attentionOpenRequest`{interactionId, nonce}，lite 视图消费后置回 null；角标显示当前根待处理数量）。
- 审批/提问交互结果在 lite 内闭环，不需要切到完整视图。

### 4.4 按需详情（node.get，G5）
- 点击任意节点状态行 / 摘要 → 面板抽屉：chat.timeline.node.get({rootChatId, nodeId, sections:['content','thinking','toolCalls'], offset, limit})。
- 单响应 ≤32KB 分段；超长字段附 contentHash 引用 → 前端展示截断 + 「加载更多」续拉。
- 详情抽屉内可查看 toolCalls（工具名+参数摘要）、thinking（**v2.2 起默认折叠**，标题为可点击切换钮 ▸/▾，展开后思考文字色降为 `--el-text-color-secondary` 与正文区分、降低视觉权重；v2.2 前为恒展开的「可选开关」；**v2.8 起最终回复的思考同时在正文行内折叠展示**，抽屉保留完整分节供工具节点查看）。
- **工具调用风险展示**：toolCalls 中每项 toolCall 携带 `security?`（该工具 `authorizeToolCall` 判定原样透传，与审批 interrupt 同源；缺省 undefined 兼容旧数据）→ `LiteToolCallDetail` 在工具状态旁渲染 `RiskBadge compact`（**固定四档：安全=绿/中风险=黄/高风险=红/未知或未评估=灰**；config_manage 写操作 = 中风险，读操作 get/asset_get 直接放行且无判定，见 role-security.md）。
- **工具卡标题去重（v2.6）**：`LiteToolCallDetail` 卡片头部只保留 **icon + 风险徽章（compact）**——工具名/类型/执行状态/耗时已由抽屉顶部标题栏承担，卡片内不再重复展示（原「写入」「已完成」等状态标签删除）。
- **详情抽屉宽度可拖拽（v1.2）**：抽屉左缘为拖拽手柄（ew-resize），宽度 clamp(320px, 拖拽值, 92% 容器宽)；拖拽结果按窗口 × 根会话持久于 LiteRootUiState（`detailDrawerWidth`，null=默认 min(460px, 92%)），重开抽屉/切回会话保持；抽屉体配主题化细滚动条（超长内容可拖拽滚动，§4.4 不再隐藏滚动条）。
- **工具详情展示重排（v2.0）**：
  - **字号整体加大（不加粗，字重 400）**：工具卡头部 16px、故事正文 15.5px、字段值 15.5px、代码 15px、字段名/折叠摘要 14.5px，抽屉分节标题 15px（2026-10 全局放大 +2 后的当前值；v2.0 定稿为 14/13.5/13.5/13/12.5/13px）。
  - **工具调用右上角 tag 统一尺寸**：工具类型徽标、执行状态、风险判定（RiskBadge compact）统一 14px 字 / 20px 高 / 8px 横内距（2026-10 全局放大后，v2.0 原 12px），同一高度对齐不再参差；**圆角风格（v2.1）**——三者均为 `border-radius: 999px` 圆角 tag，与共享 RiskBadge 的圆角风格一致（用户确认，覆盖 v1.2 对风险 chip 的直角要求）。
  - **参数默认展开**：参数区 `<details>` 默认 open（摘要行即「参数」）。
  - **执行说明区只承载标题栏没有的信息（v2.5）**：抽屉标题栏已含工具名 + 状态 + 耗时，工具卡「执行说明」区不再显示动作句（已读取文件/已写入文件…）与状态句（执行完成），只保留「目标」（路径/命令/URL 等，等宽代码块）与「本次变更」列表；两者皆无（如提问工具）整区不显示。
  - **结果区统一（v2.5，非提问工具）**：短结果（原文 ≤200 字符）`<details>` 默认 open 直接展示内容；长结果默认折叠，折叠状态下在「原始结果」下方展示一句摘要预览（resultSummary），展开后完整内容替换预览句；执行中显示「等待工具返回…」。
  - **首次打开自动走完工具游标链**：`chat.timeline.node.get` 协议每页只返回一个调用的一个字段（toolCursor/page.nextCursor，§3.5）。详情打开时沿 `nextCursor` 顺序拉取（上限 24 页）一次展示该节点全部工具调用，不再「每点一次只多一条」；超过上限时剩余由「继续加载更多工具内容」按钮续拉——该按钮仅在有未取回内容时出现，文案 + title 说明「参数或结果内容较长，未全部取回」。
  - **按工具类型渲染参数**：「问题 + 选项」形态参数（`question` + `options` + `multi_select`/`multiSelect`，如 ask_user_question 类工具）渲染为单选（○）/ 多选（□）选项列表区块，不再把 options 原文 JSON 列出；**选项说明完整展示在选项文字下方（浅色，不截断，v2.5）**；**已答时结果直接渲染进选项（v2.5）**——选中项 ✓ + 主色高亮背景，取消显示「用户已取消该问题」，自由文本/补充注记照树视图样式，提问工具不再单列「原始结果」；标量数组字段（文件列表/标签/选项等）渲染为逐行点号列表；命令/路径/URL/内容等关键字段保留等宽代码块。
  - **提问工具标题 + 说明（v2.5）**：header/rationale/nextStep 三个字段（大模型写的数据，非代码说明）从参数字段行移到「参数」上方独立块——header 作标题，「为什么需要你决定」「决定后会发生什么」作说明（与任务中心提问面板同标签）；参数字段行与「更多参数」折叠区同步排除这三个键。对话模式提问卡片（QuestionRenderer）与树视图悬停详情（QuestionAnswerDetail）同样展示这两条说明（数据一致）。
  - **未知工具（other）**：不再展示 `sense.tools` description 工具说明行（v2.5，代码写死的说明信息不上 UI）；下方按「中文标签: 内容」逐字段行展示；嵌套对象/数组递归翻译键后 pretty-print。

### 4.5 发送
- **自适应多行输入框**（v0.4.2）：默认单行，换行 / 长内容自动增高（上限内滚动）；发送按钮为**主色实心短小按钮**；**v1.0**：发送按钮高度与单行输入框对齐（同高，消除底部输入区左右错位）；**v2.2**：默认保持 **6 行（120px）上限**，发送钮正上方新增**展开钮**（`.lite-expand-btn`，el-tooltip 提示，状态存 `LiteView` 组件内 ref、不持久化）——点击后输入框高度提升到**至少 12 行（`min-height: min(240px, 50vh)`）、最高窗口一半（`max-height: 50vh`）**，大段内容输入不再在小框中翻页滚动（与对话模式底部输入框同款交互）；**v2.7**：展开钮改为 EP `Top` 矢量图标（展开态旋转 180°）、无边框幽灵小按钮，**默认隐藏、仅当输入内容超过 2 行时出现**（内容回落 2 行以内自动收起展开态）；高度重算补上边框高度，空内容不再挤出右侧细滚动条。
- **输入区底色（v1.7）**：输入区整行为主题强调色淡底（浅色靛蓝 / 深色电光青，`--el-color-primary` 8% 派生）+ 同家族 45% 顶部分隔线——与对话列表（中性亮面）、提问面板（暖琥珀）三种底色一眼区分。
- **Enter 发送、Shift+Enter 换行**（v0.4.2，与快速发送 composer / 工作台 composer 行为统一，原 Cmd/Ctrl+Enter 废弃）。chat.input.submit（命令面：立即 ack + 幂等 commandId + 客户端预分配 messageId）。
- 发送后：本地立即回显用户消息（messageId 预分配）→ input.updated 确认（去 content，设备本地已有文本）→ run.updated 开始运行。
- 输入队列满（INPUT_QUEUE_FULL 码）→ 提示「正在处理上一条，稍候」。

### 4.6 停止 / 继续
- 状态条运行中时显示【停止】→ `chat.abort {chatId, runId?, commandId?}`（T31+architect 预研一致确认：schemas.ts:464 仅 chatId 必填、commandId 幂等、递归停止全部后代、先 rejectApproval 再中断；终态经 timeline.patch+run.updated 下发均在 lite 白名单内，非流式 Promise handler lite 直接可用）。继续 → `chat.resume`（canResume=true 时显示【继续】按钮）。固件未实现停止——Web lite UI 属新增能力，无固件一致性问题。
- run 中断（error / child_abandoned）→ 折叠为子任务失败状态行 + 主视图可继续（canResume）。

### 4.7 分页 / 更多
- 对话流顶部「加载更早」→ chat.timeline.get({rootChatId, before: orderKey, limit})（P1 游标）分页续拉；hasMore 控制按钮显隐。
- 节点数提示（nodeCount）在状态条显示。

### 4.8 断线重连 UI 状态（v0.2 补）
- 断线期间状态条显示「重连中…（第 N 次退避）」而非空白（N=当前重试次数，沿用 ws.ts 的 scheduleReconnect 退避序列）；对话流冻结为最后已知态（不置灰、不清空）。
- 恢复后重跑 hydration 链（§3.2 完整四步：chat.list → chat.open{knownTimelineRevision} → interaction.list → 事件等待）；knownRevision 命中时 chat.open 短路返回 timelineUnchanged，本地 leanTimeline 原样可用。
- 重连判定规则（mcu-lite-api §3.6）：run 是否已结束的唯一判定 = chat.open state 快照中无该 runId 且 revision 自愈完成；**不依赖重放错过的 done/run.updated**。

### 4.9 审批超时倒计时（v0.2 补）
- 审批行显示本地渲染倒计时：`remaining = deadlineAt − (now + Δ)`，Δ = serverNow 校准偏移（interaction.list 与 done 投影每轮免费校准）。
- 到点后 UI 将审批行转为「已超时（服务端自动拒绝）」终态——**以 interaction.changed(status='expired') 为驱动信号**（服务端 deadlineAt 到点自动 reject/expire，见 protocol.md interactions 生命周期）；本地倒计时仅提示性渲染，过期 decide 的真实结果以响应 interaction.status 为准（C4：到期仍调用返回成功响应 status=expired）。
- 超时态审批行不可再操作（按钮置灰），可展开查看参数详情（node.get 链路不变）。

### 4.10 错误码 UI 分支（v0.2 补，D13 六码）
- **INTERACTION_STALE**（revision 过期）→ 审批/提问行显示「内容已变化」+【刷新后重试】按钮（重拉 interaction.list 取新 revision）。
- **INTERACTION_ALREADY_RESOLVED**（已处理）→ 该交互行置灰转「已在其他视图处理」态（以最新 interaction.status 为准渲染终态）。
- **COMMAND_CONFLICT**（commandId 冲突/处理中）→ 幂等提示「该操作正在处理中」，不自动重发（commandId 语义=同一命令同参数重发安全、不同参数报冲突；UI 确认用户意图后换新 commandId）。
- **INPUT_QUEUE_FULL** → 发送区提示「正在处理上一条，稍候」（§4.5 已有）。
- **RATE_LIMITED** → node.get 详情抽屉提示「请求过于频繁，请稍后再试」（节流预留位，触发时 UI 退避后允许手动重试）。
- **PROFILE_VERSION_UNSUPPORTED** → 握手期 close(4001) 的 UI 升级提示（§3.1 已有「版本不兼容并禁用切换」；此码作为 RPC 错误出现时同文案兜底）。
- 所有错误 message 为中文用户面文案（F11），UI 原样展示 message + 按 code 走上述分支，不得截断 [tracingId] 前缀。

### 4.11 时间轴（运行轨迹瀑布流，v0.3 重做）

lite 视图对话流上方的多流水线运行轨迹。**一轴 = 一个 Agent 流程**：主 Agent 一条，每个子 Agent 一条独立流水线；子 Agent 的块始终在其自身流水线上展示，不并入主流水线。轨迹区块为**独立区块**：上下保留内边距，轨道块在区块内垂直居中，第一条轨道不贴顶部标题（v0.4.1 修正）。

**垂直布局（v0.4.2 修正定稿）**：轨迹区块高度**随内容自适应**（不固定高度、不居中大留白）——任务条多轨时自然变高，上下仅对称留白 **10px**（顶部内边距 10 = 底部内边距 3 + 横向滚动条轨道占位 7）；`max-height:168px` 仅作多轨溢出的兜底滚动上限。

**几何模型（核心）——无间隔紧凑流式 + 执行线性化（v0.4 定稿：实测无间隔交互最优，执行时间真实区分）**
- **无时间定位、无空隙**：块按出现顺序紧凑排列，块与块之间仅 **1px 间隔**，**不做时间定位、不留基于时间的空余**——长等待不再产生空白区间，所有有效块靠在一起、可直接点击交互。每条流水线（一轴一 Agent）独立紧凑排布，多轨起点对齐（各自第 1 个块从 x=0 起）。
- **大模型执行节点（线性耗时映射）**：块宽 = `耗时秒数 × 1px`（**1 秒 = 1 像素**），**上限 180px**——2 分钟≈120px、30 秒≈30px、10 秒≈10px，执行时间真实区分出来，不再被 log 压缩抹平；超过 180px 封顶。
- **工具节点（一律固定宽度）**：不按耗时渲染——工具是否「等待用户交互」（审批/提问）取决于用户 supervision 设置且设置可变、历史无法可靠追踪，故所有工具节点统一 **固定宽度**（≈24px），不因等待时长膨胀、也不因执行快慢收缩。
- **用户消息节点（固定宽度）**：用户消息无执行耗时语义，同样固定宽度（≈16px）。
- **zoom 应用**：渲染宽 = `基准宽 × zoom`，clamp 到 `[10, 180]`。放大块变长、轨道变宽（配横向滚动条 LiteScrollbar）；**变短下限 10px** 保证可点击命中、**变长上限 180px**。缩放范围 0.4x–5x，Ctrl/⌘+滚轮缩放（普通滚轮仍由 LiteScrollbar 横向平移）。
- **两档 clamp（v0.5.1 修正定稿）**：执行节点（模型响应 / 工具，按耗时线性映射）宽 = `耗时秒数 × 1px × zoom`，**正常档** clamp `[MIN_BAR_PX=10, MAX_BAR_PX=180]`——空间足够时执行时间真实区分（2 分钟≈120px、30 秒≈30px、10 秒≈10px、超过 180s 封顶 180px）；**挤压档**（块排不下时）clamp `[MIN_BAR_PX=10, COMPRESSED_MAX_BAR_PX=30]`——整体挤压、长执行封顶 30px。**挤压判定口径**：按「每条链路块固有宽之和 + 1px 间隙」的紧凑口径是否超出视口宽度判定（排除时间 gap 占位——gap 只决定块位置、不参与挤压判定），避免长会话时间空隙把正常档撑成挤压档；事件节点（用户/返回/委派/协作/系统）固定宽（user=16 / 其他=12）× zoom，同样 clamp 下限 10（缩放 0.4x 不窄于 10px）。
- **块序列化推进（v0.5.2 修正定稿，防遮挡硬约束）**：块 left 不再直接取时间 gap 光标，而取 `max(时间 gap 位置, 同一轨道前一块 right + 1px)`——线性流程同一轨道内块间**最低 1px 间隔、绝不互相遮挡**（根源矛盾：gap 增量上限 24px 远小于块宽上限 180px，纯时间定位下长耗时块必然压住后续块）；时间 gap 在块不挤（窄块）时仍保留占位，体现真实等待；块真挤（宽块）时后续块被顺延到右缘 + 1px。
- **节点耗时（修正定稿）**：`projectLiteHistory` 中**已提交节点一律以节点自身 `createdAt/updatedAt` 为权威时间**（耗时 = `updatedAt − createdAt`），不依赖 execution step——`chat.open.state.executionSteps` 只是 root 订阅的**当前执行窗口**快照（`executionStepLimit` 约束下仅保留最近步骤），若对长对话的历史节点做时间匹配，前段节点会在匹配窗口内错误命中末尾步骤、污染 `startedAt` 导致排序与行分组错乱（精简模式 cluster 丢失工具、轮末回复错位）。execution step 仅用于**运行中**节点的实时计时（`matchedStep.status==='running'`；未匹配的 running step 由 `projectLiteHistory` 合成为运行中占位节点，见 [`executionMonitor.ts`](../../web/src/features/lite/executionMonitor.ts)）。

**布局与视觉**
- **无时间刻度轴、无省略号、无空隙压缩标记**（删除 v0.3/v0.3.1 的底部均匀刻度与空隙段省略号——时间跨度展示被放弃，改为紧凑块流）。
- 块为标准矩形，**无圆角**（`border-radius: 0`）；相邻块之间 **1px 间隔**；类型用颜色区分（user=主色 / model=绿 / tool=黄+工具类型配色），不依赖虚线/边框区分。
- **无行标记**：轨道前缘**不显示任何文字/数字**（v0.4 移除序号数字——行定位不需要，角色名在悬停浮层可见）。
- 头部**去掉「时间轴」标题**，仅保留「缩放重置」按钮（非 100% 时显示），常规文档流行、不覆盖行标记。

**交互**
- 点击块 → 定位并高亮下方对应内容行（含闪光）；hover → 浮层详情（状态/耗时/类型/Agent；工具节点额外显示**工具类型名称**，如「命令/读取/写入/网页/委派/工具」；浮层底部有「点击定位下方内容」操作提示）；**运行反馈（v0.4.2 性能修正）**：running 块宽度增长由 **CSS 动画**推进（1px×zoom/秒，经 `--bar-from/--bar-to/--bar-dur` 注入，到 180px 上限定格）——轨迹布局 memo 的签名**排除 elapsedMs**，每秒时钟 tick 不再重算/重写轨迹 inline style（消除「值未变却持续重绘」），运行期间零 JS 更新，运行结束由布局重算写入精确终宽并移除动画；`data-tooltype` 驱动工具类型配色。

### 4.12 链路标签栏与子 Agent 入口消息（v0.5 新增）

正文列表（对话流）一次只展示一条链路（主 Agent / 子 Agent，见 §4.11 轨迹分轨）。v0.5 新增两处展示改造：

- **链路标签栏**：常驻**顶部状态条（lite-statusbar）内**一行链路标签（v0.5.3 迁移——原正文列表顶部独立标签栏移入状态条，顶层直接展示多个 Agent）——主 Agent（✧ 主 Agent）+ 各子 Agent（◆ 角色名），**顶层多个 Agent 全部用名字展示**、不折叠，激活项高亮、点击切换 activeLane，与轨迹行头角色名按钮（§4.11 交互）联动，两处均可切换；标签随节点出现增减，用户消息并入主 Agent 链路（§4.11）。
- **子 Agent 入口消息**：activeLane 为子 Agent 链路时，正文列表顶部渲染「任务委派」入口块——主 Agent 角色名 + ⇢ 任务委派 + 派发任务全文。全文取最早一条 `targetChatId` = 该子 Agent 的 dispatch 节点（direction=parent-to-child）的 content；长文默认截断（≤120 字）可点击展开。入口块独立于历史列表（不进时间轴/轮次排序），仅作子 Agent 链路任务说明——打开子 Agent 链路即可看到主 Agent 派给它的任务。

### 4.13 工具调用微型 tag（v0.7 定稿）

- **固定结构**：统一固定尺寸小方框（22×22），lucide 矢量图标居中（`MorphIcon` 渲染）；图标与颜色**固定关联工具类型**，**不再用状态图标替换**——运行状态与成功/失败改由底部状态条表达；相邻节点不再用 ASCII `|` 分隔。不显示中文类型名，也不展示参数、结果、摘要或可见耗时；**悬停浮层（cluster 小按钮与轨迹块共用同一 `lite-tip`）与 `aria-label` 标记节点类型 + 工具类型名称 + 工具名 + 状态 + 耗时**（如「工具执行 · 命令 · 读取文件 · 已完成 · 00:12」），**不再挂原生 `title`**（避免 1 秒延迟的系统 tooltip 与自定义浮层双重叠加），详情入口保留全文。
- **图标与配色（v2.9，lucide + morphicons）**：工具类型 → lucide 本源图标与专属色（与详情抽屉 `.lite-drawer-type` type chip 同色板）——exec=SquareTerminal 紫、read=BookOpen 灰蓝、write=PenLine 绿、web=Globe 青、dispatch=Forward 橙、other=Wrench 金黄；非工具节点各配 lucide 图标（user=UserRound / root·child-agent=Sparkles / return=CornerDownLeft / dispatch=Forward / spawn=GitFork / system=CircleDashed），未知工具回退 Wrench。映射唯一源 `clusterIcons.ts`（测试 `clusterIcons.test.ts` 锁定）。**图标尺寸与避让（v3.0）**：MorphIcon `size` 15px，`.lite-cluster-icon` 带 `margin-bottom: 4px` 使图标在 22px 方框内微上移（本体上移约 2px），与贴底状态条留出空隙，不再粘连。
- **状态条**：高 `3px`，绝对定位在图标底部、左右内缩 5px（v2.9 收敛：原 2px 高/2px 内缩改为更短更粗）；取消灰、完成绿、运行中绿闪、失败/拒绝红。`prefers-reduced-motion` 下运行条保持绿色常亮。**v1.0 弱化**：状态条不再喧宾夺主——降低对比/透明度，icon 为主、状态线为辅；icon 字号加大保证清晰（浅色下 icon 清晰度不再低于状态线）。
- **外观**：无边框、无圆角、常驻淡底色（工具节点按工具类型专属色淡底）；hover 仅给极淡背景，选中态用底部 1px 主题色线，键盘聚焦保留 1px 点状轮廓。
- **一致性**：正文 cluster 图标统一走 `clusterNodeIcon()`（lucide 映射），详情抽屉工具类型 chip 仍用 `toolTypeGlyph()` 字符；浮层与 title 的工具类型中文名统一走 `toolTypeLabel()`，节点类型中文名统一走 `LITE_NODE_LABELS`。

### 4.14 发送 / 运行失败的错误展示（v1.4 新增）

与节点树/完整视图同步，lite 覆盖全部错误类型（发送失败 + 运行失败两条路径，数据均来自 canonical store，复用 error-conventions 用户面一行中文 + detail 通道）：

- **发送失败（发送即被拒 / 命令报错）**：`submitInput` / `retryInput` 捕获异常后写入 `commandError` → `.lite-error-banner` 显示（沿用 §4.10 六码分支：INTERACTION_STALE 刷新 / ALREADY_RESOLVED 已处理 / COMMAND_CONFLICT 处理中 / INPUT_QUEUE_FULL 稍候 / RATE_LIMITED 稍后再试 / 其余原样显示 message）；同时 `.lite-failed-inputs` 保留失败消息行（错误文案 + 【重试】【移除】，既有行为）。**清除时机**：重试成功、或移除全部失败消息后 banner 一并清除（`removeFailedInput` 同步清空 `commandError`）。
- **运行失败（消息已发出、本轮运行中断）**：后端 error 通知写入 `session.run.status='failed'` + `run.error`/`run.errorFact`（见 error-conventions detail 通道）→ 对话流末尾渲染 `.lite-run-error` 条：一行 `run.error` 文案 + 可选【查看详情】展开 `errorFact.detail`（带 `[tracingId]` 检索指引，error-conventions §错误详情通道）；「继续运行」入口沿用状态条 §4.6（canResume 驱动，不重复放置按钮）。

**互斥与去重**：run 错误条仅在无 `commandError` 时显示（命令错误 banner 优先）；发送失败落 `run.status='paused'`（rollbackPreparedInput）不会被 run 错误条捕获——发送失败由 failed-inputs + banner 承载，不重复展示；run 错误保留至下次运行（新流首 chunk / done 时 reducer 清除）。

---

## 5. 与现有实现的复用/差异

| 项 | 现有完整 UI | lite 极简 UI |
|---|---|---|
| 连接 | 现有 wsClient（?token=） | 独立 lite wsClient（?profile=lite&v=1&maxFrameBytes=2048&token=） |
| 数据源 | 全量 rootTimeline + 富事件 | lean 投影事件 + 按需 node.get |
| 消息渲染 | MessageBubble/MessageBranchTree/角色编制 | 纯文本行 + 状态行 + 摘要 |
| 审批 | PendingOperationsPanel | 内联审批行（参数精简展示） |
| 输入 | AgentComposer（富文本/媒体/斜杠菜单） | 单行输入 + 发送 |
| 状态 | ContextUsageBar/角色 tags | 精简状态条 + 流量计数 |

### 5.1 与现有 UI 共存的操作约束（v0.2 新增，T31 前端可行性结论）

- **同一会话同一时刻只在一个视图内操作**：lite 与完整视图共享同一后端会话，跨连接 CONFLICT 语义（同 chat 活跃时另一连接的操作会被拒）——切换视图即停止旧视图的交互（旧视图保持只读渲染，新视图获得操作权）；两视图同时显示但不同时接收用户操作。
- **commandId 幂等兜底**：若用户在两视图快速交叉操作（切换竞态），同一 commandId + 相同参数的重发会被 request_journal 幂等层去重（返回首次结果）；不同参数的同 commandId 报 COMMAND_CONFLICT（§4.10 分支处理）。UI 生成 commandId 时按「一次用户意图一个 id」分配，天然规避冲突。
- **双连接心跳**：lite+完整视图两连接各自 ping 属设计内场景（服务端 ConnectionState 独立），流量计数只计业务帧不受影响（C 定案口径）；断线重连各自独立（§4.8）。

**前端渲染模块建议**（实现阶段）：
- web/src/features/lite/（新目录）：LiteView.vue（主视图）、LiteStore（lean 数据流）、LiteEventMapper（事件→UI 映射）、DetailDrawer.vue（node.get 详情）、TrafficMeter（流量统计）。
- 复用：ws.ts 扩展 profile 支持、connection.ts 的 token 注入、http.ts。

---

## 6. 验收标准（v0.2 按 T31 结论微调）

1. 工作台窗口标题栏三档切换钮存在，切换 树/对话/精简 即时生效、per-window 持久化；rail「对话模式」按钮已移除（v2.1，入口统一标题栏三档）。
2. lite 视图走独立 lite WS 连接（可在服务端日志确认 profile=lite 连接建立）。
3. 默认只显示用户消息 + 最终回复；中间节点只显示状态行；点击状态行 node.get 拉全文；子任务状态行可展开 parent-to-child/child-to-parent lean 节点（§4.1）。
4. 审批（interrupt）/ 提问（question_batch）在 lite 内可完整交互并闭环；多选题（multiSelect）与自由文本题正确渲染（§4.3）。
5. 发送走 chat.input.submit，输入后立即回显 + run.updated 反映运行态。
6. 首刷 ≤16KB（分页生效）；事件帧 ≤2048B（有界负载）；状态条流量计数可见且只计应用层帧 payload（§3.4）。
7. 断线自动重连：重连期间显示「重连中…（第 N 次退避）」非空白；恢复后重跑 hydration 链 + knownTimelineRevision 短路 + serverNow 校准（§4.8）。
8. **审批超时态**：倒计时本地渲染正确；到点转「已超时（服务端自动拒绝）」且由 interaction.changed(status=expired) 驱动；超时行按钮置灰（§4.9）。
9. **错误码六码分支**：STALE 刷新重试 / ALREADY_RESOLVED 置灰 / CONFLICT 幂等提示 / QUEUE_FULL 稍候 / RATE_LIMITED 节流退避 / VERSION_UNSUPPORTED 升级提示——各码 UI 分支按 §4.10 触发验证。
10. 现有完整 UI 不受影响（两视图独立连接，切换互不干扰；同一会话同一时刻单视图操作，§5.1）。
11. type-check + 前端构建通过；服务端 lite 测试不回归。
12. 工具调用 tag 无 emoji、无中文、无外框、无可见参数/结果/耗时；ASCII 字符表、`|` 分隔与底部状态条颜色/闪烁符合 §4.13，并在窄屏完整显示。

---

## 7. 待确认项定案记录（T31 评审 A-E，v0.2 全部落定）

- **A. turn.delta**：✅ 默认关 + 标题栏「流式」开关（连接级参数，切换=重连不能热切换）——见 §4.2。
- **B. 停止/继续**：✅ chat.abort {chatId, runId?, commandId?}（commandId 幂等，重连重发安全）/ chat.resume（canResume 驱动按钮显隐）——见 §4.6。
- **C. 流量计数**：✅ 只计应用层 WS 帧 payload 字节（不含握手/心跳），状态条右侧常驻小字——见 §3.4。
- **D. 审批参数展示**：✅ 行内截断值 + truncations 引用；「查看全文」走 node.get sections:['toolCalls']（id 映射：interactionId = sense call id = toolCall id，见 §4.3）。
- **E. 多会话/历史**：✅ 仅当前会话（单 root 最简），历史回看从完整视图切换——见 §1。

---

## 8. 分期（doc-first 标注）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| L0 连接与骨架 | ws.ts profile 支持 + 标题栏切换 + LiteView 骨架 + 状态条 | P0/P1 API 已就绪；**implemented（T33）** |
| L1 对话流 | lean 数据流 + 用户消息/最终回复/状态行渲染 + 分页 | L0；**implemented（T34）** |
| L2 交互闭环 | 发送(chat.input.submit) + 审批(decide) + 提问(answer) + 停止 | L1；**implemented（T35）** |
| L3 按需详情 | node.get 详情抽屉 + 截断续拉 | L1；**implemented（T36）** |
| L4 收尾 | 流量计数 + 断线重连自愈 + 验收 | L0-L3；**implemented（T37）** |

> 本设计文档为 v0.2 定稿（T31 评审通过），按 doc-first 规范可进入 L0 实现；后续变更先改本文并补修订记录。
