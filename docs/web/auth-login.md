# 登录窗（auth / ServerLoginDialog）

> 状态：设计规格（Doc-First，先于实现落稿）｜ 源码 `web/src/features/auth/` ｜ 相关 [electron.md](./electron.md)（原生 login 窗）、[../standards/ui-visual-and-interaction.md](../standards/ui-visual-and-interaction.md)（全直角 / 字重 400 / 深空电光 token）

## 定位

后端服务对接入口，两个共用同一组件的使用形态：

| 形态 | 挂载点 | `native` | 关闭方式 |
|---|---|---|---|
| Electron 原生登录窗 | `LoginSurface.vue`（`?surface=login`，WindowFrame 外壳 `ACCESS CONTROL // NYXUS_OS`） | `true` | WindowFrame 三键 |
| 应用内浮动弹窗 | `NyxusCore.vue` 工具环「连接」按钮（desktop 透明窗内，`data-desktop-hit` 命中） | 缺省（浮动：offset 拖拽 + ESC + 退出符） | ESC / 退出符 |

状态与提交逻辑走 `stores/auth.ts`（`login` / `savedPasswordPlain` / `logout` 等），本模块只负责视图与动效；本地 loopback 直连不鉴权（只设地址），远端需用户名/密码。

## 2026-09 重置：设计规格

推翻旧版"拟态玻璃浮动窗"，全新视觉语言为「**暗房 + 灯**」：登录窗是黑暗中的一扇赛博风格监视窗（与桌面 CyberWindow 同词汇），输入即点亮，密文靠灯光显形。

### 窗口壳（v5——与工作台 CyberWindow 完全一致）

废弃 v4 的 SettingsDialog 式壳，登录窗（浮动形态）直接对齐 `desktop/CyberWindow.vue` 的窗口 chrome：

- **标题栏**（38px，`--cyber-title-bg` + accent 渐变 + 底部 1px 描边）：`AUTH` channel 徽记（accent 描边小方块）+ 标题 + signal `01 ▰▰▰` + 右侧**三键齐全**（`_` / `□` / `×`，38px 宽、border-left 分隔、hover accent、close hover 红，与 CyberWindow 同语法）。
- **三键行为**（弹窗自包含，不依赖工作台窗口管理）：最小化 = **卷帘收缩**（窗体缩为只剩标题栏，点标题栏或再按 `_` 恢复）；最大化 = 铺满视口（再按还原）；关闭 = `close()`。
- **角括号**：四角 corner 括号标记（CyberWindow 同款装饰层；扫描线装饰已按用户要求移除）。
- `--cyber-line` 派生描边 + `--panel` 底；出错时面板描边静态转红 + 错误卡片。
- **native 形态全部对齐**：`WindowFrame`（所有 Electron 原生窗公共外壳）标题栏同步 CyberWindow 视觉——channel 徽记（可选 `channel` prop，登录窗传 `AUTH`）+ signal `01 ▰▰▰` + 文字三键（样式同 CyberWindow，行为仍走 `window:control` IPC）；登录窗 native 面不再渲染内部标题栏（WindowFrame 承担）。

### v5 bug 修复记录

