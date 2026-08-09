# Nexus 节点树 / 钢琴键条 / 删除交互优化

## 目标
优化三处交互：节点树（MessageBranchTree）、钢琴键条（NexusPianoStrip=历史列表）、钢琴删除流程。删除流程为本次重点（用户给出 4 点 + 1 bug + 动画），节点树与钢琴键条各取 1 项高价值轻量优化。

## 范围与优先级
- **A 删除流程**（必做）：bug 修复 + ghost icon + 垃圾桶位置 + 倒垃圾动画 + 整体动画特效
- **B 节点树**（轻量）：B1 回到底部 + 流式新内容回弹提示
- **C 钢琴键条**（轻量）：C2 tooltip/hover 时序对齐
- B2/C1/C3/C4 列为可选，本次不做（控制范围）

---

## A. 删除流程优化

文件：`web/src/features/pets/nyxus/components/NexusPianoStrip.vue`、`web/src/features/agent/chat/AgentDialog.vue`

### A1. 修 hover 删除按键关闭钢琴弹窗 bug
**成因**：`schedulePianoClose` 延迟仅 160ms（AgentDialog L114）；`key-clear-icon` 定位 `top:WHITE_H-3=109px` + 18px 高 = 127px，溢出 popout 盒（height 153，piano-keyboard 占 30..146）底部，且 icon 紧贴琴轨底边。hover icon 底缘 / 从键移到 icon 的瞬时路径易触发 popout `pointerleave` -> 160ms 后 `pianoOpen=false` 关闭 popout，拖拽中断。

**修复**：删除交互期间锁定 popout 不关闭。
- NexusPianoStrip 新增 computed `interacting = hoveredKeyView?.deletable || !!clearDrag || dumping`；`watch(interacting)` 时 `emit('interacting-change', v)`。
- emit 类型扩展：`interacting-change: [boolean]`。
- AgentDialog：`<NexusPianoStrip @interacting-change="onPianoInteracting" />`；新增 `pianoPinned = ref(false)`；`onPianoInteracting(v)`：`v` true -> `showPiano()` + `pianoPinned.value=true`；`v` false -> `pianoPinned.value=false` + `schedulePianoClose()`。
- `schedulePianoClose` 开头加 `if (pianoPinned.value) return` 守卫。

**为什么不在 CSS 层修**：扩大 popout height / 下移 icon 只补几何缝隙，不覆盖拖拽全程（pointer 可能短暂离 popout hit 区）。interacting 标志覆盖 hover-icon + 拖拽 + dumping 全程，鲁棒。

### A2. ghost icon 改为会话消息 icon
**当前**：`clear-ghost` 内 `sticker-svg`（便利贴，L432-435）。
**改为**：消息气泡 SVG——圆角矩形气泡 + 左下尾角 + 内部 2-3 条短横线（代表消息文本），主题橙 `#f6b73c` 描边/填充，与节点树消息节点视觉同源。
- 替换 `.sticker-svg.ghost-sticker` 的两 path 为气泡图形；`.clear-ghost` 样式保留 fixed + translate(-50%,-50%) + drop-shadow。
- 加轻微动画：拖拽中 ghost 微旋转 ±8deg 或呼吸缩放，增强"拖拽中"反馈（A5 一部分）。

### A3. 垃圾桶移到弹窗右侧专用区
**当前**：`trash-dropzone` 在 piano-keyboard 右上角（`right:0; top:0`，键条内，挡键 + 离左键远）。
**改为**：垃圾桶在键条右侧专用区，不挡键条主体。

**布局方案**（实现时二选一，倾向方案 1）：
1. **NexusPianoStrip 内 flex 布局**：`.piano-keyboard` 改 `display:flex; flex-direction:row`；左 `.piano-viewport`（flex:1），右 `.trash-slot`（拖拽时 `width:52px`，非拖拽 `width:0` + transition）。trash-dropzone 移入 trash-slot，取消 absolute。
2. **popout 内右侧浮动**：trash-dropzone 仍 absolute 但定位到 popout 右边缘内侧，键条右 padding 让出空间。

> 注意：piano-popout `right:calc(100%+12px)` 向左展开，右侧外是 piano-tool 按钮。trash 不可溢出 popout 右边缘叠到按钮上。方案 1 把 trash 限制在 popout 内右侧最稳。
- trash-callout 文案位置随之调整（icon 下方或左侧）。

### A4. 倒垃圾动画优化
**当前**（L748-759）：盖子翻开 -60deg + 桶身倾斜 -22deg + 内容下移淡出，650ms setTimeout 后 emit delete。问题：动画平铺无层次、被删键无反馈、ghost 无归位。
**优化**：
- **ghost 归位**：`onClearUp` 命中时，ghost 从释放点动画飞向 trash 中心并缩小消失（CSS transition on transform/left/top，~250ms），再进 dumping。
- **被删键反馈**：命中后被删键加 `.is-deleting` class（收缩 + 淡出 + 轻微下沉），与 dumping 同步。
- **trash 增强**：盖子翻开角度加大并加弹性（cubic-bezier overshoot）；桶身先下沉再倾斜晃动；内容线条粒子化散落（多条 line 各自 translateY+rotate+opacity 随机延迟）。
- **回弹**：dumping 结束 trash 回正（盖子闭合、桶身复位）带 spring 过渡。
- 时长保持 650ms 或调整为 700ms（ghost 250 + dump 450 轻微重叠）。

