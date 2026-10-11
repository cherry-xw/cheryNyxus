# CheryNyxus Docker 入口

本目录提供唯一 Backend 与独立 Web、Manager 的部署文件，不定义独立 Runtime QQPlugin 服务，不部署或修改 NapCat。

操作、持久化、LAN 监听、健康检查、迁移回滚和旧服务退出的唯一说明见[运行环境迁移](../docs/guides/nyxus-deployment.md)。组件边界见[QQ 架构](../docs/shared/architecture/qqbot-platform.md)。

入口为 `compose.yaml`。Web、Manager 属于 `management` profile；默认允许 LAN 监听，Backend 默认为 `QQ_INGRESS_PAUSED=1`。启动不自动安装或启用 QQ 包，安装须显式维护。不能用容器健康代替 QQ 在线或生产验收。

定向检查：`pnpm manager:test`；构建和合成容器恢复步骤见指南。秘密与实际数据不入版本控制。
