# 渲染分层（PetSprite.vue）

> 源码 [PetSprite.vue](../../../web/src/features/pets/PetSprite.vue) ｜ 上级 [README.md](./README.md) ｜ 动画 variant 见 [motion.md](./motion.md) ｜ 样式见 [style.md](./style.md)

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

**命中区**：`.head-row`（身体=face+hands）触发拖拽/点击/keydown（长按拖拽 + 短按抚摸）；**hover 检测扩到整个 `.pet`**（`pointerenter/leave` 绑 `.pet`，`pointerenter/leave` 不冒泡、进子元素不触发父 leave → 覆盖 head/toolbar/name/status-row 任意位置）→ 悬浮即冻结移动，toolbar 可点中。`.pet` 的 pointer 事件仅用于 hover；拖拽/点击/keydown、抚摸/抓取光标、`touch-action:none`、键盘焦点（role=button+tabindex）均在 head-row。**ghost 特例**：`.pet` `pointer-events:none`（72×96 框不捕获，消队列内 `.pet` 重叠遮挡；原重叠致 hover/click 命中错误 ghost、leader 拖不动），head-row `min-width/height:0` 收缩到 `.face` emoji ~26px 且 `pointer-events:auto` 承接 hover/click/drag；`@pointerenter/leave` 绑 head-row guard `isGhost`（非 ghost 仍由 `.pet` 大区 hover）。

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
  <MotionDiv v-if="stream?.approval" key="approval" class="speech approval-bubble" :style="approvalStyle" ...>
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

主气泡 4 tier 由 `AnimatePresence` 互斥切换（key=`approval`|`work-error`|`work-main`|`speech`）：① `stream.approval` 存在时显 ApprovalCard（CP5；z-index 400 单独提升防遮挡；✕ 关闭移队列 + auto-pop 下一个）；② `stream.error` 显 error-bubble；③ `showWorkMain` 工作中显工作主气泡（thinking-only 或 content）；④ 默认装饰气泡/`#dialog` slot（agent 接入后基本不达，预留扩展口）。气泡为 `.pet-wrap` 内 `.pet` 的**兄弟**（脱离 `.pet` 的 transform stacking context），独立 z-index（整体高于身体）。审批气泡锚点 = pet 顶部中心下移 `BUBBLE_OFFSET_Y`（贴 status-row 上方 16px），`left`/`top` 由 inline `approvalStyle` 提供（与 `speechStyle` 同位置但 z-index=400）；其他气泡走 `speechStyle`（z-index=100+）。motion `x:"-50%" y:"-100%"` 居中 + 上移自身高度。done 后 content/thinking 保留 20s（`stream.retainUntil`，新消息/abort 清除）；pet 身体或工作气泡 hover 期间保持显示（`petHover || bubbleHover`，即使 retainUntil 过期）。（显隐/保留/滚动逻辑下沉 [useStreamBubble.ts](../../../web/src/features/pets/useStreamBubble.ts)：`nowTick` retain 定时器 + auto-scroll watcher + `onBeforeUnmount` 清 `retainTimer` 集中，收 `petHover` ref 算 `isHovered`；模板分层不变。）

## PetIcons：pet 头部右侧 icon slot（CP5 扩展）

```vue
<PetIcons :chat-id="pet.chatId" :style="petIconsStyle" />
```

位置：`.pet-wrap` 内 absolute，锚定 `pet.x + width`（pet 右侧紧贴），`top` = pet.y + 16（status-row 同高），z-index = `speechZIndex - 1`（低于气泡避免遮挡）。容器 `pointer-events:none`，内部 icon 显式 `auto` 收点击；非 ghost pet 才挂载（ghost 不需要历史/审批入口）。

**两列布局**：

