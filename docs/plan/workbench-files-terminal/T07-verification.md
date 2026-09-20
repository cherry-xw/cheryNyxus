# T07 综合验证与用户验收

**文档创建时间：** 2026-09-19T17:20:00+08:00

**状态：** 执行中。复杂度 5：涉及三种输入界面、工作区路径、SSH 认证、本机伪终端和桌面分发。

## 反馈回填槽

| 编号 | 事实与剩余动作 | 状态 |
| --- | --- | --- |
| F01 | 用户报告的 `pnpm dev` 因 `ssh2 → cpu-features` 打包失败：Terminal 改为运行时加载；后端 SSR 构建已验证。 | 已修正 |
| F02 | Windows node-pty 1.1.0 关闭本机 PTY 时，辅助进程报 `AttachConsole failed`；输入输出和会话归属断言通过，但原生进程清理不能标为完成。官方开放问题 [952](https://github.com/microsoft/node-pty/issues/952)、[965](https://github.com/microsoft/node-pty/issues/965)。保持正式版依赖，未修改第三方代码、未屏蔽错误。 | 待解决 |
| F03 | 全量后端协议测试 8 个套件初始化失败，原因是 `test/protocol-completeness/fixtures/.chery/config.yaml` 缺失；定向响应契约与前端协议测试可执行。不得读取用户真实配置补测试。 | 测试环境待补 |
| F04 | [人工清单](verify/manual-final.md) 未执行。项目禁止自动浏览器/Electron 界面操作，未用 DOM/CSS 检查代替验收。 | 待人工验收 |
| F05 | Terminal 独立依赖通过随包 Node 加载检查；本机 PTY 输出验证成功，但该直接验证进程在 Shell 退出后仍存活，已按精确 PID 停止自建验证进程。完整安装包与外部 SSH 主机未验证。 | 部分验证 |

## 自动清单

| 编号 | 目标 | 命令 | 退出码 | 关键断言行 | 日期与产物 |
| --- | --- | --- | --- | --- | --- |
| A01 | 后端类型 | `pnpm type-check` | 0 | 通过，无类型错误 | 2026-09-19；终端记录 |
| A02 | 前端类型 | `pnpm web:type-check` | 0 | 通过，vue-tsc 无错误 | 2026-09-19；[日志](verify/out/web-type-check.log) |
| A03 | 后端构建 | `pnpm exec vite build --ssr --mode dev` | 0 | 通过，703 modules transformed；SQLite 旧库占用时保留根副本 | 2026-09-19；[日志](verify/out/backend-build.log)、`dist/index.js` |
| A04 | 前端与 Electron 入口构建 | `pnpm --filter web exec vite build` | 0 | 通过，5706 modules transformed；仍有包体积提示 | 2026-09-19；[日志](verify/out/web-build.log)、`dist/web`、`web/dist-electron` |
| A05 | 文件与 Terminal | `pnpm exec vitest run test/service/workspace/files.test.ts test/service/terminal/manager.test.ts` | 0 | 19 项断言通过；F02 的 stderr 仍存在 | 2026-09-19；[日志](verify/out/service-tests.log) |
| A06 | 文件输入、相机和模块依赖 | `pnpm exec vitest run --config web/vitest.config.ts web/test/workbench/fileReferences.test.ts web/test/nyxus/canvas/treeCanvas.test.ts web/test/architecture/dependencyBoundaries.test.ts` | 0 | 通过，22 tests passed | 2026-09-19；定向测试终端记录 |
| A07 | 响应结束后输入区状态 | `pnpm exec vitest run --config web/vitest.config.ts web/test/workbench/composerTurnState.test.ts` | 0 | 通过，4 tests passed | 2026-09-19；定向测试终端记录 |
| A08 | 响应字段契约 | `pnpm exec vitest run --config vitest.protocol.config.ts test/protocol-completeness/contract/responseParameterMatrix.test.ts` | 0 | 通过，207 tests passed | 2026-09-19；协议测试终端记录 |
| A09 | 前端协议 | `pnpm test:protocol:web` | 0 | 通过，8 tests passed | 2026-09-19；协议测试终端记录 |
| A10 | 桌面 Terminal 运行依赖 | `node scripts/prepare-terminal-runtime.mjs` | 0 | 通过，Node 22.11.0 可加载 ssh2/node-pty | 2026-09-19；`build/terminal-runtime` |
| A11 | 随包 Node 的本机 Shell | Node 22.11.0 + 独立 node-pty 执行 `Write-Output NYXUS_PACKAGED_PTY` | 未自然退出 | 输出验证 true，Shell exit 0；验证进程需停止，见 F05 | 2026-09-19；终端记录 |
| A12 | 全量后端协议 | `pnpm test:protocol:backend` | 1 | 8 suites 初始化失败；已运行 373 断言无失败；见 F03 | 2026-09-19；此前终端记录 |

## 人工清单

唯一执行入口为 [verify/manual-final.md](verify/manual-final.md)。未完成 F02–F05 前保持“待综合验证”。
