# 移除 Electron 前端壳

**文档创建时间：** 2026-09-29T15:50:18+08:00

**状态：** 待综合验证

## 目标与边界

用户决定彻底移除 Electron 能力，以浏览器作为唯一的产品前端：不再构建、启动、打包或引用 Electron 主进程、preload、原生窗及 IPC；工作台、会话、设置、登录、桌面布局和终端等仍通过现有浏览器界面/后端能力可达。后端、本地管理器及其 Windows 托盘、系统服务与 relay 都不是 Electron 壳，不能仅因名称里有“桌面”“托盘”“终端”就删除。

与[登录优先及能力分级计划](../login-first-capabilities/README.md)同时推进，但各自有独立验收：本计划只负责消除 Electron 专属机制并保持当前浏览器功能；另一个计划负责新的服务选择、登录和业务档适配。共享前端入口有顺序依赖，不能让两名执行者同时改 `web/src/main.ts`、`web/src/App.vue`、`web/src/services/platform.ts` 等文件。

## 修改方式决断

| 维度 | 破坏性移除（用户已选择） | 直接更新 |
| --- | --- | --- |
| 界面体验 | 只留浏览器入口，无原生窗或 Electron 专属菜单 | 旧应用仍可运行，两套入口易让用户误认仍受支持 |
| 实现及验证成本 | 一次清除入口、桥接、打包与引用，浏览器回归后代码更少 | 保持分支、打包及双端测试，旧路径仍消耗维护成本 |
| 数据及配置 | 不触碰后端会话和数据库；浏览器已有 localStorage 配置保留，Electron 本机私有窗口几何不能直接当作浏览器布局迁移 | 本机 Electron 配置自然留存，但必须长期维护其迁移/同步 |
| 长期演进 | 前端只维护浏览器部署与测试 | 需明确 Electron 退出时间并清理遗留入口 |

**用户选择：破坏性移除。** 不留 Electron 旧入口、兼容桥或构建路径；此决定不授权删除业务数据或后端管理器。浏览器端能力必须继续可用。若某项原生能力没有同等浏览器方案，先核查业务目标和现有后端/浏览器入口，再删除仅依赖 Electron 的操作，不能静默损害必要流程。

## 当前实现及拆除边界

| 位置 | 现状与应检查的边界 |
| --- | --- |
| [`web/electron/`](../../../web/electron/) | 原生主进程、preload、全屏保护；只能在其消费者迁出后删除。 |
| [`web/vite.config.ts`](../../../web/vite.config.ts)、[`web/package.json`](../../../web/package.json)、[根 `package.json`](../../../package.json) | Electron 插件、构建、开发、发布脚本与依赖；保留浏览器 Vite 构建及后端独立构建。联查 `web/electron-builder.yml`、`web/electron-diag.mjs` 和 `scripts/pack-electron.mjs` 等发布入口。 |
| [`web/src/main.ts`](../../../web/src/main.ts)、[`web/src/App.vue`](../../../web/src/App.vue) | 当前将浏览器和原生 `surface` 分支混在同一入口；只删除 `surface=...` 原生分支，浏览器的 CyberDesktopHost、窗模型、工作台等不得误删。此处与登录优先计划的 D/E 共用，先由本计划清理、后由它改启动顺序。 |
| [`web/src/services/platform.ts`](../../../web/src/services/platform.ts)、[`web/src/features/desktop/`](../../../web/src/features/desktop/) | preload 注入、原生目录选择、窗口桥与浏览器 fallback 混用。保留同源/远端/子路径 HTTP/WS 地址构造、浏览器桌面窗及浏览器可用的替代入口。 |
| [`web/src/features/`](../../../web/src/features/)、[`web/src/domain/shell/`](../../../web/src/domain/shell/) | PetStage、NyxusCore、AgentDialog、设置、工作台、历史、任务中心等既有原生窗条件分支。逐项检查是否有浏览器消费者，不能整目录删除。 |
| [`docs/frontend/`](../../frontend/)、[`docs/shared/`](../../shared/)、[`docs/guides/`](../../guides/) | 原生窗及部署、操作、验证引用；稳定事实须在所属文档 owner 同步，而不能只在计划里记录“将删除”。中转/后端管理器文档中的 Windows 托盘仍可存在。 |