| 问题 | 根因 | 修复 |
|-----|-----|-----|
| 密码永远明文 | `LampPasswordField` 原文层常态无隐藏（仅 `is-lit` 时有 clip-path） | 原文层默认 `opacity: 0`，`is-lit` 才显形 |
| 浅色模式光色不变 | `:global(html:not(.dark))` 组合选择器在 scoped less 中不可靠 | 弃用 `:global`：`useThemeStore` 驱动根节点 `is-light` class + LampPasswordField `theme` prop，纯 scoped 规则切换黑光 |
| 光束太短未溢出 | 光束渐变相对视口宽度衰减，窗口左缘附近已透明 + clip 左端外扩不足 | **v7 独立光束盒**：`.light-cone` 不再铺满视口，改为长度 = 面板宽 ×1.5（JS 每帧注入 `--beam-len`）、右端锚 icon 灯头口、不透明段拉过面板左缘（`72% → transparent 98%`，窗口内全程实亮不虚化、大胆直接超出去），可见光真正贯穿窗口并大幅溢出左缘 |
| 输入框文字被光吞掉 + 黑光在输入框处被截断（"挤压"感） | 不透明光柱（z 3001）压住整个 `.rift-body`（z 5），显字层被吞 | **v9 分层修正**：`.rift-body` 不设 z-index（避免 stacking context 困住内部层级）——光柱压住 body 常规内容（光不被输入框/井底遮挡），仅显字层、caret、密码 label（z 3003）与标题栏（z 3004）浮出光上；深色显形底恢复常态 surface（v8 误改光色已回退），浅色显形底 = ink（与黑光融合）+ 白字 |
| 开灯后标题/字段 label/普通输入框文字不可读；暖光柱上叠一块深色显字底带（像被密码井上下边缘截断的"第二盏灯"） | 标题与 `.field-label` 无显式 `color`（Teleport 到 body 后继承浏览器默认黑，深色模式黑字压深底）；显字层自带 94% `--surface` 不透明底块浮在光柱上（z 3003），又被井 `overflow:hidden` 硬裁出矩形边界 | **v10 对称显字 + 可读内容浮光上**：① 面板根 `.rift-panel` 显式 `var(--ink)`（Teleport 到 body 后无 body 级继承来源，标题/label/记住密码/错误卡片/信息面板曾继承浏览器默认黑）；② 显字层**去底块**——光柱本体即显字底，深色模式显字 = 暖光柱上反深字（`--bg`），浅色模式 = 黑光上反白字，深浅逻辑完全对称（暗底浅光深字 ↔ 亮底黑光浅字）；③ 根节点 `is-lit` 驱动：开灯时 field-label / 普通输入框 / 记住密码行 / 按钮 / 错误卡片整体提到光柱之上（z 3003，同显字层待遇），光柱只作背景光层；④ 深色模式输入框框体描边提为 `--border-strong` |
| 灯光整体上下平移抖动（发射点跟着动，不符合"手持灯头、光尾摆动"常识）；光束粗细/长度硬编码，不随控件缩放 | bob/tremble 加在 `srcX/srcY` 上会平移整个光束盒（发射点随动）；远端半高 ±34px、近端 ±4px、长度 1.5×面板宽均为静态硬编码，最大化形态失配 | **v11 发射点锚定 + 几何实测派生**：发射点（灯头口）完全锚定，唯一运动自由度为绕灯头的角度摆动（±1.5° 慢摆 ≈31s + 高频角度微抖，只有尾部大幅动、发射点微动，手电 icon 同角旋转 + 同相 ±2px 浮动刚体一致）；`--beam-half-near/far/len` 从按钮/输入井 rect 实测派生（近端半高 = 按钮高×0.1 ≈ 灯头口、远端半高 = 井高×0.8、长度 = 灯头至面板左缘 + 0.75×井宽），浮动/最大化两形态自适应；显字带半高同步消费光束变量 |
| 密码值被复制进普通 DOM 文本层、绑定到 `value` 属性，且真实 input 始终为 `text` | 为实现光束局部显字，组件用透明 `type="text"` input，再额外渲染圆点层和原文层；CSS 隐藏不等于密码语义 | **v12 原生密码语义**：删除圆点层和原文层，仅保留一个 input；使用 `v-model` 更新 input property，不声明密码 `value` 属性；默认 `type="password"`，只有开灯时切为 `type="text"`，关灯立即恢复；关闭窗口或切至本地免鉴权地址时清空组件内存中的密码 |

### 面板级手电光束（rift-light，登顶面板坐标系的"墙"）

**登录面板 = 一堵墙**。灯光是面板级覆盖层（`rift-light`），不限定在输入框内。灯钮开关状态提升到 ServerLoginDialog，rAF 驱动光源坐标与抖动变量；同一状态直接控制密码 input 的 `type`。

