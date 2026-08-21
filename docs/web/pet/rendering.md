# 渲染分层（PetSprite.vue）

> 源码 [PetSprite.vue](../../../web/src/features/pets/PetSprite.vue) ｜ 上级 [README.md](./README.md) ｜ 动画 variant 见 [motion.md](./motion.md) ｜ 样式见 [style.md](./style.md)

## Agent 数据边界

Pet 渲染层不拥有 Agent 会话状态。Pet presentation 只保存动作、坐标、表情、拖拽和 ghost 动画，通过 `chatId` 从 ChatSession selector 获取 working、当前消息、审批、问题、工具、上下文与恢复状态。

### nyxus 独立核心（NyxusCore）

Cherry Nyxus 是独立于 Pet/Agent 身份的弹窗入口（[NyxusCore.vue](../../../web/src/features/pets/nyxus/components/NyxusCore.vue)），全局挂载在 App 顶层（`position:fixed; z-index:250`），**不经过 PetStage/PetBody，也不是 PetInstance**。入口保留自主游走、向鼠标缓慢靠近、拖拽和边界约束，但不参与普通 Pet 避让或关联；单击切换创建、聊天和设置工具环，双击才取得活跃 Nyxus 会话并打开 AgentDialog。单击动作延迟到双击判定窗结束后执行，双击会取消待执行的单击，拖拽结束也会吞掉同一次 click，避免误开工具或弹窗。工作/错误气泡不在入口呈现，运行内容、审批与问题交互仍集中在 AgentDialog。

入口从 chatSessions 只投影一个 `working` 布尔值。`working=true` 时强制显示脉冲星 Loading 形态；运行结束立即恢复 idle 形态轮播，不再区分 thinking、toolRunning、waitingForUser、responding 或 error 的外部视觉。服务断连黑洞仍具有最高系统优先级。

粒子场按暗点、普通点、高亮星、强闪星分成四档。暗点中的一部分按归属聚为更多层次的云团：梦幻紫、靛蓝、宝蓝、青蓝、青绿和玫红等高饱和色以低频插值缓慢流转，保持纯净绚烂而不掺灰。星云整体收拢时按实时密度提高饱和度和亮度，散开时保持同色系压暗以形成纵深；外围云团和悬臂也维持清晰的彩色外发光，连成明亮但柔和的带状星云。彩色云团先在独立图层内以常规混合绘制：中心按密度显著降亮并保持颜色，外围悬臂则更明亮；图层仅以最高 80% 的透明度合成到主体，避免加色叠加泛成大块纯白，也不遮住随后绘制的星点。中心暗色基底只保留小范围聚焦与外围轮廓。云团、悬臂和星点仍共用同一运动场；普通星点使用略带冷暖色的小核心与细微光晕，确保在云团中可辨但不抢眼。高亮星（恒星）在初始分布和运行碰撞中保持间距，核心始终纯白；鲜艳的紫、青蓝、玫红等颜色只用于其柔光、诞生与爆发环。恒星会持续经历缓慢渐生、长期稳定、爆发和消逝：爆发以所属鲜艳色的径向闪光环扩张并渐隐，消逝后随机白点再渐生为新恒星补位、总数恒定。星盘主旋转周期按粒子随机落在 30–60 秒；自动宇宙形态的完整稳定段至少保持 30 秒，并以平滑曲线切换。双星形态会让中心状态点随形态渐隐和渐显，不会突变。该粒子场支持星云、黑洞、脉冲星、双星、超新星与潮汐环模式。

### Nyxus 移动与云团过渡

独立运动采用分段航行：每次选定一个有限目标后，以较低速度缓慢加速、缓慢减速并抵达，再静止数秒播放粒子动画；鼠标位置仅在下一航段取样，绝不逐帧重算目标，因此不会出现像素级追随抖动或突然蹿动。Nyxus 会按包含外部光晕的安全距离避开 `pets[]` 中的普通 Pet；避让沿用相同的缓慢曲线，只改变其独立位置，Nyxus 不进入 `PetInstance`，也不会获得主 Pet 的信息栏、名称或工具栏。

紫、蓝云团在聚散时共用一套连续的色相插值；端点仅改变明度和透明度，避免最散或最聚时跳成灰浊杂色。云团纹理以更长的径向渐隐衔接，形成更柔的外发光悬臂；最终云层合成透明度仍不超过 80%。

### Nyxus 星系与运行状态

正常连接时 Nyxus 以两条高密度主旋臂和少量低密度外段分叉构成的旋涡星系为基底，在棒旋、倾斜盘、星系并合、双星融合、脉冲星和星暴等长形态间平滑切换；黑洞不参与 idle 选择。idle 调度使用覆盖全部候选的交错洗牌袋：一轮内每种形态只出现一次，结构形态与事件形态尽量交错，`binary` 与 `merger` 不相邻。hover、工作和菜单等临时高优先级呈现只暂停当前长形态，恢复 idle 后继续原进度，不重新随机。

