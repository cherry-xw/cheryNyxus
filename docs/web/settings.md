# 设置中心

设置中心采用“一级 Tab + 资源工作台”的桌面布局。一级 Tab 切换配置域；角色、大脑、感官组、MCP、媒体等多实例资源在 Tab 内使用左侧资源卡片栏，右侧只编辑当前项。技能与插件保留高密度搜索分页列表，避免数百条资源同时挂载 DOM。

标题栏：Electron 原生设置窗由 `WindowFrame` 公共标题栏承载（标题 + 最小化/最大化/关闭三键），`SettingsDialog` 自身 header 仅浏览器 overlay 路径渲染（native 面隐藏，避免双层标题）；「打开配置文件夹」为公共组件 `OpenConfigDirButton`（icon / ghost 两变体），native 面由 `App.vue` 放入 `WindowFrame` 的 `title-actions` slot（**紧贴标题右侧、与标题同行垂直居中**，即标题位置扩展点），浏览器路径 header 与错误弹窗 footer 复用同款。

## 通用交互

- `TabShell` 顶部只承载说明与固定工具栏，搜索和批量操作不会随资源列表滚动。
- 一级 Tab 内容使用互斥的 `v-if / v-else-if` 分支，同一时刻只挂载当前页；非活动页不保留 DOM、监听器和动画实例。切换时先提交一帧 `SkeletonTab` 骨架屏，目标页准备好后再挂载揭示；快速连续切换使用请求序号丢弃过期揭示。`config.yaml` 的未保存编辑统一保存在 `SettingsDialog` 的父级 `draft`，独立的 Hooks 草稿也由父级受控持有并在首次进入 Hooks 页时懒加载，因此切换卸载子页不会丢失待保存数据。
- 卡片锚点与分页导航通过 Vue Teleport 挂到设置弹窗底栏左侧：少量项显示可点击序号，大量项显示窗口化序号、范围和前后翻页；保存固定在右侧（关闭入口收敛到右上角窗口控制三键 / 自绘关闭键）。
- 新增、复制后必须自动选择并定位新项；删除当前项后选择相邻项。
- 趣味动效只用于状态确认（头像切换、复制、能力翻转）；应用不跟随客户端 `prefers-reduced-motion` 判定，动效恒开（见「动效降级约定」）。
- 错误在设置中心内部弹窗展示，列表卡片仅保留错误状态标记。保存失败的错误弹窗按行解析后端错误串：能识别配置域前缀（`presets`/`roles`/`llm`/`sense_groups`/`media`/`mcp_servers`/`global`/`memory`）的行，前缀对应 Tab 的图标与名称（如 `presets.默认.workspace ...` → 📦 预设），错误文本仅展示不可点击，跳转行为收敛到行尾独立的「前往 →」按钮（点击切换到对应 Tab）；未知前缀原样展示无跳转按钮。弹窗底部提供「打开配置目录」按钮（复用 `config.openDir`），便于直接查看 config.yaml 排查。
- 全局 Tab 使用无空洞的响应式拼贴模块墙：监管、编辑器、限制、日志、压缩和记忆块按信息量拥有不同宽高。普通下拉和数字框替换为分段卡、属性调节器、编辑器卡片与标签弹匣；紫蓝玻璃光晕表达选中与聚焦，暖色只用于警告。
- 技能与插件导入统一使用“霓虹开卡包”交互：选择 Git/ZIP 来源对应挑选卡包，读取阶段表现为拆封与洗牌，候选确认使用可选择的卡牌阵列，提交后集中收牌并揭晓导入结果。视觉使用青绿、亮粉、橙黄、电蓝与酸性绿的多色霓虹，不以紫色或魔法阵作为主视觉；弹窗底色允许青红通道错位和间歇色块抖动，但表单、文字与操作控件保持稳定。高表现力动效只表达当前状态；应用不实现 `prefers-reduced-motion` 静态退化（见「动效降级约定」）。

## 动效降级约定

应用**不跟随**客户端 OS 的 `prefers-reduced-motion: reduce` 判定，动效恒开。原因：本项目以浏览器访问 headless 服务端为主，客户端（如 Windows/RDP 会话默认关闭系统动画）的 reduce 判定不可靠，曾导致全站 `animation/transition` 被无障碍兜底规则灭活。代码中不新增 `@media (prefers-reduced-motion: reduce)` 块与 `matchMedia('(prefers-reduced-motion: reduce)')` 门控；motion-v 保持默认 `reducedMotion: "never"`。

## 角色图鉴与装备

`roles.<type>.avatar` 是可选的角色头像字形。缺省时前后端都按角色名从内置头像池稳定选择；显式值可来自内置职业徽记、宠物 Emoji 或用户输入的单个 Emoji/短字形。头像会用于设置页、预设编成和 `role_created` 后生成的子宠。

角色的技能、插件和 MCP 使用三态装备语义：

- 字段缺省：继承全部。
- 非空数组：只启用选中项。
- 空数组：全部关闭。

