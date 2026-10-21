# 登录、发现与转发的跨端流程

本页描述源码当前装配，不声明生产全链路或真实Pocket/rathole验收通过。正式业务会话与bootstrap见[浏览器会话契约](../protocol/browser-session.md)，设备控制见[中转协议](../protocol/relay.md)，Manager独立认证见[Manager认证](../protocol/manager-auth.md)。rathole客户端独立配置新增protocolVersion=1；缺版本或旧字段拒绝，不迁移。Manager可保存并脱敏读回客户端文件、业务密码与业务档，Backend拥有客户端生命周期；配置保存不代表运行就绪。

## 身份边界

Web业务登录调用同源`/api/browser-session`，Cookie是随机HttpOnly内存会话；Backend双token只保存在服务器内存，不在Web localStorage。Web保存安全目标摘要，各页签通过BroadcastChannel/storage通知后重新读取服务器会话。Manager不参与业务广播，使用独立管理账号及另外的Pocket。

Backend业务密码位于`server.auth.username/password`；Manager内部连接使用独立`server.auth.machine`，经`/api/machine/login`取得一分钟机器token，不能在业务认证入口授权。机器登录拒绝Origin、Cookie和转发来源，专用远程监听器拒绝机器登录。机器调用不复用业务会话；机器登录每来源每分钟最多600次，容量1000个来源，超限429；Manager每次有限RPC使用新一分钟凭据，正常配置页面的一次保存/读回包含多次独立机器认证。

Relay Pocket使用标准发现、state浏览器绑定、PKCE S256、nonce及JWKS签名验证；issuer保留完整路径。证明固定Ed25519 JWS与单Backend受众，Backend部署必须提供信任公钥与本机授权记录。密码与Pocket均返回同一业务身份权限，不获得Manager会话。

## 稳定入口与当前装配

| 修改意图 | 入口 / 符号 | 验证 |
| --- | --- | --- |
| 正式跨端校验 | packages/protocol/src/browserSession.ts、bootstrap.ts | apps/relay/test/loginContracts.test.ts |
| 直连Cookie、CSRF、CAS与WS票据 | apps/backend/src/service/auth/browserSessions.ts / DirectBrowserSessions | apps/backend/test/service/browserSessionLan.test.ts |
| 机器/业务密码分离 | apps/backend/src/service/auth/index.ts / OAuth2Auth；apps/manager/src/credentials.ts | Manager类型及认证边界测试 |
| Relay会话、目标、密码代理与证明 | apps/relay/src/browserSessions.ts / RelayBrowserSessions | Relay接口测试 |
| OIDC发现与校验 | apps/relay/src/oidc.ts / BusinessOidc | 负向OIDC及真实提供方验收 |
| 全局隧道快照 | apps/relay/src/ratholeLeaseManager.ts / RatholeLeaseManager | 多租约隔离；v0.5.0独立LAN热加载验证，整体未验 |
| Backend控制客户端生命周期 | apps/backend/src/service/relayLifecycle.ts / startBackendRelay | Backend启动与关闭；真实隧道未验 |
| 基础/完整业务档 | apps/backend/src/service/capabilities.ts / BackendCapabilities | apps/backend/test/service/businessCapabilities.test.ts |
| Web同源登录及恢复 | apps/web/src/stores/auth.ts、services/browserSession.ts、services/ws.ts | Web类型、登录及恢复测试 |

## 认证隔离

可选machine身份格式损坏仅封闭维护域，不阻断有效业务认证。没有userProof信任的密码设备清空授权是安全无操作，非空证明快照仍拒绝；proof已启用时撤销继续关闭失效连接。设备控制关闭回调的拒绝必须被捕获，不外溢为全局未处理拒绝。

## 当前失败与恢复边界

会话进程重启失效；服务端退出与目标修订改变关闭已索引WS。短时票据绑定会话、目标和修订，单次消费。Web明确disconnect清pending和游标，旧socket响应不能进入新连接；未知写入不自动重发。

bootstrap由服务装配提供，基础档拒绝可选显式RPC和媒体上传，共同Agent执行/时间线/审批不关闭；资源降低必须有真实计数，不能由按钮隐藏推导。

Relay设备注册和隧道ready分开。全局快照保留其他租约；部署配置启用加密传输后先发布完整配置并确认rathole控制监听，接收客户端应用结果后确认双私有监听并执行认证探测，不能以health代替业务往返。rathole v0.5.0已完成独立Noise NK、LAN双设备四服务、文件热加载增删与端口释放验证，证据位于任务scratch的rathole-isolated.log；另有`apps/backend/test/protocol-completeness/scenarios/relayRatholeLan.test.ts`通过10.2.3.6完成真实Relay/rathole/双Backend密码HTTP与chat.list WS往返、撤设备会话失效及另一设备保持可用；不是Pocket、生产部署或浏览器验收。Backend使用`CHERY_RELAY_CLIENT_CONFIG_FILE`独立配置，拥有客户端启动与关闭。

设备控制连接可申请本设备绑定；确认页面显示当前Pocket账号、设备、指纹、期限和业务权限，POST核验Origin/CSRF及当前设备指纹。设备控制可取消申请、读回授权与政策、撤销本设备授权；Manager通过本机机器认证转送并提供控件。授权持久保存与Backend运行更新后ACK；撤销关闭Relay和Backend已关联WS，控制断开也清运行授权。Manager业务配置页保存业务密码哈希、业务档与公开origin/前缀，也可配置专用远程监听和固定Relay证明issuer/backendId/Ed25519公钥；读回不含密码，授权关系只由设备控制同步，重启后生效。整体验证仍以实施任务状态判断，不从独立测试推导完成。