### A5. 整体动画特效
- **hover 删除 icon**：`.key-clear-icon` 加常驻轻脉冲发光（box-shadow 呼吸），hover 加强（已有 scale，加 glow）。
- **trash 入场**：拖拽开始 trash-dropzone 用 motion spring 入场（scale 0.6->1 + opacity），而非瞬间 v-if 显现。复用 motion-v `MotionDiv` + `AnimatePresence`。
- **命中预览**：`is-over` 时 trash 缩放 1.08 + 高亮辉光强化 + callout 抖动一下。
- **ghost 拖尾**（轻量）：ghost 拖拽中 `filter: drop-shadow` + 微旋转（A2 已含）。
- **删除完成**：被删键淡出后，剩余键无过渡（保持原位，键按 chatId 原地复用，符合 rendering.md §69「不重挂载」）。

---

## B. 节点树（MessageBranchTree.vue）

### B1. 回到底部 + 流式新内容回弹提示
**现状**：`userPanned` 后停止末尾跟随；流式新节点到达无提示、无回底部入口（抽屉有 scroll-actions，树无）。`reset` 已存在（恢复 fit + 跟随）。
**方案**：
- 新增浮标按钮 `v-if="userPanned && hasNewTail"`，定位画布右下角（`.nyxus-branch-top` 警戒条内侧），文案「↓ 回到最新」或仅箭头 icon。
- `hasNewTail` = userPanned 期间又有新节点追加到末尾（watch graph 末节点 id 变化置 true；reset 或点击浮标置 false）。
- 点击浮标 -> `reset()`（已恢复 fit + 末尾跟随）。
- 入场动画：浮标 spring 滑入 + 脉冲提示。

> 实现时确认 `userPanned`/`reset`/末节点 id 的具体变量名（分析指向 L776-781 区域 useTreeCanvas）。

### B2（可选，本次不做）
ESC 关 CRT 需按两次（先 detail 后 CRT，L660-667）。保持当前层级语义，仅加过渡反馈。留后续。

---

## C. 钢琴键条（NexusPianoStrip.vue）

### C2. tooltip / hover 时序对齐
**现状**：`ElTooltip :show-after="260"`（L364）vs `onKeyLeave` 的 `scheduleHoverLeave` 150ms（L285）。快速划过键时 tooltip 在 260ms 后才显现，但 hoverLeave 150ms 已清 hoveredIdx，若 pointer 已离开但 tooltip 定时器未取消 -> tooltip 残留或错位。
**方案**：对齐为同一阈值。`show-after` 改 150ms 与 hoverLeave 一致；或 hoverLeave 改 260ms。倾向前者（更快响应 tooltip，hoverLeave 同步缩短）。同时确认 ElTooltip 在 hoverLeave 时是否需手动 `v-model:visible` 关闭（快速划过残留场景）。

### C1/C3/C4（可选，本次不做）
- C1 倒计时 `ceil` 250ms 跳变：本质整数秒向上取整，可接受，加 CSS transition 缓和。
- C3 无数据键发声：设计如此（rendering.md §67「所有键点击发声」），保留。
- C4 fit/overflow 键宽突变：absolute 定位 width transition 易抖动，风险高，留后续。

---

## 文档同步（Doc-First，先改文档再改码）
- `docs/web/pet/rendering.md` §65-69（钢琴键条 / NexusPianoStrip）：
  - 更新删除流程描述：ghost 改消息 icon、垃圾桶移右侧专用区、interacting 锁定 popout、倒垃圾动画增强、整体动画。
  - 更新 hover/tooltip 时序（C2）。
- `docs/web/pet/rendering.md` §44-49（节点树）：
  - 补「回到底部」浮标 + 流式新内容回弹提示（B1）。
- 不涉及配置/管家文档。

## 验证（交用户）
按 memory「前端验证交给用户」：不跑 vue-tsc/vite build/vitest，改完码即止。用户自验：
- hover 删除 icon / 拖拽中 / dumping 期间钢琴 popout 不再误关。
- ghost 显消息气泡 icon + 拖拽微动画。
- 垃圾桶在键条右侧专用区、不挡键。
- 倒垃圾动画：ghost 飞入 + 键淡出 + 桶增强 + 回弹。
- 节点树 userPanned 后有「回到底部」浮标。
- 钢琴 tooltip 快速划过无残留。

## 执行顺序
1. 改 `docs/web/pet/rendering.md`（§65-69 + §44-49）。
2. A1 bug 修复（NexusPianoStrip emit + AgentDialog pianoPinned）。
3. A2 ghost icon + A3 垃圾桶位置 + A4 倒垃圾动画 + A5 动画特效（NexusPianoStrip 模板/样式 + AgentDialog 若需）。
4. B1 节点树回到底部浮标（MessageBranchTree）。
5. C2 钢琴 tooltip 时序（NexusPianoStrip）。
6. 检查点：TSC 排除预存错误基线（memory tsc-baseline），lint。