服务 `disconnected` 时强制切到暗核、吸积盘和弱透镜弧构成的黑洞，并在恢复连接后平滑重建星系；`connecting` 保持低活动星系。`merger` 继续表现两个不等大伴星系的靠近、潮汐桥、双核并合、局部星暴和反向拆分；`binary` 则从单盘裂变为两个各自带暖色小核心的完整盘，短暂互绕后收紧轨道并融合回同一个单盘。两种形态都使用同一粒子群连续变形，核心与星盘共享中心轨迹，不允许瞬移换场。

单环星与多环星是完整的 idle 粒子目标场，与棒旋、倾斜盘、星暴、双星和并合一起进入洗牌轮播，不再由工具数量或运行阶段临时生成。脉冲星不参与 idle 洗牌，专用于 Loading。

入口 Canvas 的形态优先级为 `disconnected 黑洞 > running 脉冲星 > idle 洗牌`。入口禁用粒子 pointer 手势，因此鼠标仅触发外层按钮的打开弹窗行为。

实时消息规范化保存在 `ChatSession.messagesById[msgId]`，`activeMessageId` 指向当前 LLM 响应。Pet 工作气泡与 HistoryDrawer 的实时行读取同一个 `ChatMessage`：

- 新 `msgId` 首次到达时，旧 active 消息封口并保留在历史；新消息先以空 thinking/content 建立，再应用首个 delta。
- Pet 只显示当前 active 消息（或 done 后 retain 期内最后一条），因此不会残留上一轮文本。
- HistoryDrawer 以同一稳定 `msgId` key 原位更新该消息，服务端 delta 即打字效果；不创建第二份 typing buffer。
- 一个 `runId` 可包含多个 `msgId`（工具循环），每个新 `msgId` 都执行上述切换。

主历史通过 selector 聚合 root 与 descendants 的消息引用并做角色重映射，不把 child 消息复制进 parent。抽屉打开、关闭、下钻只改变 UI 栈，不加载历史、不清 Pet retain 状态。

### Nyxus 消息神经树

Nyxus 对话框上方的 `MessageBranchTree` 是独立的 SVG 画布：消息和工具调用使用统一的内联线框图标，不依赖操作系统 emoji。图标按用户、主 AI、子 Agent 和工具类别使用不同主色，以霓虹双描边渲染（外辉光 halo + 加粗亮外描边 + 细内芯 + 强调色能量扫描），不绘制方形/圆形容器底板。主用户显示“我”，root assistant/master 显示“Cherry Nyxus”，子 Agent 优先显示实际 `petName/agentType/preset`。普通节点 hover 在节点左侧显示只读详情（详情靠左、树靠右贴警戒条，左侧空间不足时翻转到节点右侧）；详情展示期间，对应节点的外辉光以轻量呼吸闪烁持续标记弹窗归属，弹窗关闭后立即停止，减少动态模式下则降级为静态高亮；待回答问题和待审批工具按 `questionId/approvalId === senseCall.id` 精确锚定可交互面板（同样靠左弹出），完成后保留工具图标并以终态色点区分完成/取消（绿点=已回答/已通过，红点=已拒绝/已过期/已取消），替代文字徽章；待回答/待审批等活跃态仍显文字徽章。提问面板不把交互类型表现成新的“单选/多选节点”，而以问题标题、具有明确选择标记和说明文本的选项卡、自由输入及独立操作区组成；单选/多选只决定选择行为。**询问节点（question 场景）popover 布局**：按「问题标题 → 思考 → 正文 → 选项卡指示器 → 选项区+操作」自上而下排列——标题行由 popover 独立渲染（QuestionCard 经 `show-heading=false` 隐藏自带标题，选项区复用 QuestionCard）；多问题批次的选项卡**高亮由当前活动问题（activeQuestionId）联动**（当前题对应 tab 高亮，“下一步”推进后高亮跟走），**点击选项卡不切换问题内容**——问题只由“下一步”实质切换；进入新问题后选项卡选中项、自由文本与展开态全部重置，与上一题无关联。审批倒计时直接显示在节点上，并与图标能量扫描、入边脉冲共用随剩余时间加速的周期。画布外围使用独立灰黑椭圆径向衬底，中心压暗并在四周连续衰减至完全透明，不出现矩形边界；所有连线使用平滑垂直贝塞尔曲线（控制点取纵向中点，跨车道分支形成上下 S 弯，同车道相邻退化为直线），thread/spawn/tool/merge 分别使用青、品红、琥珀和绿色纤维，紧凑波头与短尾沿源节点到目标节点传播。点击节点时其入边播放一次脉冲；运行判定对工具节点与消息节点统一（待审/待答/调用运行中均视为运行），正在响应或等待交互的节点其入边与出边整条活跃路径（含工具分支节点）持续脉冲，不再跳过中间工具节点。

