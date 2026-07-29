# 渲染分层（PetSprite.vue）

> 源码 [PetSprite.vue](../../../web/src/features/pets/PetSprite.vue) ｜ 上级 [README.md](./README.md) ｜ 动画 variant 见 [motion.md](./motion.md) ｜ 样式见 [style.md](./style.md)

## Agent 数据边界

Pet 渲染层不拥有 Agent 会话状态。Pet presentation 只保存动作、坐标、表情、拖拽和 ghost 动画，通过 `chatId` 从 ChatSession selector 获取 working、当前消息、审批、问题、工具、上下文与恢复状态。

### nyxus 独立核心（NyxusCore）

nyxus 粒子核心是独立于 pet 体系的视觉组件（[NyxusCore.vue](../../../web/src/features/pets/components/NyxusCore.vue)），全局挂载于 App 顶层（`position:fixed; z-index:250`），**不经过 PetStage/PetBody，也不是 PetInstance**。数据源为 chatSessions 的 nyxus 会话（root chat + `preset==='cheryNyxus'`，经 `selectNyxusSession` 解析），工作态（thinking/content/busy）由 `useNyxusWorkState` 投影、`useStreamBubble` 派生，不经 pets[]。核心复用 standalone 运动（`useStandaloneNyxusMotion`：自由漂移 + 长按拖拽 + pointer 扰动 + 边缘 clamp）；单击触发工具环菜单（create/chat/history/settings，状态在 `nyxusUiState`），双击打开 AgentDialog，3 连击触发 agitated 反应；Canvas 雾化轨迹连接菜单按钮（`updateToolTargets` 每帧测量按钮矩形写入）。工作气泡（[NyxusBubbles.vue](../../../web/src/features/pets/components/NyxusBubbles.vue)）仅 error + work-main（thinking/content）两 tier + busy-indicator，approval/question 走 AgentDialog。cheryNyxus 会话由 `getOrCreateCheryNyxus`（chat-only，不建 pet）确保，创建后 `chatSessions.hydrateTree` 灌入投影。

粒子场按暗点、普通点、高亮星、强闪星分成四档。暗点中的一部分按归属聚为更多层次的云团：梦幻紫、靛蓝、宝蓝、青蓝、青绿和玫红等高饱和色以低频插值缓慢流转，保持纯净绚烂而不掺灰。星云整体收拢时按实时密度提高饱和度和亮度，散开时保持同色系压暗以形成纵深；外围云团和悬臂也维持清晰的彩色外发光，连成明亮但柔和的带状星云。彩色云团先在独立图层内以常规混合绘制：中心按密度显著降亮并保持颜色，外围悬臂则更明亮；图层仅以最高 80% 的透明度合成到主体，避免加色叠加泛成大块纯白，也不遮住随后绘制的星点。中心暗色基底只保留小范围聚焦与外围轮廓。云团、悬臂和星点仍共用同一运动场；普通星点使用略带冷暖色的小核心与细微光晕，确保在云团中可辨但不抢眼。高亮星（恒星）在初始分布和运行碰撞中保持间距，核心始终纯白；鲜艳的紫、青蓝、玫红等颜色只用于其柔光、诞生与爆发环。恒星会持续经历缓慢渐生、长期稳定、爆发和消逝：爆发以所属鲜艳色的径向闪光环扩张并渐隐，消逝后随机白点再渐生为新恒星补位、总数恒定。星盘主旋转周期按粒子随机落在 30–60 秒；自动宇宙形态的完整稳定段至少保持 30 秒，并以平滑曲线切换。双星形态会让中心状态点随形态渐隐和渐显，不会突变。该粒子场支持星云、黑洞、脉冲星、双星、超新星与潮汐环模式。

### Nyxus 移动与云团过渡

独立运动采用分段航行：每次选定一个有限目标后，以较低速度缓慢加速、缓慢减速并抵达，再静止数秒播放粒子动画；鼠标位置仅在下一航段取样，绝不逐帧重算目标，因此不会出现像素级追随抖动或突然蹿动。Nyxus 会按包含外部光晕的安全距离避开 `pets[]` 中的普通 Pet；避让沿用相同的缓慢曲线，只改变其独立位置，Nyxus 不进入 `PetInstance`，也不会获得主 Pet 的信息栏、名称或工具栏。

紫、蓝云团在聚散时共用一套连续的色相插值；端点仅改变明度和透明度，避免最散或最聚时跳成灰浊杂色。云团纹理以更长的径向渐隐衔接，形成更柔的外发光悬臂；最终云层合成透明度仍不超过 80%。

