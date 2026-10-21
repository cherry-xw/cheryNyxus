# 独立后端与中转部署

部署与初始化的认证和隧道职责见[跨端流程](../shared/architecture/authentication-flows.md)。本文只提供单端构建入口，不授权自动发布。

公网主机运行Relay与外部管理的rathole server；本地Backend设备客户端拥有rathole client，Manager独立管理登录，不另启动隧道副本。浏览器是业务入口，不使用Electron。

Relay使用服务端随机内存会话，重启失效；不需要旧RELAY_SESSION_SECRET，不接受旧签名Cookie。部署者必须提供真实RELAY_PUBLIC_ORIGIN、持久设备身份与授权文件，加密rathole transport及需要时的Pocket/证明配置，不能猜凭据。

构建入口：npm run relay:build、npm run manager:build、npm exec -- vite build --config apps/manager/vite.config.ts --ssr。Manager认证配置与首次创建见[Manager认证](../shared/protocol/manager-auth.md)。CLI机器密钥不授权浏览器，也不授权业务账号或任意资源代理。

公共HTTP/WS前缀、Cookie Path与回调应一致；rathole私有映射及Manager机器入口不能公开。真实Pocket、TLS、Windows托盘、systemd和生产代理由部署者按环境验证；自动测试与构建不等于部署或验收。