纵向布局提供“时间布局”和“层级布局”两种模式，首次打开工作台默认使用时间布局；四档节点折叠首次默认使用第三档“参与者折叠”。时间布局按全局 canonical `orderKey`（瞬态节点按 `createdAt`）严格向下排列，保持完整执行时序；层级布局忽略不同分支间的时间先后，按执行图上下游关系分层，每个目标节点至少位于其最深父节点的下一层，同一 Agent 内的连续节点仍保持上下顺序，不同分支的同层节点允许横向并排。两种模式都使用统一固定行距，且只改变纵坐标；spawn 树车道、节点样式、连线和交互保持一致。用户在右侧操作区选择的布局模式与折叠档位按工作台预设写入前端本地存储，切换会话或重新打开工作台后恢复；没有有效记录时分别回退时间布局与第三档。切换模式时清空布局缓存并重新 fit 画布。

车道按 spawn 树分配，横向 lane 间距为 110px：root 固定 lane 0，直接子代按负载落在 lane -1 或 +1；同一工具批次并发派发的同侧子代各占一列向外递增不复用，跨批次串行同侧子代仍复用该列；单个后代向父同侧外移一列。一个 agent 派生多个后代时，其整列先向外移一格，再让子分支从内侧到外侧连续展开（例如左侧 child -1 派生两个孙代后，child 改为 -2、孙代为 -1 与 -3；右侧镜像）。紧凑 lane 下节点标题使用约 96px 的单行省略展示，完整内容由详情弹窗提供。树以二维画布呈现：初次载入、切换根会话、切换折叠/布局模式或显式复位时按可用顶部空间 fit；普通发送、流式追加、输入框开合和 ResizeObserver 只更新内容/渲染尺寸，保持当前平移与缩放不动。用户拖动或缩放后停止末尾自动跟随；停止跟随期间若有新节点追加，画布右下角浮现「回到底部」浮标，点击才恢复 fit。存在待审批节点时仅在其不在视窗内时定位到审核节点。4px 阈值区分点击与拖动，滚轮以指针位置为锚点缩放。主线末节点承载运行控制。系统请求减少动态效果时复位直接完成，保留静态层级与状态可读性。

真实数据下 assistant 消息的工具调用按响应批次聚合为单个 `tool-batch` 节点（排除 `spawn_role`——它由 spawn 分支线表达子 agent，重复会冲突）；同一批次内含多个工具调用时，在节点详情 popover 顶部以 tabs 按 `index` 切换，单工具直接展示，不拆分为独立节点。**询问用户批次（`ask_user_question`）的 tabs 语义不同**：高亮由当前活动问题联动、点击不切换、布局为标题→思考→正文→tabs→选项（详见上方「询问节点 popover 布局」），非询问批次保持 tabs 点击切换工具详情不变。运行节点与 CRT 读取同一 canonical message，每个 assistant `messageId` 对应一台 CRT。CRT 始终以标题栏贴靠所属节点的左侧或右侧，不参与窗口间避碰；多个 CRT 允许重叠，点击任意 CRT 提升其局部 z-index。用户可拖动 CRT 标题栏调整位置；节点树 pan/zoom 或布局改变后，CRT 会重新吸附到所属节点旁。节点连线起点跟随节点、终点跟随 CRT。CRT 宽约 360px，不为保证正文底部留在视口内而把窗口推离节点；标题栏、页签、正文、页脚、内外边距和字号相对旧版统一收紧约 15%；位置与层级只在当前工作台打开周期内保留。

节点树内部使用独立于应用 overlay 的语义层级：GPU 画布与连线位于最底层，其上依次为节点命中层、节点 hover 详情、CRT 实时运行卡、消息 composer、待审批/待回答等强制交互，最后是工作台关闭按钮和侧边工具。内部层级只在 `AgentDialog` 的工作台 stacking context 中比较，不得使用 `410/430` 等应用级数字越过 HistoryDrawer 或 SettingsDialog。hover 详情是被动预览，不覆盖 CRT；composer 是用户主动输入，始终高于 hover 和 CRT；审批/提问要求用户决策，始终高于 composer。

Nyxus 消息输入不再投影 `input:draft:*` 虚拟节点，也不 Teleport 到节点坐标。点击主执行终点只打开固定在工作台底部中央的浮动 composer；画布仍可见，但临时 hover 详情关闭。composer 在自身坐标系内向上自适应增长，命令/角色菜单锚定输入框并继承 composer 层级。composer 头部内置小组角色编制：展示全部角色并允许就地调整各角色大脑（模型），与普通发消息弹窗能力一致（不提供会话目标选择，发送目标即当前展示的节点树会话）。`@` 菜单只列出当前 preset 中非 leader 且显式配置 `mentionable: true` 的角色，Nyxus 预设的 `curator` 可选择；`Esc` 放弃草稿，发送中禁止关闭。提交成功后 composer 收起，只有服务端 pending input 或乐观 user message 才进入 canonical 节点树，因此节点数量、布局和 fit 不受未发送草稿影响。

工作台画布从标题栏（窗口控制一栏）下方开始：节点树视口不覆盖标题栏，`fitToView` 在标题栏之下的可视区内居中/锚定，复位或最大化后起始节点不会滑到标题栏下方。

### Nyxus 弹窗渲染主题