## 可并行与必须串行的工作

1. 本计划的 Electron 专属文件、依赖与发布入口盘点/清理，可以与登录优先计划的 A/B（现状核验、能力契约）和 C（后端）并行；两边不要同时维护同一共享协议或测试文件。
2. 本计划的共享前端清理（`main.ts`、`App.vue`、`platform.ts`、业务组件条件分支）及其文档、最终回归**先于**登录优先计划的 D/E/F；若 D 已开始修改共享前端文件，先停下并重新确定文件归属，不在冲突工作区里叠加删除。
3. R1–R5 的浏览器旧功能回归完成后，登录优先计划接管浏览器入口。否则另一任务改变入口后，本任务对“移除 Electron 时浏览器旧功能仍在”的验证将失去独立判断依据。两计划各自维护恢复检查点、验证及用户审批，不能相互代替；用户批准删除计划目录不是共享代码交接的必要条件。
4. [独立后端与中转网关计划](../relay-gateway/README.md)的 H 综合验证仍含 Electron 人工项和构建项；这些验证在移除 Electron 后失效。R1 核对影响，R4 与该计划 owner 协调按其计划规范重建受影响的验证清单和操作卡，不能把已失效的旧结论照搬为通过，也不删后端/relay 的有效检查。

## 批次台账

