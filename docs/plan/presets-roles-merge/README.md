# 预设与角色 Tab 合并（阶段一：前端合并）

**文档创建时间：** 2026-09-21T11:28:09+08:00

**状态：** 执行中

## 目标与边界

把设置中心的一级 Tab「预设」与「角色」合并为一个「预设」Tab，形成「外层预设列表 → 点击进入该预设的角色工作台」的两层交互。角色在界面语义上归属当前预设，移除独立的全局角色管理入口与预设内的「选择成员」下拉。

- **阶段一（本任务）**：前端完成「预设 / 角色」合并与「公共 + 私有」角色双轨。config 引入一个可选字段 `roles.<name>.scope: 'public' | 'private'`（缺省私有），并补一条后端校验（组长不能是公共角色）；config.get/save 协议结构、数据库与 RPC 语义不动（zod schema 对 roles 条目为宽松对象，`scope` 字段天然放行，无需改协议）。
- **阶段二（非目标，后续独立任务）**：config 字段结构真正内嵌（roles 移入 presets、公共角色独立成段），连带 config 协议、运行编制解析、配置热更新、DB 历史会话角色解析（`metadata.type/roleId/spawnTypes`）迁移。本任务不做，只在总任务中登记边界，防止恢复时混淆。

## 设计依据（尽调结论摘要）

现状：角色是全局独立实体、可被多个预设共享（实例如组长 `cheryNyxus` 同时属于 `cheryNyxus` 与 `devTeam` 两个预设）；预设通过 `leader` / `roles[]` / `detailRole` / `shadows.conversationRouting` 引用角色。运行时按 `preset.leader` 取角色配置做编制快照，DB 历史会话存 `presetId` / `roleId` / `spawnTypes`。

经协商确认的关键决策（详见「已确认的设计决策」）：
1. 角色归属预设，不可跨预设共享（最终方向，阶段一先在界面语义上体现）。
2. 分两阶段：先前端合并（本任务），结构变更为后续独立任务。
3. 保留现有锁定语义（固定角色 `lock`、固定预设 `cheryNyxus`）。
4. 影子角色保留全局区，作为合并后 Tab 的子视图。

阶段一已知风险点（实施时逐项核对，写入对应小任务）：
- 删除预设内角色若连全局条目一起删，须清理全部预设对该角色的引用并展示影响，避免悬空引用触发后端 `config.save` 校验失败。
- 现有数据存在跨预设共享角色（如 `cheryNyxus` 组长），阶段一删除语义需与「不可共享」方向一致，界面不提供跨预设选择成员的入口。
- 一级 Tab 移除「角色」后，外壳中与 `roles` 相关的分支、骨架屏配置、错误前缀映射、主题色联动要一并清理，不留失效入口。

## 已确认的设计决策（与用户协商一致）

| 决策点 | 结论 |
|---|---|
| 一级 Tab 名称 | 保留「预设」（原「角色」Tab 移除并入） |
| 进入角色工作台入口 | 预设卡片上单独「编辑角色」按钮 |
| 新增角色方式 | 支持全新创建 + 从其他预设复制现有角色到本预设（复制后独立编辑） |
| 删除预设内角色 | 连全局 roles 条目一起删除，同步清理所有预设引用，删除确认展示影响 |
| 角色归属模型 | 角色归属预设，不可跨预设共享（最终方向） |
| 公共角色（新增决策） | 采纳「公共 + 私有」双轨：公共角色全局共享单一源（解释角色、固定预设内置角色划为公共），可被任意预设引用；私有角色归属预设、删除连删。组长必须私有 |
| config 结构变更 | 分两阶段；本任务只做前端合并 |
| 固定机制 | 保留现有锁定语义 |
| 影子角色 | 保留全局影子区，作为合并后 Tab 的子视图 |

## 公共角色双轨设计（2026-09-21 协商确认）

角色分为两层，避免退回「任意跨预设共享」的旧状态，又解决解释角色等公共基础角色的维护成本：