节点树三类弹窗（hover 预览 popover / 常驻审批气泡 / 提问气泡）统一使用一套 CRT 终端风渲染主题，集中管理在独立的 [nyxusPopoverTheme.less](../../../web/src/features/pets/nyxus/styles/nyxusPopoverTheme.less)，由 `MessageBranchTree.vue` 的 `<style scoped lang="less">` 经 `@import` 引入。主题覆盖所有节点类型的弹窗内容：

- **工具节点**：`SenseCallRenderer` 分发的全部专用渲染器（`CommandRenderer`/`SearchRenderer`/`SkillRenderer`/`FileReadRenderer`/`FileWriteRenderer`/`SpawnRenderer`/`MediaRenderer`/`QuestionRenderer`/`TodoRenderer`）与通用降级 `SenseCallBox`，统一复位其默认浅色卡片（去 `border`/白底/`border-radius`/`box-shadow`），内部 head/label/code 块/pre 块/toggle 折叠/copy-btn/彩色 badge/状态字形/输出区全部 CRT 化。
- **审批气泡**：`ApprovalCard` + `ParsedArgs` 的参数行、按钮、徽章。
- **提问气泡**：`QuestionCard` 的标题、选项卡、选择标记、自由输入（element-plus `el-textarea`）、操作按钮--从原蓝紫玻璃风改为 CRT 灰绿调，交互结构不变。
- **消息节点 popover**：user 文本、assistant markdown（含 thinking 折叠--内容低于 5 行默认展开、streaming 占位、hljs 代码高亮）。user 正文中的 `[[command:/x]]` / `[[role:@x]]` token 经 `splitCommandPrompt`（与主聊天面 `MessageBubble` 同源）拆分后渲染为像素风 terminal 方括号 tag（`.nx-tag`）：方角 + 等宽 + 关闭字体平滑 + CRT text-shadow + 字符化 `[ ]` 括号定界，command 黄 `#ffe18b`、role 蓝 `#7da7ff`，括号半透明弱化突出值；其余纯文本仍走 `pre-wrap`。

CRT 调色板：深灰绿底 `rgba(55,61,60,0.97)` + scanline 横纹 + 噪点 + 偏移 text-shadow，方角（容器 `border-radius:2px`、内部元素 `0`），等宽字体；浅灰绿字 `#d7dfd8`/`#cbd6cd`，代码块底 `rgba(0,0,0,0.4)`；语义色绿 `#5be5b0`（done/ok）、黄 `#ffe18b`（running/warn）、红 `#ff809b`（error/no）、蓝 `#7da7ff`、紫 `#c9b6ff`。button 为深底+浅边+浅字、hover 浅底；badge 为暗底+语义色字。

popover 内所有 renderer 折叠区（命令输出/搜索结果/参数/结果/文件内容/技能内容/媒体提示词）默认全展开——`SenseCallRenderer` 透传 `defaultExpanded` prop，节点树 popover 传 `true`，主聊天面 `MessageBubble` 不传=默认收起不变。

**约束**：基组件（`ApprovalCard`/`QuestionCard`/`ParsedArgs`/各 renderer/`SenseCallBox`）自身的浅色样式不动--它们仍服务主聊天面 `MessageBubble` 的暖米黄 `.bubble` 卡片。节点树只通过 `:deep()` 在 `.popover-tool`/`.approval-frame`/`.question-frame` 等组件内真实 class 下穿透覆写，不影响主界面。`:deep()` 均带父选择器以兼容 scoped + less `@import` 编译序（less 编译合并在前，Vue PostCSS scoped 识别 `:deep()` 在后）。

### Nyxus 钢琴键条（NyxusPianoStrip）

对话框底部边框线外挂的标准钢琴键盘（按视口宽度选 1/2/3 八度档位--取不超过视口的最大整八度，不足 1 八度取小档；渲染键数 = max(档位键数 12/24/36, 会话数)）。琴键只映射**原生 root 会话**：过滤 `!parentChatId`（剔 spawn 子角色）且 `branchKind` 缺省或 `'original'`（剔延续/解释分支）。分支会话（`chat.branch.create` 产物）本身是无 `parentChatId` 的独立 root chat（从属关系存 `conversation_branches` 表，且 metadata 继承原会话 preset），仅靠 `!parentChatId` 过滤不掉，必须按 `branchKind` 显式剔除；被激活为主干的 continuation 也经工作台标题栏分支切换访问，不占琴键。会话按 `createdAt` 降序映射到琴键，最左侧是最新创建的数据，最右侧是最老数据。铺满判定：渲染白键 × 32px ≤ 视口时白键按比例均分填满视口（消除右侧空隙，单键宽随档位接近 32px 钢琴规制）；会话多于档位致轨宽超出视口则固定 32px 横向拖拽平移。档位下限保证黑键在琴轨内完整渲染（不出现半个键）。所有键点击都会发声并短暂高亮；只有存在会话摘要的键才切换活跃会话并保留选中态（无会话的空键发声但不切换）。hover 始终显示音名与 MIDI 编号，有首条用户消息时追加消息摘要，已有会话但无消息时追加“无消息”。运行中且有 pending 审批的键显示倒计时并闪烁（临近过期加速），时间标签使用高对比度样式。tooltip show-after 与键 hoverLeave 同为 150ms，快速划过不残留。

