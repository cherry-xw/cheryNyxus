# 登录窗（auth / ServerLoginDialog）

> 源码 `apps/web/src/features/auth/` ｜ 相关 [设计语言规范](../standards/frontend/design-language.md)；登录先行改造见[实施计划](../plan/login-first-capabilities/README.md)。

## 定位

当前后端服务对接入口是 `NyxusCore.vue` 工具环的「连接」按钮，打开应用内可拖动的 `ServerLoginDialog`。登录前置及服务选择尚按[计划](../plan/login-first-capabilities/README.md)实施。

状态与提交逻辑走 `stores/auth.ts`（`login` / `savedPasswordPlain` / `logout` 等），本模块只负责视图与动效；本地 loopback 直连不鉴权（只设地址），远端需用户名/密码。

## 设计规格

登录窗是黑暗中的一扇赛博风格监视窗（与桌面 CyberWindow 同词汇），输入即点亮，密文靠灯光显形。

### 窗口壳

登录窗（浮动形态）对齐 `desktop/CyberWindow.vue` 的窗口 chrome：

- **标题栏**（38px，`--cyber-title-bg` + accent 渐变 + 底部 1px 描边）：`AUTH` channel 徽记（accent 描边小方块）+ 标题 + signal `01 ▰▰▰` + 右侧**三键齐全**（`_` / `□` / `×`，38px 宽、border-left 分隔、hover accent、close hover 红，与 CyberWindow 同语法）。
- **三键行为**（弹窗自包含，不依赖工作台窗口管理）：最小化 = **卷帘收缩**（窗体缩为只剩标题栏，点标题栏或再按 `_` 恢复）；最大化 = 铺满视口（再按还原）；关闭 = `close()`。
- **角括号**：四角 corner 括号标记（CyberWindow 同款装饰层；无扫描线装饰）。
- `--cyber-line` 派生描边 + `--panel` 底；出错时面板描边静态转红 + 错误卡片。

### 面板级手电光束（rift-light，登顶面板坐标系的"墙"）

**登录面板 = 一堵墙**。灯光是面板级覆盖层（`rift-light`），不限定在输入框内。灯钮开关状态提升到 ServerLoginDialog，rAF 驱动光源坐标与抖动变量；同一状态直接控制密码 input 的 `type`。

- **单一模式**：光源即密码框右侧的**手电筒开关按钮**（手电侧视 icon，灯头朝左；开灯时灯头口显出短光线）——开灯就是"按下手电开关"，同时把密码 input 从 `password` 切为 `text`。光束从 **icon 灯头口**发出，起点贴近窗口右缘，**细长锥形**（右细左粗，张角收窄）；光束为**独立光束盒**，向左贯穿整个窗口并**溢出窗口左缘外**。动态：**发射点（灯头口）完全锚定**，唯一运动自由度为**绕灯头的角度摆动**——只有尾部大幅摆动、发射点微动（±1.5° 慢摆 ≈31s 叠加高频角度微抖，reduced-motion 静止），无整体平移；**手电 icon 与光束刚体一致**——同角度旋转（零偏差）+ 同相 ±2px 浮动（16px 小图标上纯旋转不可见，可见晃动感由浮动提供），灯头口始终贴住光束发射点。几何：近端半高 = 按钮高×0.1（≈灯头口）、远端半高 = 井高×0.8、长度 = 灯头至面板左缘 + 0.75×井宽，从按钮/输入井 rect 实测派生，浮动/最大化两形态自适应。

- **配色**（token + `color-mix` 派生，对称显字：暗底浅光深字 ↔ 亮底黑光浅字）：
  - 深色模式：**暖黄实体光柱**（白偏黄，`--lamp-warm` 派生，用户指定）——光束高不透明、压住背景色（`mix-blend-mode: normal`），远端才渐隐；亮灯后的原生 input 使用深色文字（`--bg`）。
  - 浅色模式：**黑光**——光束本体近黑（ink 派生）、同样高不透明压住背景，光斑内文字反白；同样无底块。深浅色几何/动态完全一致，只换光色与显字反色（`is-light` class 驱动）。
- **可读内容浮光上**：开灯时光柱只作背景光层，所有会阅读的内容（字段 label、普通输入框文字、记住密码行、按钮、错误卡片、密码 input、caret、标题栏）整体浮出光柱之上（z 3003/3004），任意区域可读。

### 输入框 / 按钮 / 开关

- 输入框：直角、`--surface` 底、1px `--border`（深色模式提为 `--border-strong`，避免深底上框体过淡）；聚焦 = "点亮"：border 变 `--accent` + 内侧丝状辉光。密码字段只有一个原生 input，以 `v-model` 更新 property，不声明密码 `value` 属性；灯灭为 `password`、灯亮为 `text`，不渲染密码文本副本。
- 按钮：全直角、字重 400。主按钮 `--accent` 实底（深色配 `--bg` 深字 / 浅色白字）；次按钮 1px 描边透明底，hover 亮 accent；危险（登出）红色系经 `color-mix` 派生。hover 统一"光扫"高光从左到右掠过（reduced-motion 关闭）。
- 记住密码：直角滑块，开 = `--accent` 底亮灯方块。
- 中文文本字号 ≥12px；600 仅用于标题。

