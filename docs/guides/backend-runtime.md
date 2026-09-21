# 独立后端运行

后端以独立 Node 进程运行，Electron 不再内置或启动它。开发环境可使用 `pnpm build` 后运行 `node dist/index.js`；正式环境由本地管理器或 Linux systemd 启动。

本地管理器默认监听 `127.0.0.1:39980`，后端停止时管理页面仍然可用。开放内网访问：在 `.chery/config.yaml` 的 `manager.host` 填写 `0.0.0.0` 或具体内网 IP（也可用环境变量 `CHERY_MANAGER_HOST`，优先级更高），启动时管理器会读取该配置；启动日志会打印带管理密钥的可点击地址 `http://<内网IP>:39980/?token=<密钥>`。内网访问的页面与全部 `/api/*` 都必须携带该密钥（URL `?token=` / `X-Chery-Manager-Token` 请求头 / 密钥 Cookie）；本机回环访问只读接口仍免密钥。管理器的启停与凭据接口始终要求当前密钥，不能通过 rathole 或公网访问。

### 管理密钥生命周期

- **持久化**：未设置 `CHERY_MANAGER_TOKEN` 时，密钥持久化到 `.chery/manager-token.json`（0600），重启后保持不变，收藏的访问 URL 不会失效。
- **轮换**：密钥创建超过 **7 天**后，下次启动时自动轮换为新密钥，旧密钥进入 24 小时宽限期（仍可读取状态、自动续期，不能执行控制操作）。
- **记忆与续期**：首次用 URL 打开页面时，密钥写入浏览器 localStorage，并从地址栏移除（用后即消失）；服务端对已认证请求响应续期头 `X-Chery-Manager-Token` 与密钥 Cookie，页面检测到变化会自动更新本地记录，刷新页面无需再带 URL 密钥。
- **安全注意**：密钥本来就明文打印在启动日志中；泄漏后的可用时长被限制在「轮换周期 + 宽限期 ≈ 8 天」以内。

### 局域网访问安全警告

开放内网访问（监听非回环地址）时，管理页面顶部显示醒目的危险警告：同网段任意设备均可访问管理页，管理密钥是唯一保护，可查看 / 修改后端登录凭据、启停后端与中转；启动日志同步输出警告。建议仅在受信任网络使用，使用后把 `manager.host` 改回 `127.0.0.1`。

管理器还提供凭据查看和轮换入口：`GET /api/credentials` 与 `POST /api/credentials/rotate`。两者都要求管理控制密钥（本机或内网访问均须携带）；凭据文件位于 `.chery/manager-credentials.json`，非 Windows 使用 `0600`，后端 `config.yaml` 只保存 scrypt 哈希。轮换后：后端若是管理器子进程则自动重启；否则不拉起会因端口占用崩溃的副本，交由后端自身的配置监听器自动重载新凭据（通常 1 秒内）。管理器随后用新凭据对后端做登录自检，页面按结果提示「已确认生效 / 后端不可达 / 未确认需手动重启」，并引导用新用户名/密码重新登录。若用户直接编辑配置导致哈希与凭据文件不一致，页面会显示不一致状态。

`GET /api/status` 和 `GET /api/connection` 会分别显示管理器、后端和 rathole 状态。后端运行状态由管理器自行探测：探测 `config.yaml` 的 `server.port`（默认 8182）端口可连接即视为运行中；若后端设置了 `CHERY_BACKEND_STATUS_FILE`，管理器还会并入其写入的监听地址与非敏感 Agent 统计摘要（初始化会话数、运行中会话数、活跃运行数），不包含密码、token 或私钥。管理页面按行显示各进程状态（后端 / 中转 rathole / 中继 relay），后端运行中时给出可点击的访问地址。

管理器命令行入口在构建后运行 `node manager/dist/index.js <命令>`，也可使用 `pnpm manager:cli <命令>`：

```text
info                         显示连接发现信息
status                       显示管理器、后端和 rathole 状态
restart [backend|rathole]   重启指定进程，需要 CHERY_MANAGER_TOKEN
service install              安装当前平台的本地服务入口
service uninstall            卸载当前平台的本地服务入口
```

Linux 的安装命令写入用户级 systemd；Windows 的安装命令注册登录启动任务并运行独立托盘脚本。Electron 不参与上述进程管理。真实开机启动、自动恢复、托盘交互和跨设备连接属于 H 的人工验收。