钢琴面板右上角固定放置无边框的静音与垃圾桶，声音和删除不再占用通用工具抽屉。会话删除继续走拖拽二次确认（不开弹窗）：hover 可删键时琴轨最底部（统一位置，不随白/黑键高度变化）显示「清除」圆形按钮（拖拽源）；按住后把会话拖到右上角垃圾桶释放即触发 `agents.deleteSession`（后端 `destroyAgent` 级联后代 + 同步清 historyList/pets/streams）。拖拽期间源会话琴键保持主题色描边、抬升与内发光，明确标记当前拖拽来自哪个节点；命中垃圾桶后自然衔接删除收缩动画。命中判定仅针对垃圾桶元素的 `getBoundingClientRect`。拖拽幽灵通过 `Teleport` 挂到 `body`，不受钢琴 popout 的 transform containing block 影响，始终以视口坐标跟随指针并显示会话消息气泡 icon。运行中（`run.status==='running'`）或有 pending 审批的键不可删（按钮不显示）。**删除交互期间锁定钢琴 popout 不关闭**：hover 可删键 / 拖拽中 / 倒掉动画任一为真时，NyxusPianoStrip emit `interacting-change=true`，AgentDialog 置 `pianoPinned=true`；交互结束只解除锁定，不将其等同于鼠标离开。删除完成后 `historyList → sessions → keyViews` 自动重算并在原钢琴组件中更新琴键，钢琴保持打开；仅当锁定期间确实收到面板离开请求时，解除锁定后才执行延迟关闭。释放命中后 ghost 飞向垃圾桶中心并缩小消失，被删键收缩、淡出、下沉，随后播放桶盖与桶身反馈。删的若是弹窗当前焦点会话，**先把焦点切到剩余 updatedAt 最近一条（无剩余则进入空态）再级联删除**，避免弹窗因 active id 清空而重挂载。

```text
div.pet-wrap                                                            // 根容器（无 z-index/position → 不创建 stacking context，气泡 z-index 跨 pet 比较）
  AnimatePresence > Motion.speech[:style=approvalStyle z=400]           // 主气泡 tier 1：审批卡片（CP5；优先级最高；z-index 单独提到 400 高过 AgentDialog/HistoryDrawer/FAB 防遮挡；✕ 移队列 + auto-pop 下一个；详见 §PetIcons）
  AnimatePresence > Motion.speech[:style=speechStyle z=100+]            // 主气泡 tier 2/3/4：error → work-main → 默认装饰气泡（v-if 互斥，key 切换；锚点=pet 顶部中心下移 BUBBLE_OFFSET_Y 贴 status-row 上方 16px；motion x:"-50%" y:"-100%" 居中+上移自身高度）
  AnimatePresence > Motion.speech.side[:style=sideBubbleStyle]          // 左侧 thinking 副气泡（CP2；同尺寸浅色，顶部齐平主气泡；仅 hasContent && thinking 非空时显；approval 时抑制）
  Motion.todo-panel[:style=todoPanelStyle]  (v-if petHasTodo)            // 右侧 todo 侧栏（能力驱动：pet senseGroup 含 update_todo 才显；checklist 读自己 chat 最近 update_todo args.todos；只读）
  div.pet-icons[:style=petIconsStyle]                                    // pet 头部右侧 icon slot（CP5 扩展）：两列布局
    .col.history-col                                                    //   history 列：本 chat 最近 5 条 HistoryItem 小圆点（role 配色），hover 气泡显 preview
    .col.approval-col                                                   //   approval 列：当前 approval（实心高亮）+ approvalQueue（闪烁，频率=remainingSec）
  div.pet[:class=classes :style=translate3d(x,y)+zIndex(petBodyZIndex) + --pet-direction + --pet-scale + --tribe-hue]  // RAF 位置容器（无交互）
    span.shadow (CSS 呼吸，随 --pet-scale 缩)
    span.dir[CSS scaleX(--pet-direction)]                               // 朝向瞬切
      Motion.sprite[:animate=spriteMotion(action)]                      // grid-template-columns:100% 修复展开抖动
        div.status-row: span.stat.emotion .fill + ContextBar            // 状态条（头顶，固定尺寸，不触发交互）：emotion 条 + contextUsage bar（取代原 fatigue bar）；2px track 底色不透明（不再半透明，深色桌面可辨）
        span.head-row[role=button + 长按拖拽/短按抚摸 + keydown + cursor + touch-action + transform:scale(--pet-scale)]  // 命中区=身体（face+hands）；ghost 时 `.pet` pointer-events:none、head-row 收缩到 face emoji ~26px（命中区=emoji，消队列重叠遮挡）
          Motion.hand.left[:animate=handMotion(action,'left')]          hands[mood].left
          span.face-flip[scaleX(--pet-direction) 抵消父 .dir]           // 朝向翻转容器：脱离 .dir 整树镜像，face 自管朝向
            span.face-rotate[rotateY(反向:dir1→180°镜像/dir-1→0°正向)+transition 420ms]  //   翻转动画层（人物emoji默认朝左，反向使朝向跟随移动）
              span.face-side.front[backface-hidden, position:relative]  //   正面占位（撑 face-rotate 尺寸）
                Motion.face[:animate=faceMotion(mood)/ghostFaceMotion] face[mood]/ghostFace
              span.face-side.back[rotateY(180°)+scaleX(-1)+backface-hidden] //   背面定位+预镜像（容器转 180° 显镜像；非 360° 抵消正向）
                Motion.face[:animate=同上]                              face（镜像背面）
          Motion.hand.right[:animate=handMotion(action,'right')]        hands[mood].right
        div.meta-row: PetNameTag + PetToolbar                 // 共享实色控制台：名字常驻且省略长名；工具栏 hover/focus 展开，触屏常显；仅外壳有边框，按钮以 hover 底色和危险色分区表达命中区
        span.zzz (v-if action=sleep)                                    // 休息浮字
    span.busy-indicator (v-if isBusy)                                   // 忙碌指示：思考中三点紫脉冲（PetStatusBar 内 .status-stack 右端）。去背景框（无 surface-soft 底 + 无紫虚线边框），深色场景不再显突兀
```