装备选择器不再打开侧边抽屉。技能、插件和 MCP 的概览卡共用卡片下方的页内编辑区：一次只编辑一类，已装备项固定在顶部，未装备项按名称搜索并以每页 24 项分页。增删直接更新设置草稿，最终仍由设置弹窗统一保存；切换角色、继承全部或全部关闭会关闭编辑区并重置搜索分页。技能和插件按实际元数据汇总 token；MCP 为近似值并在 UI 明示。装备卡、标签、按钮统一使用角色 Tab 的主题色。

### 行为权限

角色详情「行为权限」区块遵循「模板打底 + 少量覆盖」心智模型，分四层：

- **策略模板卡片**：模板不用下拉而用四张卡片选择器（复用「AI 大脑」choice-board 交互）。每卡三行：模板名（带风险色点，绿->红）+ 一句话定位 + 按维度摘要小字（`读/写/命令/MCP/派遣`，取自模板默认值）。切换模板不清除已有覆盖项，与后端 `mergePolicy` 行为一致。
- **分组覆盖**：六个覆盖 select 按「文件（读取/写入范围）/ 命令（最大沙箱权限 + 允许脚本方言）/ 集成（MCP 默认/派遣角色）」三组重排；label 挂 LabelTip（走 `.label-tip-popper`），说明取值语义与「工作区」「区外需审核」等术语。选项文案自描述化（如写入范围「区内直写 · 区外需审核」）。
- **自定义标记**：覆盖字段被显式设置（非 undefined）时 label 旁亮主题色小点与「已自定义」；清空 select（clearable）即回到继承模板并熄灭标记。MCP/派遣的「继承」值在 tip 中解释为「按模板与未知工具监管规则处理」。
- **生效结果预览条**：区块底部常驻一行摘要，由前端 `resolveEffectivePolicy`（后端 `src/core/security/rolePolicy.ts` 的 `defaultPolicy` + `mergePolicy` 镜像，位于 `web/src/features/agent/settings/config/rolePermissions.ts`）计算模板 + 覆盖的合并结果；被自定义的维度以主题色高亮。`inherit` 解析为实际生效值（未受信模板下未知 MCP/派遣 ->「每次审核」）。

「允许脚本方言」checkbox 归入命令组，不再是独立行。`commands.categories`、`tools` 通配与 `spawn.allowedRoles` 属高级项，不进 UI，仅在 tip 中提示可手改 config.yaml。

## 大脑地址与密钥

大脑卡片的地址输入框不渲染模板占位符（如 `<YOUR_OPENAI_COMPATIBLE_URL>`、`<YOUR_MODEL_NAME>`）：此类尖括号占位符在展示层视为空值，输入框仅呈现中文 placeholder「LLM URL 或大模型地址」，避免把模板默认占位文本当成真实配置展示；占位符本身仍保留在草稿中，用户填写真实地址后正常回显。