- **公共角色（Public）**：全局维护、不归属任何单一预设、可被任意预设引用（单一源，改一处全局生效）。适合解释角色、curator、roleArchitect 等公共基础设施。组长不能是公共角色（组长是预设私有编成核心）。
- **私有角色（Private，预设内）**：归属单一预设、不可跨预设共享、删除连全局删。即本任务 T01–T04 已实现的一套。

### 数据层（阶段一落地，经用户确认引入字段）

- `config.roles.<name>.scope: 'public' | 'private'`（可选，缺省即私有）。`config.save` zod schema 对 roles 条目为宽松对象（`z.looseObject`），未知字段天然放行，协议结构无需改；`validateRawConfig` 不检查未知字段。
- **后端配套（仅一条校验）**：`validateRawConfig` 补充——`presets.<name>.leader` 不能引用 `scope: 'public'` 的角色（防手改 yaml 绕过，fail loud）。zod schema 补 `scope: z.enum(['public','private']).optional()` 作值域约束。
- **公共角色判定（前端 helper，兼容存量数据）**：`roles[name].scope === 'public'` 或「固定预设 cheryNexus 的非锁定普通成员角色」。这样存量 explanation / curator / roleArchitect 无需改配置文件即自动成为公共角色。

### 交互

- **入口（已确认）**：预设列表顶部独立「公共角色」入口 → 公共角色管理视图（全局维护层）。
- **公共角色管理视图**：左轨公共角色列表，右轨编辑配置（大脑/感官/装备/提示词/权限/头像/改名）；可新增公共角色（`scope: 'public'`）、删除公共角色（删全局 + 清理所有预设引用）。
- **预设工作台**：新增角色弹窗增加第三来源「引用公共角色」（池 = 公共角色，排除本预设已引用）；引用后带「公共」标记；**配置只读**（引导去公共层修改）；职责可设解释角色、**不可设组长**；删除为「移出本预设」（只从引用移除，不删配置）。

## 小任务台账

批次：单批次串行（T01 → T02 → T03 → T04 → T06 → T05），依赖明确。

| 编号 | 小任务 | 复杂度 | 依据 | 状态 |
|---|---|---|---|---|
| T01 | 预设 Tab 双视图框架：移除独立「角色」Tab，预设 Tab 内部「列表视图 ↔ 角色工作台视图」切换，「编辑角色」入口与返回 | 3 | 跨 SettingsDialog、useSettingsDialogController、constants、PresetsTab 多组件联动，须保持既有交互与骨架屏机制 | 已完成 |
| T02 | 角色工作台限定到当前预设：左轨只显示该预设普通角色；新增/复制/删除走预设内语义，删除连全局清理并展示影响 | 4 | 角色增删改查联动、跨预设引用清理、复制角色、leader/detailRole 同步，与后端 config.save 校验语义衔接，属跨模块契约与数据一致性风险 | 已完成 |
| T03 | 影子角色子视图：保留全局 shadow 管理，作为合并后 Tab 内的「影子角色」切换 | 2 | 复用现有 shadow 过滤与引用逻辑接入新视图，单模块有限映射 | 已完成 |
| T04 | 测试更新与新增：更新 settingsTabVisibility 等既有断言，新增预设工作台范围/复制/删除语义测试 | 2 | 边界明确的测试维护 | 已完成 |
| T06 | 公共角色双轨：`roles.<name>.scope` 字段（前端类型 + 后端一条「组长非公共」校验 + zod 值域）；预设列表顶部「公共角色」管理视图（增删改）；预设工作台「引用公共角色」来源、公共标记、配置只读、组长限制、移出本预设语义 | 4 | 引入字段与后端校验（改原「阶段一后端不动」边界，经用户确认）；新增管理视图 + 工作台多来源与只读/职责限制联动，跨组件契约与数据一致性风险 | 已完成 |
| T05 | 综合验证与用户验收 | — | 最后创建，按计划规范维护 | 未开始 |