**单一模式**：光源即密码框右侧的**手电筒开关按钮**（手电侧视 icon，灯头朝左；开灯时灯头口显出短光线）——开灯就是"按下手电开关"，同时把密码 input 从 `password` 切为 `text`。光束从 **icon 灯头口**发出，起点贴近窗口右缘，**细长锥形**（右细左粗，张角收窄）；光束为**独立光束盒**，向左贯穿整个窗口并**溢出窗口左缘外**。动态（v11 运动学）：**发射点（灯头口）完全锚定**，唯一运动自由度为**绕灯头的角度摆动**——只有尾部大幅摆动、发射点微动（±1.5° 慢摆 ≈31s 叠加高频角度微抖，reduced-motion 静止），无整体平移；**手电 icon 与光束刚体一致**——同角度旋转（零偏差）+ 同相 ±2px 浮动（16px 小图标上纯旋转不可见，可见晃动感由浮动提供），灯头口始终贴住光束发射点。几何（v11 实测派生）：近端半高 = 按钮高×0.1（≈灯头口）、远端半高 = 井高×0.8、长度 = 灯头至面板左缘 + 0.75×井宽，浮动/最大化两形态自适应。

- **配色**（token + `color-mix` 派生，v10 对称显字：暗底浅光深字 ↔ 亮底黑光浅字）：
  - 深色模式：**暖黄实体光柱**（白偏黄，`--lamp-warm` 派生，用户指定）——光束高不透明、压住背景色（`mix-blend-mode: normal`），远端才渐隐；亮灯后的原生 input 使用深色文字（`--bg`）。
  - 浅色模式：**黑光**——光束本体近黑（ink 派生）、同样高不透明压住背景，光斑内文字反白；同样无底块。深浅色几何/动态完全一致，只换光色与显字反色（`is-light` class 驱动）。
- **可读内容浮光上**（v10）：开灯时光柱只作背景光层，所有会阅读的内容（字段 label、普通输入框文字、记住密码行、按钮、错误卡片、密码 input、caret、标题栏）整体浮出光柱之上（z 3003/3004），任意区域可读。

### 输入框 / 按钮 / 开关

- 输入框：直角、`--surface` 底、1px `--border`（深色模式提为 `--border-strong`，避免深底上框体过淡）；聚焦 = "点亮"：border 变 `--accent` + 内侧丝状辉光。密码字段只有一个原生 input，以 `v-model` 更新 property，不声明密码 `value` 属性；灯灭为 `password`、灯亮为 `text`，不渲染密码文本副本。
- 按钮：全直角、字重 400。主按钮 `--accent` 实底（深色配 `--bg` 深字 / 浅色白字）；次按钮 1px 描边透明底，hover 亮 accent；危险（登出）红色系经 `color-mix` 派生。hover 统一"光扫"高光从左到右掠过（reduced-motion 关闭）。
- 记住密码：直角滑块，开 = `--accent` 底亮灯方块。
- 中文文本字号 ≥12px；600 仅用于标题。

## 状态机（保留不变）

`地址 → (非 loopback: 用户名/密码/记住密码) → 提交`；成功后进已连接态（远端：用户信息 + 登出；本地：状态 + 断开连接）；错误卡片保留 kind 图标、backendMessage、HTTP status、原始错误展开。提交期 busy 态。

## 验收清单（视觉项交用户截图确认）

- [ ] 浮动窗与工作台 CyberWindow 一致：AUTH channel 徽记 + signal + 文字三键 + 角括号 + `--cyber-line` 描边
- [ ] 三键：最小化卷帘收缩（点标题栏恢复）、最大化铺满/还原、关闭
- [ ] native 窗：WindowFrame 标题栏同视觉（AUTH 徽记 + signal + 文字三键），登录内容无重复标题栏
- [ ] 密码常态由原生 `type="password"` 遮蔽，开灯切换 `type="text"`；模板无密码 `value` 属性，DOM 中无额外原文文本层
- [ ] 手电光束：光源在手电 icon 灯头口，细长锥形右细左粗、贯穿窗口并溢出左缘；尾部 ±1.5° 角度摆动 + 微抖、发射点微动（无大幅整体平移）；手电 icon 与光束刚体一致（同角旋转 + 同相浮动）；粗细/长度随输入井与按钮尺寸实测派生
- [ ] 深色暖黄光 / 浅色黑光白字，两态几何动态一致
- [ ] 出错：面板描边转红 + 错误卡片
- [ ] 全直角、正文 400、中文 ≥12px、无新增硬编码色
- [ ] native 与浮动两种形态、ESC、记住密码、已连接态（登出/断开）、错误展开均可用
