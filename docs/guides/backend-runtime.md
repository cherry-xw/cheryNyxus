# 独立后端运行

后端以独立 Node 进程运行，Electron 不再内置或启动它。开发环境可使用 `pnpm build` 后运行 `node dist/index.js`；正式环境由本地管理器或 Linux systemd 启动。

本地管理器固定监听 `127.0.0.1:39980`，后端停止时管理页面仍然可用。管理器的启停 API 必须带 `X-Chery-Manager-Token`，不能通过 rathole 或公网访问。
