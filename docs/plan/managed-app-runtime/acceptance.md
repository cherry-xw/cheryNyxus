# 工作容器验收要求

> 待实施验收合同，不是通过记录。范围与授权见[任务入口](README.md)，技术及参数设计以[开发设计](design.md)为唯一来源。当前所有运行验证均为待执行。

## 1. 实施完成核对清单（进入测试前逐项确认）

- **真实身份与目录隔离**：业务主体 `principalKey`（如 QQ 真实个人号码 `subject.userId`）与插件包 `ownerId` 严格区分；无法确认真实个人 QQ 号时拒绝创建 `/qq/{QQ号}/apps/`；跨用户、跨应用、符号链接与路径穿越均被拦截。
- **全路径防绕过落地**：受管请求下 `execute_command`、`read_file`、`write_file`、`search_codebase`、`mcp__*`、`spawn_role`、`config_manage`、`install_skill` 已按[开发设计第 2.3 节](design.md#23-受管请求的全路径防绕过清单堵死回到-backend-本体的通道)收口，无法回到 Backend 本体执行命令或读取敏感凭据。
- **受限控制器与无特权容器**：Backend 不直接向模型暴露 Docker API；工作容器无 Docker socket、`--read-only`、`--user 1000:1000`、`--cap-drop ALL`、`no-new-privileges:true`。
- **全量硬配额可读回**：父级 `cherynyxus-apps.slice`（常态 `2 GiB` / 瞬时 `4 GiB`）、单容器常态 `200 MiB`、CPU、PID/线程、FD、磁盘字节与 inode 硬配额、Docker 日志轮转及专用隔离网络全部可从内核/系统接口读回真实生效值；任何一项无法强制限制时对应能力必须保持关闭。
- **固定模板断网可用**：一套 Vue + Express + SQLite 固定模板在 `--network none` 条件下可完成创建、构建、迁移与启动；前端 `APP_BASE`、独立鉴权、CSRF、附件与 SSE 均正常工作。

## 2. 自动化验证矩阵（A01–A20）

| 编号 | 场景 | 具体验证方法 | 可观察通过判据 |
| --- | --- | --- | --- |
| A01 | 越权与伪造身份拦截 | 1. 用用户 A 身份请求操作用户 B 的 `appId`；2. 用无真实个人 QQ 号的 OpenID 请求创建应用；3. 尝试在工具参数传入 `userId`、宿主机路径或容器 ID | 全部立即返回 `APP_ACCESS_DENIED`、`IDENTITY_REQUIRED` 或 schema 校验失败，无容器或目录副作用 |
| A02 | 路径穿越与符号链接逃逸 | 1. 传入 `../`、URL 编码路径、空字节；2. 在 `/workspace` 内创建指向宿主机 `/etc/passwd` 或其他用户目录的软链后通过文件工具和构建脚本读取；3. 访问 `/qq/{userId}/share/` 与 `/qq/{userId}/apps/{appId}/` 尝试读取 `/workspace` 源码或 `/data/app.sqlite` | 软链在挂载检核与文件工具 `O_NOFOLLOW` 下被拒绝；HTTP 请求无法直接下载源码与 `.sqlite` 文件 |
| A03 | 命令执行、超时、取消与进程树清理 | 1. 执行正常命令、非零退出命令、输出 1 MiB 文本命令；2. 执行 `sleep 999` 触发超时与手动 `task_cancel`；3. 执行后台脱离进程 `(sleep 999 &)` 后结束命令 | 分别准确返回 `completed`、`failed`、`timed_out`、`cancelled`；输出截断在 `256 KiB` 且带 `truncated: true`；任务结束后容器内无脱离的残留后台进程 |
| A04 | 全路径防绕过验证 | 在受管请求与子 Agent (`spawn_role`) 中尝试调用 `execute_command`、`read_file('/app/...')`、`write_file`、未授权 `mcp__*`、`config_manage` | 全部被策略层拦截，Backend 容器内无新增子进程、无法读取 `/app` 或环境变量秘密 |
| A05 | 单容器 200 MiB 与父级 2 GiB 硬限制 | 1. 读回 `/sys/fs/cgroup/.../cherynyxus-apps.slice/memory.max` 与 `memory.swap.max`；2. 单容器分配 250 MiB 内存；3. 多容器合计分配超过 2 GiB 内存 | `memory.max` 为 `2147483648`、`memory.swap.max` 为 `0`；单容器超 200 MiB 仅自身 OOM (`exitCode=137`)；多容器超 2 GiB 仅在 `cherynyxus-apps.slice` 内 OOM，`cherynyxus-backend-1` 与 `napcat` 零受影响 |
| A06 | 瞬时 4 GiB 队列与并发准入 | 1. 同时发起 3 个 `profile='build'` 构建任务；2. 在常态预算已满时请求新启动应用容器 | 同一时刻仅 1 个构建拿到瞬时票据（父级上限升至最高 `4 GiB`、该容器升至 `1.5 GiB`），其余排队；常态满额时新启动返回 `RESOURCE_BUDGET_EXCEEDED`，不关闭任何已运行容器 |
| A07 | 瞬时内存回落与未释放兜底 | 1. 构建正常结束且内存回落到 `<170 MiB`；2. 模拟构建后常驻进程仍占用 `600 MiB` 不释放 | 场景 1 在 5 秒内平滑将单容器降回 `200 MiB`、父级降回 `2 GiB`；场景 2 不直接盲降引发隐式 OOM，而是自动重启为干净运行态后再降回 `200 MiB / 2 GiB` |
| A08 | CPU、PID/线程与文件描述符限制 | 1. 执行 `:(){ :\|:& };:` fork 炸弹与创建 300 个线程；2. 循环打开 2000 个文件句柄；3. 跑满 CPU 循环 | 线程/进程在单容器 `128`（父级 `512`）处报错 `EAGAIN`；FD 在 `1024` 处报错 `EMFILE`；CPU 被限制在配额内，宿主机负载稳定 |
| A09 | 磁盘容量、inode 与删除未关句柄硬限制 | 1. 向 `/workspace` 或 `/data` 写入超过 `512 MiB` 数据；2. 创建超过 `20,000` 个小文件；3. 创建大文件后立即 `unlink` 但保持 FD 打开继续写入；4. 写 `/tmp` 超过 tmpfs 限额 | 全部由底层文件系统/tmpfs 实时返回 `ENOSPC` 或 `EDQUOT`，宿主机根分区可用空间不被穿破 |
| A10 | 磁盘 I/O 与网络隔离/限速 | 1. 读回父级 cgroup `io.max`；2. 从工作容器尝试访问 `cherynyxus-backend-1:8282`、`napcat:6099`、宿主机 `10.2.3.6`、`192.168.68.164`、另一工作容器 `:3000` | `io.max` 匹配设定阈值；所有对内部容器、宿主机、局域网与相邻工作容器的连接全部被拒绝或丢弃 |
| A11 | 固定模板断网构建与禁联网装包 | 1. 在完全断网容器中执行 `create` + `publish`；2. 尝试执行 `npm install lodash` 或修改 `package.json` 引入外部未内置依赖 | 断网下模板正常完成 Vite 构建与 Express 启动；安装外部包立即返回 `DEPENDENCY_NOT_IN_TEMPLATE` 且 `/opt/chery-app-template` 不可写 |
| A12 | 综合模板 6 类能力与安全基线 | 在同一模板应用中运行表单录入、SQLite 事务查询、ECharts 图表数据、CSV 导入导出（含 `=CMD()` 公式）、附件上传下载、SSE 后台任务、登录/注销/权限校验/CSRF | 功能全部跑通；无 CSRF Token 的写请求返回 `403`；CSV 恶意公式被安全转义；附件下载带 `Content-Disposition: attachment` |
| A13 | 统一路径 `/qq/{userId}/apps/{appId}/` 全链路 | 访问无尾斜杠地址、首页静态资源、前端路由子路径刷新、`/api/*`、Cookie `Path`、`/events` SSE 与 `/ws` WebSocket | 无尾斜杠 `308` 跳转；静态资源与 API 均命中当前应用前缀；SSE 不缓冲实时到达；WebSocket 校验 Origin 后双向通信正常 |
| A14 | 网关生命周期、防伪造头与停止状态页 | 1. 服务未通过 `/__app_health` 时访问外部 URL；2. 伪造 `X-Forwarded-User` / `X-Chery-Owner-Id` 请求网关；3. 停止应用后分别用浏览器 `Accept: text/html` 与 `Accept: application/json` 访问 | 未就绪不暴露路由；伪造头被网关剥离重写；停止后页面返回中文停止说明页（且不自动唤醒容器），API 返回 `503` JSON `APP_STOPPED` |
| A15 | 浏览器同源边界与管理会话隔离 | 检查应用响应头与 Cookie 作用域；在 D1 未启用独立子域名前尝试开启多租户不互信私密开关 | Manager/Backend 管理 Cookie 不泄露给应用路径；不互信多租户开关在路径模式下强制关闭并给出明确原因 |
| A16 | 租期、空闲停止、手动续期与周一 04:00 清理 | 1. 模拟 `/__app_health`、静态资源、SSE 心跳持续请求超过空闲阈值；2. 模拟用户调用 `renew`；3. 模拟周一 `04:00` 清理及宿主机在周一 `03:50–04:10` 关机重启后的补清理 | 心跳/健康检查不续命，按时触发空闲停止；`renew` 延长租期但不自动开机、不豁免周清理；重启补清理只停 `04:00` 前旧实例，不误杀 `04:10` 后新启动实例 |
| A17 | 到期通知 Outbox、去重与隐私保护 | 1. 触发 `T_24H`、`T_1H`、`STOPPED` 通知；2. 通知发出前调用 `renew`；3. 模拟投递返回 `unknown`；4. 在群聊创建应用后触发通知 | 续期后旧租期通知自动作废 (`superseded`)；`unknown` 状态标记为 `delivery_uncertain` 且不重复重发；群聊内不泄露含激活令牌的私密链接；通知失败不阻塞容器按时停止 |
| A18 | 主机压力保护线 | 模拟主机 `MemAvailable` 或磁盘可用空间低于保护线时发起新构建/新启动，并分别测试 D2 的默认模式（仅停构建）与可选紧急模式 | 立即冻结新启动与新构建；绝不触碰 `cherynyxus-backend-1`、`napcat`、`cherynyxus-manager-1` 等常驻服务及用户持久文件 |
| A19 | 容器销毁重建与一致性备份恢复 | 1. 写入数据库与上传附件后执行 `destroyAppContainer`，再重新 `publish`；2. 执行 `backup` 并在模拟损坏后从备份恢复 | 重建后代码、SQLite 数据与附件完整无损；`VACUUM INTO` 备份包可完整恢复 |
| A20 | 控制器重启对账与并发幂等 | 1. 并发发送 5 个相同 `create` / `publish` 请求；2. 在 `burst_running` 期间重启控制器与 Backend | 并发请求幂等无重复容器；重启后自动回收超时瞬时额度、父级 cgroup 恢复 `2 GiB`，仅管理带受管标签的容器，不误碰宿主机其他容器 |

## 3. 部署与真实环境验收步骤

1. **前置基线记录**：部署前记录 `cherynyxus-backend-1`、`cherynyxus-manager-1`、`napcat` 的镜像、状态及现有配置，确保 `.chery/`、登录态、白名单与用户文件零丢失。
2. **局域网/EasyTier 与公网双链路验证**：按服务器规范，禁止仅用 `127.0.0.1` 回环测试冒充完成；先通过 `10.2.3.6` 验证控制器、网关与 Manager 状态，再通过 `https://mini.xcherry.top/qq/{QQ号}/apps/{appId}/` 验证外部反代链路，同时核对 `/qq/{QQ号}/share/` 原有静态文件访问正常。
3. **常驻服务稳定性核对**：在运行应用构建与多容器并发测试期间，持续核对 Backend RPC、Manager 页面与 NapCat 在线状态正常。
4. **用户实机验收**：由用户本人通过真实对话创建、访问、修改、停止、续期与重启一个包含表单、SQLite 存储与图表的小应用；视觉渲染、页面交互与真实 QQ 消息体验由用户亲自确认，禁止 AI 启动浏览器截图或自动乱发测试 QQ 消息。

最终交付严格区分四项状态：**源码实现、自动化测试、实际部署生效、用户真实验收**。全部完成并获用户批准后，将稳定契约迁入正式模块文档并按规范收口计划。
