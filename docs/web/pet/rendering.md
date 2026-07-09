# 渲染分层（PetSprite.vue）

> 源码 [PetSprite.vue](../../../web/src/features/pets/PetSprite.vue) ｜ 上级 [README.md](./README.md) ｜ 动画 variant 见 [motion.md](./motion.md) ｜ 样式见 [style.md](./style.md)

```text
div.pet-wrap                                                            // 根容器（无 z-index/position → 不创建 stacking context，气泡 z-index 跨 pet 比较）
  AnimatePresence > Motion.speech[:style=speechStyle]                   // 主气泡（3 tier v-if 互斥，key 切换；锚点=pet 顶部中心下移 BUBBLE_OFFSET_Y 贴 status-row 上方 16px；motion x:"-50%" y:"-100%" 居中+上移自身高度）
    [stream.approval]  ApprovalCard(:chat-id=pet.chatId)                //   ① 审批卡片（CP5；优先级最高；倒计时 waitTime/createdAt，submit 后 dismissApproval 立即关闭）
    [showWorkMain]     .work-bubble .work-text                          //   ② 工作主气泡：thinking-only 全空间显 thinking；有 content 显 content（md 渲染）+ hover 保持
    [pet.speech || $slots.dialog] #dialog slot                          //   ③ 装饰气泡/默认 slot（agent 接入后基本不达）
  AnimatePresence > Motion.speech.side[:style=sideBubbleStyle]          // 左侧 thinking 副气泡（CP2；同尺寸浅色，顶部齐平主气泡；仅 hasContent && thinking 非空时显）
  div.pet[:class=classes :style=translate3d(x,y)+zIndex(petBodyZIndex) + --pet-direction + --pet-scale + --tribe-hue]  // RAF 位置容器（无交互）
    span.shadow (CSS 呼吸，随 --pet-scale 缩)
    span.dir[CSS scaleX(--pet-direction)]                               // 朝向瞬切
      Motion.sprite[:animate=spriteMotion(action)]                      // grid-template-columns:100% 修复展开抖动
        div.status-row: span.stat.emotion .fill + ContextBar            // 状态条（头顶，固定尺寸，不触发交互）：emotion 条 + contextUsage bar（取代原 fatigue bar）
        span.head-row[role=button + 长按拖拽/短按抚摸 + keydown + cursor + touch-action + transform:scale(--pet-scale)]  // 命中区=身体（face+hands）；ghost 时 `.pet` pointer-events:none、head-row 收缩到 face emoji ~26px（命中区=emoji，消队列重叠遮挡）
          Motion.hand.left[:animate=handMotion(action,'left')]          hands[mood].left
          Motion.face[:animate=faceMotion(mood)]                         face[mood]
          Motion.hand.right[:animate=handMotion(action,'right')]        hands[mood].right
        div.meta-row: span.name (per-char 彩虹流动) + PetToolbar         // 工具栏组件（CP2/CP6）：主[历史/中止/销毁] / 子[历史/中止]
        span.zzz (v-if action=sleep)                                    // 休息浮字
```

位置、朝向、主体动作、手部动作、表情滤镜各在独立层，transform 不冲突。`.sprite` 用 `grid-template-columns:100%` 使各 row 独立居中，工具栏展开不再偏移 face（修复抖动）。`--pet-scale`（主 1 / 子 0.75）仅作用于 `.head-row` + `.shadow`——子 pet 体型缩小但 name/PetToolbar/status-row 尺寸不变。`.status-row` 移至 head-row 之上（头顶），固定尺寸不随 scale 缩。

**命中区**：`.head-row`（身体=face+hands）触发拖拽/点击/keydown（长按拖拽 + 短按抚摸）；**hover 检测扩到整个 `.pet`**（`pointerenter/leave` 绑 `.pet`，`pointerenter/leave` 不冒泡、进子元素不触发父 leave → 覆盖 head/toolbar/name/status-row 任意位置）→ 悬浮即冻结移动，toolbar 可点中。`.pet` 的 pointer 事件仅用于 hover；拖拽/点击/keydown、抚摸/抓取光标、`touch-action:none`、键盘焦点（role=button+tabindex）均在 head-row。**ghost 特例**：`.pet` `pointer-events:none`（72×96 框不捕获，消队列内 `.pet` 重叠遮挡；原重叠致 hover/click 命中错误 ghost、leader 拖不动），head-row `min-width/height:0` 收缩到 `.face` emoji ~26px 且 `pointer-events:auto` 承接 hover/click/drag；`@pointerenter/leave` 绑 head-row guard `isGhost`（非 ghost 仍由 `.pet` 大区 hover）。