## 状态机

`地址 → (非 loopback: 用户名/密码/记住密码) → 鉴权 → WebSocket 连接完成`；只有实际连接成功才关闭或进入已连接态。鉴权成功但连接失败仍保留表单与重试入口，不能仅凭 token 或地址保存提示成功。提交期禁止重复提交、编辑及内部关闭。

### 登录状态与 Nyxus 视觉契约

登录展示只使用三种状态，登录页与 Nyxus 必须由同一状态计算结果驱动：

| 登录状态 | 判定含义 | Nyxus 中心 | 中心外围 | 登录页含义 |
| --- | --- | --- | --- | --- |
| `unauthenticated` | 远端没有有效登录凭证，且没有正在提交登录 | 稳定黑洞 | 保留星云和星点 | 未登录，显示登录表单 |
| `authenticating` | 正在提交登录，或已有凭证但 WebSocket 尚未完成 | 闪烁黑洞 | 保留星云和星点 | 登录中或等待连接完成 |
| `authenticated` | 登录凭证有效且 WebSocket 已连接 | 正常星系核心 | 正常星系、星云和星点 | 已登录，显示用户信息 |

这里的 WebSocket `connection.status` 只是登录完成的底层条件，不能单独代表“已登录”。`connected` 不等于 `authenticated`；否则登录页可能显示未登录，而 Nyxus 错误显示已登录星系。

黑洞是完整的外围场景，不是单独的黑色中心点。修改未登录或登录中渲染时，必须保留外围星云、星点和黑洞前景层；不能因为关闭已登录星系调度而提前返回并删除外围粒子。统一状态计算位于 [`apps/web/src/domain/auth/loginState.ts`](../../apps/web/src/domain/auth/loginState.ts) 的 `resolveLoginState()`，认证过程由 [`apps/web/src/stores/auth.ts`](../../apps/web/src/stores/auth.ts) 持有，Nyxus 输入和绘制分别见 [`apps/web/src/features/pets/nyxus/composables/useNyxusParticleInput.ts`](../../apps/web/src/features/pets/nyxus/composables/useNyxusParticleInput.ts) 与 [`apps/web/src/features/pets/nyxus/particles/nyxusRenderer.ts`](../../apps/web/src/features/pets/nyxus/particles/nyxusRenderer.ts)。

首次挂载即为可见的原生面和后续打开的浮动面共用初始化；记住密码的异步读取在关闭、切地址、重新打开或用户开始输入后失效。浮动面为非模态窗口，不声明 `aria-modal`。错误卡片保留 kind、backendMessage、HTTP status 和原始错误。

| 修改意图 | 稳定入口与关键符号 | 验证 |
| --- | --- | --- |
| 初始化、提交与重试 | [ServerLoginDialog.vue](../../apps/web/src/features/auth/ServerLoginDialog.vue) 的 `submit`、`visible` 监听 | `pnpm test:web`、`pnpm web:type-check`；浏览器首次打开与断连重试 |
| 连接结果 | [connection.ts](../../apps/web/src/stores/connection.ts) 的 `reconnect` | 同上；仅连接状态归 store，鉴权归 auth store |
| 登录状态与 Nyxus 视觉一致性 | [`loginState.ts`](../../apps/web/src/domain/auth/loginState.ts) 的 `resolveLoginState()` | [`apps/web/test/auth/loginState.test.ts`](../../apps/web/test/auth/loginState.test.ts)、[`apps/web/test/nyxus/cosmicScheduler.test.ts`](../../apps/web/test/nyxus/cosmicScheduler.test.ts) |

## 验收清单（视觉项交用户截图确认）

- [ ] 浮动窗与工作台 CyberWindow 一致：AUTH channel 徽记 + signal + 文字三键 + 角括号 + `--cyber-line` 描边
- [ ] 三键：最小化卷帘收缩（点标题栏恢复）、最大化铺满/还原、关闭
- [ ] 密码常态由原生 `type="password"` 遮蔽，开灯切换 `type="text"`；模板无密码 `value` 属性，DOM 中无额外原文文本层
- [ ] 手电光束：光源在手电 icon 灯头口，细长锥形右细左粗、贯穿窗口并溢出左缘；尾部 ±1.5° 角度摆动 + 微抖、发射点微动（无大幅整体平移）；手电 icon 与光束刚体一致（同角旋转 + 同相浮动）；粗细/长度随输入井与按钮尺寸实测派生
- [ ] 深色暖黄光 / 浅色黑光白字，两态几何动态一致
- [ ] 出错：面板描边转红 + 错误卡片
- [ ] 全直角、正文 400、中文 ≥12px、无新增硬编码色
- [ ] 浏览器浮动窗、ESC、记住密码、已连接态（登出/断开）、错误展开均可用

### 氛围布局

登录窗保留可拖动的 CyberWindow 外壳，内容区为响应式双区布局：左侧用信号场景表达连接状态，右侧保留地址、账号和密码操作区。场景只负责视觉表达，认证、错误、连接成功、登出、ESC 关闭、拖动和最小化由状态流程负责。

打开窗口时会有短暂的扫描和分区显现，密码灯光继续作为主要动效。`prefers-reduced-motion: reduce` 下，循环动效停止或降级。
