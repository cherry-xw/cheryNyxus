# H 综合验证与用户验收

**文档创建时间：** 2026-09-21T00:00:00+08:00

**状态：** 进行中

## 所属总任务

[`docs/plan/relay-gateway/README.md`](README.md)

## 复杂度

**复杂度：5**。原因：需要汇总跨进程、动态端口、认证、relay 子路径、Electron 和平台服务边界；真实环境验证不能由当前自动检查代替。

## 反馈回填槽

- H-A02/H-A03 最终重跑受工作区既有 `web/src/features/agent/settings/tabs/agent/PresetsTab.vue:493-512` 的 9 个 `TS2532` 阻塞。该文件在任务开始前已是未提交改动，本轮未修改；不在本任务内修复，保留给对应的 `presets-roles-merge` 任务处理。
- H-A13（跳过 `vue-tsc` 的 Vite 构建）退出码 0，只证明本轮前端/Electron 打包输入可被 Vite 处理，不能替代 H-A02/H-A03。

## 阶段一：自动验证清单

| 编号  | 目标                     | 命令                                                         | 退出码 | 关键断言行                                           | 日期与产物路径                     |
| ----- | ------------------------ | ------------------------------------------------------------ | ------ | ---------------------------------------------------- | ---------------------------------- |
| H-A01 | 后端类型检查             | `pnpm type-check`                                            | 0      | `tsc` 无错误                                         | 2026-09-21；`verify/out/H-A01.log` |
| H-A02 | Web 类型检查             | `pnpm web:type-check`                                        | 1      | 外部未提交 `PresetsTab.vue:493-512` 有 9 个 `TS2532` | 2026-09-21；`verify/out/H-A02.log` |
| H-A03 | Web 构建                 | `pnpm web:build`                                             | 1      | 同一外部 `PresetsTab.vue` 类型错误阻断构建           | 2026-09-21；`verify/out/H-A03.log` |
| H-A04 | Relay 类型检查           | `pnpm relay:type-check`                                      | 0      | relay TypeScript 无错误                              | 2026-09-21；`verify/out/H-A04.log` |
| H-A05 | Relay 协议测试           | `pnpm relay:test`                                            | 0      | 3 个测试文件、6 个测试通过                           | 2026-09-21；`verify/out/H-A05.log` |
| H-A06 | 管理器类型检查           | `pnpm manager:type-check`                                    | 0      | manager TypeScript 无错误                            | 2026-09-21；`verify/out/H-A06.log` |
| H-A07 | 管理器构建               | `pnpm manager:build`                                         | 0      | `manager/dist/index.js` 生成                         | 2026-09-21；`verify/out/H-A07.log` |
| H-A08 | Electron 资源静态扫描    | `node docs/plan/relay-gateway/verify/electron-resources.mjs` | 0      | 5 个源文件未发现后端运行时入口                       | 2026-09-21；`verify/out/H-A08.log` |
| H-A09 | 远程监听与认证回归       | `pnpm exec vitest run test/service/remoteListener.test.ts`   | 0      | 1 个测试文件、4 个测试通过                           | 2026-09-21；`verify/out/H-A09.log` |
| H-A10 | 管理器 API 回归          | `pnpm exec vitest run test/manager/server.test.ts`           | 0      | 1 个测试文件、1 个测试通过                           | 2026-09-21；`verify/out/H-A10.log` |
| H-A11 | 计划链接与状态检查       | `pnpm plan:lint`                                             | 0      | 总入口 6 项、计划目录 6 个，R1/R2 通过               | 2026-09-21；`verify/out/H-A11.log` |
| H-A12 | 差异空白检查             | `git diff --check`                                           | 0      | 无空白错误；仅有既有 CRLF 转换提示                   | 2026-09-21；`verify/out/H-A12.log` |
| H-A13 | 区分 Vite 输入是否可构建 | `pnpm --filter web exec vite build`                          | 0      | 7840 个模块构建，Electron main/preload 产物生成      | 2026-09-21；`verify/out/H-A13.log` |

真实公网 relay/rathole、Pocket ID、nginx 配置加载、Windows 托盘、Linux systemd、Electron 运行和跨设备连接不得在当前环境中用模拟结果替代；它们只在下面的人工卡中执行。

## 阶段二：人工验证清单

| 编号  | 目标                                  | 操作卡                                                                                                         | 结论         |
| ----- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------ |
| H-M01 | Windows 托盘无控制台窗口与入口        | [`verify/manual-final.md#A1-windows-管理器托盘`](verify/manual-final.md#A1-windows-管理器托盘)                 | 待补 fixture |
| H-M02 | Electron 不启动后端且可发现本地管理器 | [`verify/manual-final.md#A2-electron-连接入口`](verify/manual-final.md#A2-electron-连接入口)                   | 待补 fixture |
| H-M03 | 管理页面状态和敏感信息展示            | [`verify/manual-final.md#B1-管理页面状态可理解性`](verify/manual-final.md#B1-管理页面状态可理解性)             | 待补 fixture |
| H-M04 | 登录错误提示可理解                    | [`verify/manual-final.md#B2-登录失败与重试提示`](verify/manual-final.md#B2-登录失败与重试提示)                 | 待补 fixture |
| H-M05 | 浏览器/Electron 会话隔离              | [`verify/manual-final.md#C1-浏览器与-electron-会话隔离`](verify/manual-final.md#C1-浏览器与-electron-会话隔离) | 待补 fixture |
| H-M06 | 子路径键盘焦点和失败恢复              | [`verify/manual-final.md#C2-子路径键盘操作`](verify/manual-final.md#C2-子路径键盘操作)                         | 待补 fixture |
| H-M07 | 动态端口变化后的真实重连体验          | [`verify/manual-final.md#D1-动态端口重连体验`](verify/manual-final.md#D1-动态端口重连体验)                     | 待补 fixture |
| H-M08 | WebSocket 长连接性能体验              | [`verify/manual-final.md#D2-websocket-长连接体验`](verify/manual-final.md#D2-websocket-长连接体验)             | 待补 fixture |

## 抽样信任记录

待用户从自动清单随机抽查至少 1 条命令的退出码和关键断言行后填写。当前未执行，不能报告综合通过。