**颜文字渲染（神性光辉）**：`PetDivineHalo.vue` 作为脸部后的独立世界层，仅渲染中心向外渐隐的橄榄球形光晕与 68 根叶脉式细长光刺，不包含封印、轨道、节点、电路或装饰碎片。光刺以确定性噪声生成，保证每个 pet 形态稳定：左右方向最长、上方次之、下方较短，单刺最大 19px（不超过 96px 光效画布的约 20%）；每根使用叶片形渐变柔光，中央另有 0.7px 亮叶脉。每根独立设置 `reach`、持续时间、负延迟和正/负微旋转角，从中心闪现并向外生长，部分只到约 46% 长度就开始虚化，最终在各自终点消失。浅色主题使用深靛光背 + 浅色颜文字，深色主题使用象牙金光背 + **深紫颜文字与手部**；忙碌态仅增强光刺清晰度和中心呼吸速度，`prefers-reduced-motion` 下退化为静态光辉。主 pet 在 `.face-shell` 渲染一份光效；子 pet 在 `.face-flip` 根部渲染一份，翻转时光效不随脸卡旋转。

位置、朝向、主体动作、手部动作、表情滤镜各在独立层，transform 不冲突。`.sprite` 用 `grid-template-columns:100%` 使各 row 独立居中，工具栏展开不再偏移 face（修复抖动）。`--pet-scale`（主 1 / 子 0.75）仅作用于 `.head-row` + `.shadow`——子 pet 体型缩小但 name/PetToolbar/status-row 尺寸不变。`.status-row` 移至 head-row 之上（头顶），固定尺寸不随 scale 缩。

**命中区**：`.head-row`（身体=face+hands）触发拖拽/点击/keydown（长按拖拽 + 短按抚摸）；**hover 检测扩到整个 `.pet`**（`pointerenter/leave` 绑 `.pet`）→ 悬浮即冻结移动，toolbar 可点中。Ghost 不进入此结构，`GhostDot` 整体为纯展示且 `pointer-events:none`。

**交互（长按拖拽 + 短按抚摸）**：`pointerdown` 启 300ms 定时器（`LONG_PRESS_MS`）+ 记录落点；**长按超时或移动超阈值（`DRAG_THRESHOLD_PX=5`）**任一触发 → `startDrag`（`setPointerCapture` + 进入 `dragging`）；**短按（<300ms 且未超阈值）松开** → 取消定时器，不拖拽，让 `click` 触发 `clickPet` 抚摸。拖拽结束的 `pointerup` 紧随触发 `click` → `suppressClick` 标志抑制，避免拖拽完又抚摸。长按等待中离开 `.pet`（`pointerleave`）取消定时器。`onPointerMove` 在等待中检阈值，进入拖拽后透传 `drag`。（实现下沉 [usePetDrag.ts](../../../web/src/features/pets/usePetDrag.ts)：常量 `LONG_PRESS_MS`/`DRAG_THRESHOLD_PX` + 私有态 + handler + `petHover` + `onBeforeUnmount` 清 `longPressTimer` 集中；行为不变。）

**z-index（inline 动态，气泡与身体分离）**：`.pet-wrap` 无 z-index/position → 不创建 stacking context，故 `.speech` 与 `.pet` 的 z-index 在 stage 层级跨 pet 直接比较。z-index 由 inline `:style` 提供（CSS 仅 fallback）；原 `.is-master`/`.is-chatting`/`.is-dragging` 的 z-index 规则已移除。**hover 提层级**：`petBodyZIndex` 加 hovered 分支（z=15，低于 drag 20、高于普通 pet）-> 被悬停 pet（ghost 队列残余对角重叠时尤需）置顶，不被相邻遮挡。

