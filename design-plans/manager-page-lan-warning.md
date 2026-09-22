# 本地管理器页面：局域网安全警告改为「黄色警告框 + 红色警告图标」

Written against: `34a71392`（分支 `sp`）

## Evidence chain

- Surface: CheryNyxus 本地管理器页面（`manager/src/server.ts` 的 `writeManagerPage` 输出的单文件 HTML，浏览器访问 `http://127.0.0.1:39980/`，页面在 `host` 非回环监听时于顶部渲染局域网安全警告）
- Problem: 顶部局域网安全警告当前的视觉是「暗红色底 + 红色文字 + 文本符号 ⚠」，与用户明确要求「黄色警告框 + 红色警告icon」不符。显示条件本身已正确（非回环监听持续显示，见 `lanAccess = !isLoopbackHost(host)`），需要调整的是视觉呈现。
- Design evidence:
  - 用户指令（本会话）：顶部警告关联后端服务，监听地址不是 127.0.0.1 时一直提示，用黄色警告框 + 红色警告 icon。
  - 项目语义色（`web/src/styles/theme.css` 深色档）：`--warning: #fbbf24`（黄）、`--danger: #f87171`（红）——黄色框取 warning 语义，红色图标取 danger 语义。
  - 页面自身既有色板：`.warn` 文字色 `#ffd27d`（琥珀黄）、`.error` 红 `#ff8f9b`。
- Owner: `manager/src/server.ts` 的 `writeManagerPage`（第 255–281 行）。CSS 在第 261 行（`.lan-warning` / `.lan-warning strong`），警告 HTML 在第 263 行。
- Scope and affected surfaces: 仅管理器页面输出（`/` 与 `/index.html`）。不改 `/api/*`、权限门禁、token 续期、状态/凭据逻辑。
- Uncertainty: 黄色框的深浅观感（黄底透明度）与图标尺寸需要用户最终人工确认；结构、文案与显示条件均为确定项。

## Design decision

把局域网安全警告从「暗红警示」改为「黄色警告框 + 红色警告图标」：

- 框体走 warning 黄语义：黄色边框（`#fbbf24`）+ 黄色调底（`rgba(251,191,36,.15)`），正文保持浅色文字保证对比度，标题文字改用页面既有琥珀黄 `.warn` 色 `#ffd27d`（替代原红色标题）。
- 图标走 danger 红语义：把标题里的文本符号 `⚠` 替换为内联 SVG 红色三角警告图标（`fill: #ff8f9b`，与页面既有 `.error` 红色一致，等价 danger 角色），与标题文字 flex 排列。
- 保留：`role="alert"`、顶部位置、显示条件（`lanAccess`，非回环监听即持续显示）、全部文案不变（测试断言「局域网访问已开启」继续命中）。

## Reuse

- 黄：项目深色 `--warning: #fbbf24`（边框与黄底）；页面 `.warn` 文字色 `#ffd27d`（标题/正文文字）。
- 红：页面 `.error` 红 `#ff8f9b`（图标填充，语义等价项目深色 `--danger: #f87171`）。
- 页面为独立深色页（不共享 `web/src` 的 `var(--warning)`），故取 token 深色值硬编码到页面内联样式；无新增并行样式模式。

## Changes

1. `manager/src/server.ts` 第 261 行 CSS：替换 `.lan-warning` 与 `.lan-warning strong`，并新增 `.lan-warning svg`：
   - `.lan-warning`：`background:#3a1d1d;border:1px solid #ff8f9b;color:#ffd9dc` → `background:rgba(251,191,36,.15);border:1px solid #fbbf24;color:#ffd9dc`；`padding:14px 16px;border-radius:6px;line-height:1.6` 保持不变。
   - `.lan-warning strong`：`color:#ff8f9b;display:block` → `color:#ffd27d;display:inline-flex;align-items:center;gap:6px`；`margin-bottom:4px` 保持不变。
   - 新增 `.lan-warning svg{flex:none;width:18px;height:18px;fill:#ff8f9b}`。
2. `manager/src/server.ts` 第 263 行 HTML：把 `<strong>⚠ 安全警告：局域网访问已开启</strong>` 里的文本符号 `⚠ ` 替换为红色内联 SVG 三角图标：
   - `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 2 1 21h22L12 2zm1 13h-2v2h2v-2zm0-6h-2v4h2V9z"/></svg>安全警告：局域网访问已开启`
   - 图标保持 `aria-hidden="true"`（语义由文字承载）。
   - Preserve: 文案、`role="alert"`、`lanAccess` 显示条件、顶部位置、`border-radius:6px` 等未明确要求的属性不动。
   - Verify: 页面在非回环监听时顶部出现黄色警告框 + 红色 SVG 警告图标；`toContain('局域网访问已开启')` 断言仍命中。

## Scope

- Inherit: 管理页面所有访问形态（本机回环 / 内网带密钥 / 宽窄视口）共用同一模板，改动自动生效。
- Verify: `test/manager/server.test.ts` 的页面相关断言（第 106–150 行与第 345–357 行）。
- Exclude: 状态/凭据/启停交互、token 记忆与续期、`manager.host` 解析逻辑、其它页面区块样式。

## Validation

- Product: 用户以非回环地址（如 `manager.host: 0.0.0.0` 或内网 IP）启动管理器并打开页面，顶部持续显示黄色警告框 + 红色警告图标；改回 `127.0.0.1` 后警告消失。
- Interface: `/`（含 `?token=` 进入与 Cookie 记忆后的刷新）、窄视口下警告框不溢出、深色页对比度可读。
- System: 仅改页面模板字符串；不触碰 `/api/*`、权限门禁、token 续期；无新增并行样式模式。
- Repository:
  - `pnpm manager:type-check` → 0 错误
  - `pnpm exec vitest run test/manager/server.test.ts` → 全部通过（含「局域网访问已开启」断言）
  - `pnpm manager:build` → 构建成功
- 视觉验收（人工，按项目规则）：用户启动后确认黄色框 + 红色图标观感是否符合预期。

## Stop conditions

- 若用户对黄色深浅或图标样式有不同预期，只调整色值/尺寸，不改结构、文案与显示条件。
- 若 manager 页面将来迁出 `server.ts`（如独立静态资源），本改动随之迁移到新位置。
- 若页面模板的 HTML/CSS 结构发生重构，先重读当前实现再套用本决定。

## Design documentation

- 无需更新持久文档（纯视觉呈现变化，行为契约不变）。
- 若用户确认新视觉并希望记录，可在 `docs/guides/backend-runtime.md` §局域网访问安全警告补充一句样式说明；默认不加。