Canvas 动作按以下优先级解析，避免鼠标和 Agent 状态互相覆盖：`dragging > released > menu > working > reach > reaction > cosmic > sleep > idle`。待机时星盘缓慢自旋、呼吸收缩并随机切换宇宙模式；鼠标靠近会扰动粒子场，长按可拖拽主体，工具菜单打开后灰雾和星点向环绕入口延伸。

实时消息规范化保存在 `ChatSession.messagesById[msgId]`，`activeMessageId` 指向当前 LLM 响应。Pet 工作气泡与 HistoryDrawer 的实时行读取同一个 `ChatMessage`：

- 新 `msgId` 首次到达时，旧 active 消息封口并保留在历史；新消息先以空 thinking/content 建立，再应用首个 delta。
- Pet 只显示当前 active 消息（或 done 后 retain 期内最后一条），因此不会残留上一轮文本。
- HistoryDrawer 以同一稳定 `msgId` key 原位更新该消息，服务端 delta 即打字效果；不创建第二份 typing buffer。
- 一个 `runId` 可包含多个 `msgId`（工具循环），每个新 `msgId` 都执行上述切换。

主历史通过 selector 聚合 root 与 descendants 的消息引用并做角色重映射，不把 child 消息复制进 parent。抽屉打开、关闭、下钻只改变 UI 栈，不加载历史、不清 Pet retain 状态。

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
        div.status-row: span.stat.emotion .fill + ContextBar            // 状态条（头顶，固定尺寸，不触发交互）：emotion 条 + contextUsage bar（取代原 fatigue bar）
        span.head-row[role=button + 长按拖拽/短按抚摸 + keydown + cursor + touch-action + transform:scale(--pet-scale)]  // 命中区=身体（face+hands）；ghost 时 `.pet` pointer-events:none、head-row 收缩到 face emoji ~26px（命中区=emoji，消队列重叠遮挡）
          Motion.hand.left[:animate=handMotion(action,'left')]          hands[mood].left
          span.face-flip[scaleX(--pet-direction) 抵消父 .dir]           // 朝向翻转容器：脱离 .dir 整树镜像，face 自管朝向
            span.face-rotate[rotateY(反向:dir1→180°镜像/dir-1→0°正向)+transition 420ms]  //   翻转动画层（人物emoji默认朝左，反向使朝向跟随移动）
              span.face-side.front[backface-hidden, position:relative]  //   正面占位（撑 face-rotate 尺寸）
                Motion.face[:animate=faceMotion(mood)/ghostFaceMotion] face[mood]/ghostFace
              span.face-side.back[rotateY(180°)+scaleX(-1)+backface-hidden] //   背面定位+预镜像（容器转 180° 显镜像；非 360° 抵消正向）
                Motion.face[:animate=同上]                              face（镜像背面）
          Motion.hand.right[:animate=handMotion(action,'right')]        hands[mood].right
        div.meta-row: span.name (per-char 彩虹流动, max-width+ellipsis 让位) + PetToolbar + RunningTools  // 工具栏（CP2/CP6）：主[历史/中止/销毁] / 子[历史/中止]；RunningTools=运行中工具 icon 组（sense_started/accept 驱动，多 icon 并发）
        span.zzz (v-if action=sleep)                                    // 休息浮字
    svg.busy-indicator (v-if isBusy)                                   // 忙碌 loader：自定义 SVG 双圆环（外圈虚线圆 + 内圈实心弧流光），主题橙 #f6b73c，详见 §Busy indicator
```

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

**name 部落色**：同部落（主+子）name 同底色 `hsl(tribe-hue)`；子 name 文字=部落深色，**主 name 文字=动态彩虹流动**——name 拆为 per-char `<span>`，每字符色相按序递增（`--char-i` 计算 `hsl(base + i*step)`），`animation-delay` 按字符序错相 → 整体从左往右波浪流动。

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

主气泡 4 tier 由 `AnimatePresence` 互斥切换：① ChatSession 当前 approval 显 ApprovalCard；② run error 显 error-bubble；③ active message 满足 working/retain/hover 门控时显工作气泡；④默认装饰气泡。thinking 阶段显示 `activeMessage.thinking`，content 到达后主气泡显示 `activeMessage.content`，thinking 收入副气泡。done 后 presentation selector 用 `retainUntil` 保留最后消息 20 秒；新 `msgId` 到达时立即切换到新空消息。pet 身体 hover 不复现已过期历史气泡。

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
