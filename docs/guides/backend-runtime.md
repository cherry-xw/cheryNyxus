# 独立后端运行

后端以独立 Node 进程运行，Electron 不再内置或启动它。开发环境可使用 `pnpm build` 后运行 `node dist/index.js`；正式环境由本地管理器或 Linux systemd 启动。

本地管理器固定监听 `127.0.0.1:39980`，后端停止时管理页面仍然可用。管理器的启停 API 必须带 `X-Chery-Manager-Token`，不能通过 rathole 或公网访问。

管理器还提供凭据查看和轮换入口：`GET /api/credentials` 与 `POST /api/credentials/rotate`。两者都只接受本机请求并要求管理控制密钥；凭据文件位于 `.chery/manager-credentials.json`，非 Windows 使用 `0600`，后端 `config.yaml` 只保存 scrypt 哈希。轮换后管理器会重启后端；若用户直接编辑配置导致哈希与凭据文件不一致，页面会显示不一致状态。

`GET /api/status` 和 `GET /api/connection` 会分别显示管理器、后端和 rathole 状态；后端状态摘要还包含初始化会话数、运行中会话数和活跃运行数，不包含密码、token 或私钥。

管理器命令行入口在构建后运行 `node manager/dist/index.js <命令>`，也可使用 `pnpm manager:cli <命令>`：

```text
info                         显示连接发现信息
status                       显示管理器、后端和 rathole 状态
restart [backend|rathole]   重启指定进程，需要 CHERY_MANAGER_TOKEN
service install              安装当前平台的本地服务入口
service uninstall            卸载当前平台的本地服务入口
```

Linux 的安装命令写入用户级 systemd；Windows 的安装命令注册登录启动任务并运行独立托盘脚本。Electron 不参与上述进程管理。真实开机启动、自动恢复、托盘交互和跨设备连接属于 H 的人工验收。