| 列 | 数据源 | 元素 | 交互 |
|---|---|---|---|
| history 列（左） | `agents.streams[chatId].history`（最近 5 条，按 `createdAt` DESC） | `.history-icon` 14px 圆，**内嵌 4×4 `.dot`**，dot 按 `role` 着色：`user=#8a8f98`、`assistant=#f6b73c`（主色）、`subagent`/`role=#7c3aed`、`master=#f6b73c`；`has-thinking` 时外圈加 1.5px 紫色虚线（`#7c3aed`，55% alpha） | hover → 浮动气泡（210px max-width）显 role tag + content 截 80 字 |
| approval 列（右） | `agents.streams[chatId].approval`（实心高亮）+ `approvalQueue`（闪烁） | `.approval-icon` 14px 圆，内显 senseTools icon；`is-current` = 实心橙+辉光，`is-queued` = 白底橙边 + `approval-flash` 动画 | 当前项无 click（已展示）；queue 项 click → `agents.resummonApproval(chatId, approvalId)`；倒计时归零 → CSS opacity 渐隐消失 |

**闪烁频率**：`approval-flash` CSS keyframes，`animation-duration = var(--flash-period)`，`flash-period = max(0.2, min(5, remainingSec * 0.1))` 秒。剩余时间越少闪得越快，视觉紧迫感。`waitTime=0`（不超时）→ 周期封顶 5s（低频慢闪）。

**与气泡的协调**：审批在 `approval` 时气泡展示（z-index 400 不被遮挡）；用户点 ✕ 移入队列后气泡卸载，icon 出现并闪烁；点击闪烁 icon → `resummonApproval` 把该项移到 `approval` 重新唤起气泡。Accept/Reject → `dismissApproval` 清空 + 自动从 queue head pop 下一个进 `approval`（多审批连续推进）。

侧气泡（`.speech.side`）独立 `AnimatePresence`，仅在 `showWorkSide`（hasContent && thinking 非空 && 无 approval）时显，motion `x:"-100%" y:"-100%"`（顶部齐平主气泡），同尺寸（max 180×140）+ 复用 is-thinking 浅灰虚线 + 斜体灰字（与主气泡 content 白底实线区分），定位 `sideBubbleStyle`（`top` 同主气泡，`left=pet.x-60` 向左展开）。

## Busy indicator

> 源码派生 [useStreamBubble.ts](../../../web/src/features/pets/useStreamBubble.ts) `isBusy` ｜ 渲染 [PetSprite.vue](../../../web/src/features/pets/PetSprite.vue) 模板 + `.busy-indicator` 样式

**与气泡显示解耦**：busy-indicator 显隐走 `isBusy`（独立 computed），不再绑 `hasStream`。hasStream 复合条件（content/thinking 非空 + working/retain/hover）负责气泡显示生命周期；isBusy 仅表达"还在做事"。

**派生语义（C 方案）**：

```ts
isBusy = !isGhost && (pet.isWorking || stream.runningTools.length > 0 || stream.approval != null);
```

- 不含 hover（hover 仅保持气泡显示）
- 不含 `retainUntil`（done 后保留期不视为"还在做事"）
- 含 running tools（用户视角"工具在跑"）
- 含 approval（待审批也属"阻塞式忙"）

**视觉**：自定义 SVG 双圆环 loader，16×16，`viewBox="0 0 24 24"`，face 右上角偏移（`right:0; top:26px`）。外圈 `.busy-ring` 虚线圆（`stroke-dasharray: 3 3`，`fade(@ink, 28%)`），内圈 `.busy-arc` 实心弧流光（`stroke-dasharray: 18 18`，主题橙 `#f6b73c`，`busy-arc` keyframes 推动 `stroke-dashoffset 0 → -36`）。整体 1.4s 旋转（`busy-spin` 0→360deg），`drop-shadow(0 1px 1px rgba(0,0,0,0.18))` 抬离背景。

> 注：项目历史决策使用主题橙 #f6b73c（[web-element-theme-palette](../../element-theme-palette.md)），与 PetIcons approval 列 `is-current` 同色；ring 用半透明 ink 而非彩色，保证 loader 不喧宾夺主但仍显眼。

> agent 接入引入的 status-row/meta-row/speech 变化见 [agent-integration.md](./agent-integration.md) 渲染分层注记。
