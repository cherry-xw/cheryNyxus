# 设置热更新与运行任务连续性验收记录

本记录只保留可复核事实与最终人工验收脚本。自动化用例必须使用隔离配置、临时数据库、mock LLM/MCP 和可控命令，不得操作用户的真实会话、密钥或后台进程。

## 已有自动化证据

截至 2026-09-06，设置生效状态、跨窗口修订冲突、草稿保留、Hooks/环境刷新、节点树边界、MCP 交接和后台进程阻止重启均已有定向自动化覆盖。B5 的代码验证记录为：设置 Web 定向 9/9、配置链路 31/31、Web 协议 8/8、`pnpm build:all` 通过；Web 全量为 546/547，唯一失败是既有 SFC 行数预算，不能视作本次功能失败的替代证据。

## 第 12 项阶段验证（2026-09-06）

平台：Windows，Node 22.23.0，Vitest 4.1.9。此次新增 [workerContinuity.test.ts](../../../test/service/config/workerContinuity.test.ts)，通过 `src/index.ts --worker` 启动真实独立进程；临时 CHERY_DIR、DB_DIR、HTTP 模型服务与两个 RPC 连接均由测试管理，结束后关闭并清理。

运行命令：`node node_modules/vitest/vitest.mjs run test/service/config/workerContinuity.test.ts`，1/1 通过。该命令直接使用仓库依赖入口，避免当前沙箱中部分 `pnpm exec` shim 无法解析的问题。

已断言：无变化保存成功；收到首段流后修改连接参数；worker 不退出且未发送 restart-ready；两个连接均未重连且仍可查询；旧版本保存返回 baseRevision 过期；另一连接收到生效通知；首轮所有流事件保持同一 runId；首次消息只有一条 user 和一条 assistant，内容连续完整；纪元 ID 与纪元数量不变；第二轮 HTTP 请求实际改用新 URL 和测试密钥；通知及 worker 输出不包含测试密钥。

23:33 本轮脱敏证据：PID `18420`，runId `70dd4f26-3888-410e-9dc2-6e403e2b62b1`，epochId `52597974-c06b-4cc5-ac00-d956862782dd`；连接数 2，模型请求数 2，首次运行消息数 2，restart-ready 次数 0。PID 属于已结束的临时测试进程。

| 检查 | 实际结果 |
|---|---|
| `pnpm test:all` | 后端阶段 1305 通过、2 跳过、2 失败；串联的 Web/协议未运行，随后分别补跑 |
| 新测试加入后的后端全量：`node node_modules/vitest/vitest.mjs run --reporter=dot` | 161 文件，1306 通过、2 跳过、2 失败；失败与首次一致 |
| `pnpm test:web` | 546/547；BrainCard.vue 835 行和 ServerLoginDialog.vue 1132 行超过 800 行预算 |
| `pnpm test:protocol` | 后端 435/435，Web 8/8，通过 |
| `pnpm build:all` | 前后端类型检查、后端/Web/Electron 构建全部通过；存在非阻断的大 chunk 警告 |
| `pnpm lint` | 通过；0 errors、4 warnings |
| `pnpm --filter web lint` | 通过；0 errors、19 warnings。Vue 表单允许修改父级响应式草稿的深层字段，但仍禁止直接替换 prop |
| 新测试 ESLint、Prettier 和 `git diff --check` | 通过；未跟踪的新测试另外执行了 ESLint/Prettier |

后端失败分离：`test/web/approvalSurfaces.test.ts` 仍读取已不存在的 `PendingOperationsPanel.vue`，属于已有基线问题；`test/core/security/sandbox.test.ts` 的 Windows ACL 用例在外层沙箱内返回 127，在获准的沙箱外单独重跑为 4/4 通过，不能据此宣称沙箱内全量已通过。

Electron 包此前缺少二进制，默认下载源在沙箱内外均失败；使用仓库 packConfig 指定的 `https://npmmirror.com/mirrors/electron/` 后下载成功。当前会话没有 browser 技能所需的浏览器控制工具；恢复 Electron 二进制不代表已完成 Electron UI 验收。

全局 lint 的既有 CRLF 与 Vue 草稿误报已经修复；本测试只证明上述 HTTP LLM 和双 RPC 连接事实，不能替代浏览器/Electron 双窗口操作，也没有证明非幂等工具、真实 MCP 混合交接、cron、待审批多层树与硬重启整套场景。第 12 项仍未完成，不能进入 72/72 或待用户审批。

## 最终人工验收场景

| 场景 | 入口和环境 | 操作 | 预期结果 | 证据 |
|---|---|---|---|---|
| 普通运行参数 | 两个浏览器设置窗口，隔离 worker | 在窗口 A 修改日志或连接参数并保存 | 显示已保存和逐项生效状态；PID、WS 和活跃 runId 保持；窗口 B 刷新状态但不覆盖草稿 | 设置状态截图、worker 日志、runId |
| 流式请求 | mock LLM 持续流输出 | 流式响应中保存连接参数 | 当前请求不重放、不重复写入消息或工具结果；后续请求采用新参数 | 消息记录、请求日志 |
| 节点树语义变更 | 含提问/审批/子任务的隔离根树 | 修改角色、预设或感官组并保存 | 显示等待受影响节点树；现有树按旧配置继续，安全边界后才采用新配置 | 状态截图、纪元与任务记录 |
| MCP 交接 | mock HTTP 与 stdio MCP | 运行中修改单个 server 并保存；分别模拟新连接成功/失败 | 只影响目标 server；失败保留旧连接；旧调用可结束；stdio 等待安全边界 | MCP 状态、调用日志 |
| Hooks 与计划任务 | 可观测 hook/cron 命令 | 保存 Hooks 或计划配置 | 只在后续 dispatch/调度采用；不重启 worker、不二次触发已开始维护任务 | 命令次数、状态截图 |
| 环境密钥 | 占位符引用的测试变量 | 轮换、删除并刷新 `.env` | 后续 LLM/媒体/MCP 采用新解析值；秘密不出现在通知或日志；进程绑定变量显示重启待办 | 脱敏日志、状态截图 |
| 跨窗口冲突 | 两个设置窗口 | 同时基于同一版本保存不同草稿 | 先提交者成功，后提交者收到 revision 过期；草稿保留并可重新读取核对 | 两窗口截图 |
| 进程级重启 | 可控后台 shell 进程 | 修改端口/认证初始化等进程级项并保存 | 显示 blocker 和重启待办；进程结束后才可重启；外部进程不被透明恢复 | blocker 状态、进程日志 |
| 维护模式恢复 | 损坏的隔离配置副本 | 启动维护 worker，修复并保存有效配置 | 普通 Agent 在维护期间不可运行；设置修复通道可用；修复后只在需要时重启 | 维护状态、备份文件名 |

## 尚待执行

- 浏览器自动截图和真实 Electron 双窗口操作。
- 上表全部人工场景及混合变更、长任务连续性回归。
- 修复既有全量基线失败后重新执行完整检查；当前阶段的实际结果已记录于上文。