**交互（长按拖拽 + 短按抚摸）**：`pointerdown` 启 300ms 定时器（`LONG_PRESS_MS`）+ 记录落点；**长按超时或移动超阈值（`DRAG_THRESHOLD_PX=5`）**任一触发 → `startDrag`（`setPointerCapture` + 进入 `dragging`）；**短按（<300ms 且未超阈值）松开** → 取消定时器，不拖拽，让 `click` 触发 `clickPet` 抚摸。拖拽结束的 `pointerup` 紧随触发 `click` → `suppressClick` 标志抑制，避免拖拽完又抚摸。长按等待中离开 `.pet`（`pointerleave`）取消定时器。`onPointerMove` 在等待中检阈值，进入拖拽后透传 `drag`。（实现下沉 [usePetDrag.ts](../../../web/src/features/pets/usePetDrag.ts)：常量 `LONG_PRESS_MS`/`DRAG_THRESHOLD_PX` + 私有态 + handler + `petHover` + `onBeforeUnmount` 清 `longPressTimer` 集中；行为不变。）

**z-index（inline 动态，气泡与身体分离）**：`.pet-wrap` 无 z-index/position → 不创建 stacking context，故 `.speech` 与 `.pet` 的 z-index 在 stage 层级跨 pet 直接比较。z-index 由 inline `:style` 提供（CSS 仅 fallback）；原 `.is-master`/`.is-chatting`/`.is-dragging` 的 z-index 规则已移除。**hover 提层级**：`petBodyZIndex` 加 hovered 分支（z=15，低于 drag 20、高于普通 pet）-> 被悬停 pet（ghost 队列残余对角重叠时尤需）置顶，不被相邻遮挡。

| 层 | 公式 | 取值 | 效果 |
|----|------|------|------|
| 身体 `petBodyZIndex` | `dragging→20`；否则 `(hasSpeech?10:0)+(isMaster?2:1)` | 拖拽20；有气泡主12/子11；无气泡主2/子1 | 默认主盖子；**子有气泡主无时子(11)>主(2)→子盖主**；都有时主(12)>子(11) |
| 气泡 `speechZIndex` | `dragging→120`；否则 `100+(isMaster?2:1)` | 拖拽120；主气泡102/子101 | 气泡整体高于身体（100+>20）；气泡间主>子 |

**name 部落色**：同部落（主+子）name 同底色 `hsl(tribe-hue)`；子 name 文字=部落深色，**主 name 文字=动态彩虹流动**——name 拆为 per-char `<span>`，每字符色相按序递增（`--char-i` 计算 `hsl(base + i*step)`），`animation-delay` 按字符序错相 → 整体从左往右波浪流动。

## 对话框 slot 与 3 tier 气泡

```vue
<AnimatePresence>
  <MotionDiv v-if="stream?.approval" key="approval" class="speech approval-bubble" ...>
    <ApprovalCard :approval="stream!.approval!" :chat-id="pet.chatId" />
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

主气泡 3 tier 由 `AnimatePresence` 互斥切换（key=`approval`|`work-main`|`speech`）：① 审批存在时优先显 ApprovalCard（CP5）；② 工作中显工作主气泡（thinking-only 或 content）；③ 默认装饰气泡/`#dialog` slot（agent 接入后基本不达，预留扩展口）。气泡为 `.pet-wrap` 内 `.pet` 的**兄弟**（脱离 `.pet` 的 transform stacking context），独立 z-index（整体高于身体）。锚点 = pet 顶部中心下移 `BUBBLE_OFFSET_Y`（贴 status-row 上方 16px，非容器顶），`left`/`top` 由 inline `speechStyle` 提供，motion `x:"-50%" y:"-100%"` 居中 + 上移自身高度。done 后 content/thinking 保留 20s（`stream.retainUntil`，新消息/abort 清除）；pet 身体或工作气泡 hover 期间保持显示（`petHover || bubbleHover`，即使 retainUntil 过期）。（显隐/保留/滚动逻辑下沉 [useStreamBubble.ts](../../../web/src/features/pets/useStreamBubble.ts)：`nowTick` retain 定时器 + auto-scroll watcher + `onBeforeUnmount` 清 `retainTimer` 集中，收 `petHover` ref 算 `isHovered`；模板分层不变。）

侧气泡（`.speech.side`）独立 `AnimatePresence`，仅在 `showWorkSide`（hasContent && thinking 非空 && 无 approval）时显，motion `x:"-100%" y:"-100%"`（顶部齐平主气泡），同尺寸（max 180×140）+ 复用 is-thinking 浅灰虚线 + 斜体灰字（与主气泡 content 白底实线区分），定位 `sideBubbleStyle`（`top` 同主气泡，`left=pet.x-60` 向左展开）。

> agent 接入引入的 status-row/meta-row/speech 变化见 [agent-integration.md](./agent-integration.md) 渲染分层注记。