## 已收口小任务执行记录

### T01 预设 Tab 双视图框架

- 变更对象：`web/src/features/agent/settings/config/constants.ts`、`useSettingsDialogController.ts`、`SettingsDialog.vue`、`tabs/agent/PresetsTab.vue`。
- `pnpm web:type-check`：退出码 0，无类型错误。
- `pnpm exec vitest run --config web/vitest.config.ts test/architecture/settingsTabVisibility.test.ts`：退出码 0，5 测试通过。
- 关键断言行：`paneTabs` 含 brains/media/senses/presets/mcp/global/commands/terminal/hooks/skills/plugins/archive，不含 roles；`ERROR_TAB_BY_PREFIX.roles` 指向 `presets`；`rolesShadowMode` 全部移除。

### T02 角色工作台限定到当前预设

- 变更对象：`tabs/agent/useRolesTabController.ts`、`tabs/agent/RolesTab.vue`、`tabs/agent/RolesTab.styles.less`、`tabs/agent/PresetsTab.vue`。
- 契约：普通角色左轨按 `preset.roles` 成员限定（`isInRoleScope`）；新增写全局并加入当前预设成员；从其他预设复制（`copySources` 排除锁定角色与 cheryNyxus）后独立编辑；删除连全局条目一起删并清理所有预设引用（roles/leader/detailRole/conversationRouting）；详情卡新增组长/解释角色职责按钮（`toggleLeader`/`toggleDetailRole`，固定预设禁用）。
- `pnpm web:type-check`：退出码 0，无类型错误。

### T03 影子角色子视图

- 变更对象：`tabs/agent/RolesTab.vue`（sect-hint 文案）、`useRolesTabController.ts`（shadow 过滤保持全局）。
- 契约：影子角色保留全局区，作为工作台「影子角色」分类子视图；新增 shadow 不入预设成员。

### T04 测试更新与新增

- 变更对象：`web/test/architecture/settingsTabVisibility.test.ts`（pane 列表移除 roles、补 terminal）、新增 `web/test/settings/presetRolesWorkbench.test.ts`（5 项预设范围/复制/删除/职责契约断言）。
- `pnpm exec vitest run --config web/vitest.config.ts test/settings test/architecture/settingsTabVisibility.test.ts`：退出码 0，8 文件 28 测试通过。

### T06 公共角色双轨

- **数据层（经用户确认引入字段）**：`config.roles.<name>.scope: 'public' | 'private'`（缺省私有）。
  - 后端：`src/utils/config.ts` `RoleConfig` 加 `scope` 字段 + `validateRawConfig` 补「组长不能是公共角色」校验；`src/service/message/schemas.ts` roles 条目补 `scope: z.enum(['public','private']).optional()` 值域约束。zod 对 roles 条目为宽松对象，`scope` 天然放行，协议结构未改。
  - 前端类型：`web/src/services/agentApi.ts` `ConfigDto.roles` 加 `scope?`。
- **公共角色判定 helper（新增）**：`tabs/agent/publicRole.ts` 提供 `isPublicRole`（`scope==='public'` 或固定预设成员且非组长）、`listPublicRoles`、`isSeedPublicRole`（固定预设种子，禁止删除）。controller 与 PresetsTab 共用，避免逻辑漂移。
  - 推导口径修正：**排除「固定预设组长」而非「锁定角色」**——`lock` 只表示禁止删除/改名，不影响是否公共；curator（模板 `lock: true`）是公共基础设施角色，必须识别为公共；而 cheryNyxus（固定组长）保持私有，避免历史跨预设组长（devTeam leader=cheryNyxus）撞上「组长必须私有」后端校验。