密钥下拉的选项来自 `.env` 变量名（`env.list`）。选项 label 直接显示变量名（如 `OPENAI_API_KEY`），不渲染 `$` 前缀——存储值仍带 `$` 前缀（供后端 `$ENV` 占位注入），仅是展示层去掉了 `$`。密钥行提供「刷新」按钮：点击重拉 `env.list`，后端每次实时读盘并**顺带把 `.env` 新增/修改的变量覆盖同步进 `process.env`**，因此运行期编辑 `.env` 后点一下刷新，新密钥变量名立即出现在下拉、且被 `$VAR` 引用的新值无需重启即可生效。刷新期间按钮转圈并禁用。下拉按后缀过滤（任意 `KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`PASSWD`/`ACCESS_KEY_ID` 结尾视为密钥，运行时配置变量如 `CHERY_DIR` 不进入）。

## 大脑连接测试

大脑卡片的“连接 / 模型与服务”区使用当前表单内尚未保存的适配器、地址、密钥和型号执行“测试连接”。后端发送单条“只回复 OK”的真实最小请求：成功行内显示“连接成功”，失败显示大脑友好错误；测试期间按钮进入 loading 并禁止重复点击。任一连接字段变化后立即清除旧结果，避免把过期结果当作当前配置有效。

测试不自动保存配置，不创建会话，也不触发工具、重试或 Hook。`mock` 是离线脚本回放，按钮禁用并提示“离线模拟无需测试”。

## 大量技能

设置弹窗打开时不拉取全量技能正文。技能目录缓存以文件路径、大小和修改时间为失效条件；搜索阶段只使用 frontmatter，当前页才读取正文并计算完整 token。

技能来源卡只展示仓库、分支、HEAD、同步/检查时间与更新状态，不在页面中把技能和仓库分组展示。“检查更新”只比较远端 HEAD；“同步”才 clone 并进入分页候选确认。

技能页始终展示“已挂载仓库”区，即使暂无来源也保留空态和“导入新仓库”入口；该入口与技能列表的导入入口复用同一个导入流程。技能名称、说明和触发条件在分页卡片中完整换行展示，不再依赖省略号或 hover 才能辨认。

技能和插件搜索固定在各自 Tab 顶部工具栏。技能搜索使用后端分页查询并在输入后回到第一页；插件搜索使用本地过滤并同步重置页码。

导入弹窗不改变后端两阶段协议：Git/ZIP 先进入 staging，再由确认界面提交。技能确认以可翻选卡牌展示普通、冲突和覆盖状态；插件确认展示仓库版本、插件名和技能卡组阵列。成功提交后短暂播放开包揭晓与收牌动画，再关闭并刷新列表。

导入 staging 只返回候选统计。候选列表通过 RPC 分页查询，冲突优先；提交使用默认选择规则加用户差异项，避免把数百条完整候选往返传输。

## 删除确认

设置中心内会造成配置项或已安装资源丢失的删除统一使用 Element Plus popper 二次确认。轻删和原“重删”共用同一确认组件；影响范围以可换行正文展示。popper 主体和箭头使用同一背景、边框变量。标签关闭、附件移除等可撤销的草稿编辑不属于破坏性删除，不增加二次确认。

## 预设 Tab

每预设 = 团队成员多选（引用 `config.roles` 单一源）+ 组长（leader）+ 可选的解释角色（detailRole）。运行时采用组长角色配置，不在预设内重定义 brain/sense。

**布局**：会话路由、工作区、审批规则三组选择并排一行（紧凑 `card-grid-3`）；媒体服务（图片/视频/音频）单独一行。三组字段的 label 均挂 info 图标（hover 出 tip，见下方「tip 排版与配色」）。工作区校验告警（后端 `config.save` 返回的 warning / 前端格式错误）显示在「工作区」字段内部、输入框正下方，不放整个三列块底部。

**工作区选择**：目录选择按钮按运行模式互斥展示——Electron 模式显示「选择目录」原生按钮（`dialog.showOpenDialog`，选的是后端同机绝对路径）；浏览器模式显示「浏览」按钮，通过 `config.workspace.browse.*` 协议打开「面包屑 + 目录列表」弹层，逐层懒加载服务端文件系统并选中目录回填。**默认全盘可浏览**（POSIX 从 `/`、win32 全部盘符），权限由系统对后端的实际访问报错把关——目录无权限时列表行内提示「下级无法加载（无权限）」，不可再钻取；`.chery` 系统配置目录恒不可见。配置 `server.workspace_browse.roots` 可收窄浏览范围。选中目录走既有 `updateWorkspace` → `workspaceChange` → 即时校验链路（`config.workspace.validate`）。手动输入绝对路径不受影响。

**Cherry Nexus 固定预设**：`cheryNyxus` 为系统固定预设——不可改名、删除、换组长，成员固定不可修改（模板默认为 roles=[cheryNyxus, roleArchitect, curator, explanation]，leader=cheryNyxus，detailRole=explanation）。`roleArchitect` 只研究任意岗位并返回蓝图，具体工具映射与配置写入仍由 Cherry Nexus 完成。前端「选择成员」下拉禁用、「设置解释」禁用、成员卡全部禁用；成员配置本身不在设置页改动。

**审批规则**：原「规则文件」改名为「审批规则」。下拉选择 `.chery/rule/` 下覆盖文件（`presets.<name>.rule`），与基准 `base.yaml` 深合并（详见 docs/core/sense.md「smart 规则表」）。右侧「刷新」按钮重新拉取 `rules.list`——手动新建或与 Cherry Nexus 对话生成规则文件后立即可见。tip 含机制（命中危险拦截/未命中放行）+ 操作方案（与 Cherry Nexus 对话生成 / 手动编辑 `.chery/rule/` + 保存重启）。

**tip 排版与配色**：`.label-tip-popper`（web/src/styles/element/index.scss）全局 `pre-line` 换行（content 内 `\n` 分节）+ 配色随主题——背景 `var(--panel)` / 文字 `var(--ink)`（深色黑底白字、浅色白底黑字）；`.el-popper.is-dark.label-tip-popper` 抬特异性覆盖 el-tooltip 默认黑底。影响所有 LabelTip（编辑器/插件导入/指令/大脑/技能导入/预设）。

**tip/title 使用边界（硬性要求）**：任何提示性内容**默认必须用 tip 展示**（LabelTip / el-tooltip，走 `.label-tip-popper` 排版）；只有**非常不重要**的信息才允许降级为原生 `title` 属性。新增 UI 一律按此判定，不得以 `title` 作为提示性内容的默认载体。

## 依赖与关联

- `web/src/features/agent/settings/SettingsDialog.vue`：一级 Tab、保存和错误弹窗。
- `web/src/features/agent/settings/components/TabShell.vue`：统一资源导航。
- `web/src/features/agent/settings/tabs/RolesTab.vue`：角色图鉴与装备。
- `src/agent/prompt/loadSkill.ts`：技能目录缓存与分页元数据。
- `src/service/skill/`：技能列表、来源检查、同步和 staging。