未开始的批次只在此登记；将执行时按[计划交接规范](../../standards/documentation/plans.md#21-从规划到实施的交接)创建该批未完成小任务文档、核对实际使用处及冲突文件。复杂度为任务风险而非模型映射；每批执行前向用户报告复杂度及建议能力，由用户确认具体 Agent 或模型。

| 批次 | 工作与完成条件 | 状态 | 复杂度及依据 | 依赖 |
| --- | --- | --- | --- | --- |
| R1 | 核验已完成：`App.vue` 的浏览器窗口、Pet/Nyxus/AgentDialog 的浏览器分支及服务端目录浏览保留；仅原生窗、IPC、打包和专属测试可删除。本次按源码检索 `desktopBridge/isElectron/pickDirectory` 和构建脚本；已找到原生专用窗、跨窗口同步、通知分支及其浏览器入口。 | 已完成 | **4**：横跨入口、组件、打包与文档，误删风险高。 | 源码定位已完成 |
| R2 | 原生主进程/preload/打包脚本与构建入口已删除，根和 Web 包已去掉专属命令和声明；共享源码、锁文件和共用测试在 R3 一并清理后统一核查。 | 已完成 | **4**：构建配置和发布脚本跨根与 Web 包，需核对真正消费者。 | R1 |
| [R3](R3-browser-entry.md) | 收敛共享前端：移除原生 `surface`、桥与 native 分支；把由桥打开的操作映射到现有浏览器窗/页面，检查目录选择、系统反馈和返回行为。完成：浏览器登录、工作台、设置、会话、历史、桌面、任务中心、终端路径均可达；无残留 Electron 类型引用。 | 已完成 | **5**：主入口和大量页面的状态/导航、订阅影响广。 | R1/R2 |
| R4 | 同步权威文档和验证入口：更新前端导航、平台/部署/登录/桌面/窗口等 owner，清除当前事实中的原生说明与失效链接；长期验证不再包含 Electron 人工项。完成：从文档入口能找到浏览器唯一方案，现行事实与代码一致。 | 已完成 | **3**：跨文档归属与链接校验，有较广引用面。 | R3 |
| R5 | 综合验证与用户验收：自动执行受影响的类型检查、测试、构建、脚本/依赖引用扫描、文档检查；用户按 ≤1 分钟操作卡核对浏览器必要交互。自动回归仍有已记录失败，用户人工浏览器回归已完成；待修正自动项和锁文件校验后再申请最终审批。 | 进行中 | **4**：浏览器全入口回归与依赖/测试结果归因较广。 | R1–R4 |

## 验收重点和恢复检查点

- 删除仅服务 Electron 的二进制、打包脚本、构建插件、原生桥及 native 窗口入口；`web:build` 仍输出可部署的浏览器页面；无生产源码导入已删除模块。
- 浏览器内现有窗口管理、登录面板、会话输入、历史、设置、任务中心和工作台仍可用；后端、relay、本地管理器与其 Windows 托盘及系统服务不因 Electron 移除而消失。
- 用户数据（数据库、会话、历史）不迁移或删除；浏览器配置保持自己的存储位置，Electron 原生窗口几何不作为需要迁移的业务数据。
- 自动检查使用 `pnpm web:type-check`、`pnpm web:build`、`pnpm test:web`、`pnpm docs:test`、`pnpm docs:check` 和已确认的静态引用扫描；真实浏览器视觉交互由用户验收，不启动浏览器或读取图片。
- 2026-09-29 执行日志：用户确认先记录文档再剔除 Electron；沿用当前 Agent/模型。R1 已完成静态核验：浏览器 `App.vue` 的 `CyberDesktopHost`、`PetStage`、`NyxusCore`、`AgentDialog`、历史、设置、任务中心、终端仍有浏览器分支；`PresetsTab` 已有后端目录浏览入口。R2 已删除原生入口、打包及专属脚本；R3 正清理共用前端和桥，完成后统一校验锁文件与构建。`manager/`、管理器测试及后端运行指南已有他人未提交变更，须保留。登录优先 D/E/F 在 R5 自动及必要人工回归完成后接手。
- 当前恢复点：`web/src/` 的 Electron/native 标识静态检索无命中，浏览器入口已收敛；`pnpm-lock.yaml` 按既有锁定依赖图清理，在线重生成因镜像失败尚未完成。`web/node_modules/.bin/vue-tsc.cmd --noEmit -p web/tsconfig.json` 退出码 0；在 `web/` 执行 `node_modules/.bin/vite.cmd build` 退出码 0、输出 `dist/web`。根目录执行 `node_modules/.bin/vitest.cmd run --config web/vitest.config.ts --reporter=dot` 退出码 1：775 项中 738 通过、37 失败（日志 `C:/Users/chc/AppData/Local/Temp/opencode/remove-electron-web-tests.log`），包含原生窗断言与其他旧源码断言；已开始清理原生窗断言，尚待重跑归因。`node scripts/docs/check.mjs` 退出码 1：4 个既有缺失日志链接与 2 个旧计划入口；另两处本轮断链已修复。未进行人工浏览器验证，R5 不可移交。
- 后续定向核对：移除两个原生窗测试断言、更新设置可见性测试后，4 个相关测试文件仍有 7 项失败（日志 `C:/Users/chc/AppData/Local/Temp/opencode/remove-electron-focused.log`）；其中会话输入测试桩缺少现存 `useComposerMedia` 模块、登录状态机与节点树测试中的源码文本断言也不匹配。`node --test scripts/docs/tests/*.test.mjs` 退出码 0（7 项）；`node scripts/docs/check-links.mjs` 退出码 1，剩余 4 项均为其他计划的缺失 `verify/out/*.log`。下一步：核对本轮影响的失败并修正可维护的测试、复核前端权威文档中的旧原生窗口叙述、重新生成并校验依赖锁文件；R4 完成后再开启 R5 验证与用户人工操作卡。
- 2026-09-29 用户反馈：当前修改审核通过，浏览器必要人工回归已完成；允许记录自动回归尚有失败的情况下先提交恢复检查点并开始新版登录链路。此反馈只确认人工项，不将尚未解决的测试失败、锁文件重生成或 R5 自动项标记完成。登录计划接手共享前端文件是用户本次对先前严格交接顺序的明确调整；本计划保留未完成自动回归项，后续修正应与登录改动分别归因。