- **模板与生成提示词同步**：`.chery.template/config.yaml` 为 curator / explanation / roleArchitect / roleAcceptance 显式加 `scope: 'public'`（cheryNyxus 不加）；`.chery.template/docs/config.md`（roles 表 scope 行、leader 说明、校验清单、公共/私有语义段）、`.chery.template/docs/role-design.md`（新增「角色归属」节）、`.chery.template/prompt/cheryNyxus/cheryNyxus.md`（生命周期协议补公共/私有 + 组长必须私有）、`.chery.template/skills/preset-lifecycle/SKILL.md`（创建段补组长必须私有）同步。既有安装（`.chery/config.yaml`）不改写，靠前端推导识别。
- **交互**：
  - `PresetsTab.vue`：视图扩为 `list ↔ workbench ↔ public`；列表顶部「公共角色」通栏入口（计数 + 点此管理）；`mode="public"` 挂载 RolesTab 作公共角色管理视图。
  - `useRolesTabController.ts`：`publicMode`；`referencePool` / `referencePublicRole`（引用不复制，写入本预设成员）；`readOnly`（预设工作台里公共角色配置只读）；组长对公共角色禁用（`toggleLeader` 守卫 + 模板 `:disabled`）；删除语义区分——预设工作台公共角色「移出本预设」、公共管理视图删全局、种子公共角色禁止删除；复制/改名公共角色强制保留 `scope:'public'`。
  - `RolesTab.vue`：新增弹窗「或引用公共角色」来源；rail 公共徽章（`badge: isPublicRole ? '公共'`）；header 公共标记 + 只读（改名/头像/说明/复制禁用）；`role-readonly-banner` 引导去公共层改；职责组长按钮对公共角色禁用；固定预设工作台成员不可移除（`!isFixedPreset` 守卫）；种子公共角色只读锁标记。
  - `RolesTab.styles.less`：`.role-public-tag` / `.role-readonly-banner` 样式。
- **测试**：
  - 新增后端 `test/utils/publicRoleConfig.test.ts`（4 项：公共角色可作普通成员、不可作组长、即使已是成员也不可作组长、私有角色可作组长）。
  - 更新 `web/test/settings/presetRolesWorkbench.test.ts`：view 类型断言改为 `'list' | 'workbench' | 'public'`，新增「public role dual-track」5 项契约断言（scope 字段、controller 公共池/引用/只读、预设 Tab 入口与管理视图、只读横幅与公共标记、共享源与移出本预设语义）。
- **验证**：`pnpm web:type-check`、`pnpm type-check` 均退出码 0；后端 config 相关 3 文件 14 测试通过；`web/test/settings` 7 文件 28 测试通过。

### T06b 新需求：系统锁定角色 + 卡片表面职责区恢复（2026-09-21 确认）

用户新要求（语音输入已纠正理解）：
1. 预设卡片表面**恢复原本的「设置组长 / 设置解释」入口**（恢复，按原本样式）；工作台内部保留调整能力（两处并存）。
2. 默认配置表面只突出 `cheryNyxus`（组长）+ `explanation`（解释角色）两个职责，其余交给用户自己创建。

经用户确认的关键决策：
- `curator` / `roleArchitect` / `roleAcceptance` 是**系统锁定角色**（`lock: true`、非公共），不是公共角色——保留在固定预设成员内以保证 `spawn_role` 可派发、Cherry Nexus 角色设计/验收/记忆流程不断；默认配置仍保留这三个角色，但标为锁定系统角色。
- 解释角色 `explanation` 作为固定预设的**种子公共角色**（移除显式 `scope`，靠「固定预设成员且非组长且非锁定」推导），禁止删除。
- 卡片表面只恢复职责指定区（设置组长/设置解释 + 点击成员指定），**不恢复**「选择成员」下拉（成员增删走工作台）。
- 固定预设仍锁定（成员/组长不可调）；公共角色不能设为组长；锁定系统角色不可指定职责。