| 层 | 公式 | 取值 | 效果 |
|----|------|------|------|
| 身体 `petBodyZIndex` | `dragging→20`；否则 `(hasSpeech?10:0)+(isMaster?2:1)` | 拖拽20；有气泡主12/子11；无气泡主2/子1 | 默认主盖子；**子有气泡主无时子(11)>主(2)→子盖主**；都有时主(12)>子(11) |
| 气泡 `speechZIndex` | `dragging→120`；否则 `100+(isMaster?2:1)` | 拖拽120；主气泡102/子101 | 气泡整体高于身体（100+>20）；气泡间主>子 |
| 审批 `APPROVAL_Z_INDEX` | 固定 400 | 400 | **高于 AgentDialog 300 / HistoryDrawer 280 / FAB 200 / picker-backdrop 199**；避免审批气泡被其他浮层遮挡（CP5 修复原"点空白关闭"问题，实际是被覆盖） |
| PetIcons `petIconsStyle.zIndex` | `speechZ - 1` | 100/99 等 | pet 头部右侧 icon slot，低于气泡避免遮挡 |

**名字与工具控制台**：`.meta-row` 提供接近不透明的主题表面、统一外边框和投影，名字不再拥有独立重边框/投影，也取消影响辨识度的逐字彩虹动画；文字为 9px/700，长名省略并通过原生 `title` 展示完整内容。`PetToolbar` 位于名字下方，鼠标悬浮或键盘聚焦时展开；无 hover 的触屏设备始终展开。按钮点击区为 22×22px，取消逐按钮边框，以共享底板、hover/focus 填色表达命中区；关闭/隐藏按钮保留常态淡红底与分隔线。

## 对话框 slot 与 4 tier 气泡

```vue
<AnimatePresence>
  <MotionDiv v-if="stream?.approval" :key="`approval-${stream.approval.approvalId}`" class="speech approval-bubble" :style="approvalStyle" ...>
    <ApprovalCard :approval="stream!.approval!" :chat-id="pet.chatId" />
  </MotionDiv>
  <MotionDiv v-else-if="stream?.error" key="work-error" class="speech work-bubble error-bubble" ...>
    <div class="work-text error-text">⚠ {{ stream.error }}</div>
  </MotionDiv>
  <MotionDiv v-else-if="showWorkMain" key="work-main" class="speech work-bubble" ...>
    <div class="work-text" :class="{ 'is-thinking': thinkingOnly }">
      <span v-if="hasContent" class="md" v-html="renderedContent" />   <!-- content md（renderMarkdown）-->
      <template v-else>{{ stream?.thinking }}</template>               <!-- thinking 纯文本 -->
    </div>
  </MotionDiv>
  <MotionDiv v-else-if="pet.speech || $slots.dialog" :key="pet.speechUntil" class="speech" ...>
    <slot name="dialog" :pet="pet">{{ pet.speech }}</slot>
  </MotionDiv>
</AnimatePresence>
```

主气泡 4 tier 由 `AnimatePresence` 互斥切换（优先级：提问 > 审批 > error > work-main > 装饰）：⓪ ChatSession 当前提问（`activeQuestion`）显 `variant="question"` 气泡内嵌 `QuestionCard`；① ChatSession 当前 approval 显 ApprovalCard；② run error 显 error-bubble；③ active message 满足 working/retain/hover 门控时显工作气泡；④默认装饰气泡。thinking 阶段显示 `activeMessage.thinking`，content 到达后主气泡显示 `activeMessage.content`，thinking 收入副气泡。done 后 presentation selector 用 `retainUntil` 保留最后消息 20 秒；新 `msgId` 到达时立即切换到新空消息。pet 身体 hover 不复现已过期历史气泡。

**提问气泡**：`QuestionCard` 以 `variant="bubble"` 渲染在 `.speech.question-bubble` 内——`is-bubble` 样式去除卡片自身边框/背景/圆角/阴影/`min-width`（`width:100%`、`max-width:none`、padding 归零，由气泡统一承载框架与 6px 9px 内边距），避免双层边框与内层溢出外层；气泡 `max-width: 320px`（比 approval 220px / work 180px 略宽以容纳选项卡排版），`::after` 尾箭头背景与边框对齐 neon-indigo 气泡色（同 `.approval-bubble` 覆写模式）。

气泡背景统一不透明化（透明窗下所有 variant 文字可辨）：`.speech` 基类与 approval/question/error/work（含 is-thinking）各 variant 背景提升至约 92-95% 不透明（提高 color-mix 基色比例 / 换实底），仅保留轻微通透感；`::after` 尾箭头背景同步。

ApprovalCard 的参数内容默认展开。每条审批使用 approvalId 作为渲染 key，切换审批时重新初始化倒计时和请求状态。有限时审批到零即按 approvalId 从当前项或队列移除并推进下一项，避免保留不可操作的过期气泡；后端仍以审批超时自动拒绝为权威语义。审批气泡尾角继承主体暖色背景和边框，且不参与 pointer hit-test。

## PetIcons：pet 头部右侧 icon slot（CP5 扩展）