实施记录：
- **`tabs/agent/publicRole.ts`**：`isPublicRole` / `isSeedPublicRole` 推导口径再修正——**排除锁定角色**（`lock` 优先于显式 `scope`），即系统锁定角色一律不算公共角色；固定预设组长仍排除。注释同步更新（T06 中「排除组长而非锁定」的推导方向已被本需求推翻）。
- **`.chery.template/config.yaml` 与 `.chery/config.yaml`（运行时）**：`curator` / `roleArchitect` / `roleAcceptance` 移除 `scope: public`、补 `lock: true`（curator 已有）；`explanation` 移除显式 `scope: public`（改为种子推导）。固定预设成员保持全部 5 个（保证 spawn_role 可派发）。
- **`tabs/agent/PresetsTab.vue`**：卡片表面恢复「团队成员与角色职责」区——`rolePickerModes`（leader/detail 切换）、`setLeader`（组长，公共角色守卫）、`setDetailRole`、`selectRoleDuty`；成员卡点击指定职责，黄色角标=组长、青色角标=解释角色；固定预设全部禁用 + `fixed-leader-note`；公共角色卡设组长禁用；锁定角色卡锁定样式；悬停显示大脑/器官组/感官/MCP 卡片。样式 `.role-picker-section` / `.member-role` / `.role-mode` / `.leader-mark` 等移植回本组件。
- **模板文档同步**：`.chery.template/docs/config.md`（公共/私有语义段改三层）、`.chery.template/docs/role-design.md`（「角色归属（公共 / 私有 / 系统锁定）」节）、`.chery.template/prompt/cheryNyxus/cheryNyxus.md`（生命周期协议三层说明）、`.chery.template/skills/preset-lifecycle/SKILL.md`（创建段补系统锁定角色不可删/不可改公共）；`docs/frontend/settings.md`（公共角色双轨改三层 + 新增「卡片职责区」段 + 固定预设成员列表更新）。
- **测试**：`web/test/settings/presetRolesWorkbench.test.ts` 新增 2 项契约断言（卡片职责区恢复、公共角色不可设组长）；新增 `web/test/settings/publicRoleLogic.test.ts`（4 项：锁定系统角色非公共、显式 scope 仅在非锁定时算公共、组长不入公共池、种子公共角色保护仅限解释角色）。
- **验证**：`pnpm web:type-check` 退出码 0；`web/test/settings` 8 文件 30 测试通过；后端 `test/utils` config 相关 4 文件 22 测试通过。

## 依赖

- T01 是 T02、T03 的框架前置（工作台视图存在后才能限定角色范围与接入影子区）。
- T02 先于 T03（影子区挂在预设角色工作台内）。
- T06（公共角色引用）依赖 T02 的角色工作台与新增弹窗。
- T04 在 T01–T03 完成后做全量测试更新；T05 最后。

## 当前恢复检查点

- T01–T04、T06、T06b 实现与定向验证已完成（执行记录见上）。剩余工作：创建 T05 综合验证小任务，由用户验收。
- 验证入口：`pnpm test:web`、`pnpm web:type-check`、`pnpm type-check`、`pnpm test:backend`（config 相关单测）。
- 已知注意：全量 `pnpm test:web` 当前有 7 个文件 / 9 个测试失败，均为 workbench/nyxus 方向其他进行中任务的改动所致，与本任务改动文件无交集（settings 相关测试全部通过；后端 config 相关测试全部通过）。

## 最终综合验证与用户验收

按计划规范，最后一个综合验证小任务（T05）在其余小任务全部完成并删除后创建，集中登记自动验证清单、必要的手动验证清单（真实视觉与交互 / 主观 UX / 跨窗口 / 性能）与抽样信任记录。反馈回填槽用于登记实施过程中的全部待补项。

## 复杂度与模型能力汇总

本总任务复杂度 5（前端跨多组件改造 + 与后端保存语义衔接的数据一致性风险，虽 T06 之前不动后端代码，但影响面覆盖设置中心全链路的界面语义；T06 引入 `scope` 字段后涉及一条后端校验）。T01/T02/T06 建议使用当前可用的最强模型；T03/T04 常规模型即可。复杂度不绑定固定模型类型，执行前按项目配置再次向用户确认分配。