```vue
<PetIcons :chat-id="pet.chatId" :style="petIconsStyle" />
```

位置：`.pet-wrap` 内 absolute，锚定 `pet.x + width`（pet 右侧紧贴），`top` = pet.y + 16（status-row 同高），z-index = `speechZIndex - 1`（低于气泡避免遮挡）。容器 `pointer-events:none`，内部 icon 显式 `auto` 收点击；非 ghost pet 才挂载（ghost 不需要历史/审批入口）。

**两列布局**：

| 列 | 数据源 | 元素 | 交互 |
|---|---|---|---|
| history 列（左） | `selectOwnTimeline(chatId)` 的最近 5 条消息；active 消息按同一 `msgId` 原位更新 | `.history-icon` 14px 圆，dot 按 role 着色；含 thinking 时外圈加紫色虚线 | hover → 浮动预览；不触发历史加载 |
| approval 列（右） | ChatSession `interaction.approval` + `approvalQueue` | 当前项实心高亮，队列项闪烁 | queue 项通过 ChatSession action 重新唤起 |

**闪烁频率**：`approval-flash` CSS keyframes，`animation-duration = var(--flash-period)`，`flash-period = max(0.2, min(5, remainingSec * 0.1))` 秒。剩余时间越少闪得越快，视觉紧迫感。`waitTime=0`（不超时）→ 周期封顶 5s（低频慢闪）。

**与气泡的协调**：审批在 `approval` 时气泡展示（z-index 400 不被遮挡）；用户点 ✕ 移入队列后气泡卸载，icon 出现并闪烁；点击闪烁 icon → `resummonApproval` 把该项移到 `approval` 重新唤起气泡。Accept/Reject → `dismissApproval` 清空 + 自动从 queue head pop 下一个进 `approval`（多审批连续推进）。

侧气泡（`.speech.side`）独立 `AnimatePresence`，仅在 `showWorkSide`（hasContent && thinking 非空 && 无 approval）时显，motion `x:"-100%" y:"-100%"`（顶部齐平主气泡），同尺寸（max 180×140）+ 复用 is-thinking 浅灰虚线 + 斜体灰字（与主气泡 content 白底实线区分），定位 `sideBubbleStyle`（`top` 同主气泡，`left=pet.x-60` 向左展开）。

历史抽屉直接渲染 ChatSession timeline。实时 stream delta 携稳定 `msgId`，reducer 首次看到该 id 时建立 streaming message，后续 staged/done/sync 只补全同一对象。MessageBubble 的 key 始终为 `msgId`，content/thinking 更新即产生与 Pet 相同的实时打字效果。主抽屉通过 selector 动态聚合后代 ChatSession，不保存 child 副本；整轮结束不再延迟 300ms 重载。

Ghost 不再复用 PetBody。已完成子 Agent 使用独立的发光点渲染：约 10px 个体色圆点、外发光、轻呼吸闪烁和常显短名；不渲染手、表情、状态、气泡、图标或工具栏，也不接受点击、悬浮、拖拽。

## Busy indicator

> 源码派生 [useStreamBubble.ts](../../../web/src/features/pets/useStreamBubble.ts) `isBusy` ｜ 渲染 [PetSprite.vue](../../../web/src/features/pets/PetSprite.vue) 模板 + `.busy-indicator` 样式

**与气泡显示解耦**：busy-indicator 显隐走 `isBusy`（独立 computed），不再绑 `hasStream`。hasStream 复合条件（content/thinking 非空 + working/retain/hover）负责气泡显示生命周期；isBusy 仅表达"还在做事"。

**派生语义（C 方案）**：

```ts
isBusy = !isGhost && (chat.run.isWorking || chat.interaction.runningTools.length > 0 || chat.interaction.approval != null || chat.interaction.questionBatches.length > 0);
```

- 不含 hover（hover 仅保持气泡显示）
- 不含 `retainUntil`（done 后保留期不视为"还在做事"）
- 含 running tools（用户视角"工具在跑"）
- 含 approval（待审批也属"阻塞式忙"）

**视觉**：自定义 SVG 双圆环 loader，16×16，`viewBox="0 0 24 24"`，face 右上角偏移（`right:0; top:26px`）。外圈 `.busy-ring` 虚线圆（`stroke-dasharray: 3 3`，`fade(@ink, 28%)`），内圈 `.busy-arc` 实心弧流光（`stroke-dasharray: 18 18`，主题橙 `#f6b73c`，`busy-arc` keyframes 推动 `stroke-dashoffset 0 → -36`）。整体 1.4s 旋转（`busy-spin` 0→360deg），`drop-shadow(0 1px 1px rgba(0,0,0,0.18))` 抬离背景。

> 注：项目历史决策使用主题橙 #f6b73c（[web-element-theme-palette](../../element-theme-palette.md)），与 PetIcons approval 列 `is-current` 同色；ring 用半透明 ink 而非彩色，保证 loader 不喧宾夺主但仍显眼。

> agent 接入引入的 status-row/meta-row/speech 变化见 [agent-integration.md](./agent-integration.md) 渲染分层注记。
