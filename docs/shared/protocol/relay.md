# 中转设备控制与发现协议

本页是cheryNyxus Relay、Backend设备客户端和Web共同遵守的设备控制/发现契约。业务浏览器会话、证明和bootstrap唯一说明见[业务会话](browser-session.md)，Manager独立管理认证见[Manager认证](manager-auth.md)。实现不表示生产或真实Pocket验收通过。

## 版本与身份

控制版本为2，不接受旧结构或迁移。backendId为3–63个小写字母、数字和连字符，首尾为字母或数字。设备以受保护Ed25519私钥签署Relay短时单次挑战；首次登记持久绑定公钥指纹，同ID换钥拒绝，不自动继承授权。用户名密码只认证业务用户，不参与设备身份。

正式类型为`packages/protocol/src/relay.ts`，完整运行校验为`browserSession.ts`的`RelayHelloSchema`、`RelayControlMessageSchema`和`DeviceControlMessageSchema`。所有控制消息只接受JSON文本，未知字段/版本、非法时间、标识、私有地址拒绝。

## 控制顺序与租约

入口为`<publicBasePath>/control/backend`，公网必须WSS。

1. Relay发送challenge，包含protocolVersion、nonce、expiresAt。
2. Backend发送hello，包含backendId、displayName、Ed25519 SPKI公钥、signature、configVersion及http/websocket能力。
3. 签名原文由`relaySignaturePayload`生成：`cherynyxus-relay-v1`、nonce、backendId、protocolVersion、configVersion以LF连接，无末尾换行。
4. Relay登记身份、预留租约/双私有端口、串行发布全局rathole完整候选配置并确认控制监听，发送accepted。accepted包含leaseId、心跳与租约期限、配置版本和双服务名/token/loopback地址。此时不是业务online。
5. Backend受限写入客户端配置，启动其拥有的rathole进程，发送tunnel.applied及probe-only短时凭据。
6. Relay确认双私有监听及真实Backend认证探测，发送tunnel.ready并公布online。失败保持不可代理。rathole私有监听在客户端认证后创建，不能在accepted前等待它。
7. heartbeat/heartbeat_ack续租，租约失效或控制断开立即移除路由并撤销关联浏览器会话/WS。旧租约先删除映射并确认端口释放，再释放预留资源。

rathole服务端文件永远包含所有有效租约，每台恰好HTTP/WS两项；新增/删除一台不能覆盖其他设备。Noise固定对端公钥或TLS可信根/主机名必须显式配置。WSS不代替数据隧道加密。配置文件受限临时写入并原子替换；实际二进制热加载及真实流量须另验。Manager端口不进入隧道。设备客户端状态采用严格版本2摘要，携带instanceId、backendId、configVersion、desiredRevision/appliedRevision及更新时间；online必须已应用当前配置且有当前leaseId。Manager只读该摘要，过期、错误设备ID或与保存配置摘要不同都不能显示online或转送设备操作；保存不自动restart，也不spawn第二个rathole。

## 设备自助授权与政策

已签名设备控制连接允许以下操作，requestId为16–128字符不透明标识，仅作用于当前连接设备：

| 消息 | 输入 | 结果 |
| --- | --- | --- |
| binding.request | backendId、deviceFingerprint、requestedPermission=business | 短时申请、确认URL、设备摘要/指纹/期限 |
| binding.status / binding.cancel | bindingRequestId | 本设备申请状态；取消不撤销既有授权 |
| authorization.list | 无 | 本设备授权关系 |
| authorization.revoke | bindingId | 持久撤销、关闭关联WS、同步Backend |
| policy.get / policy.set | set提供publicDiscovery、remotePasswordEnabled | 持久政策及读回 |

Manager通过独立机器凭据调用本机Backend的`/api/machine/relay/binding`与`/api/machine/relay/operation`，不需要全局Relay管理员密钥。设备无法申请或撤销其他设备关系。Relay管理员接口可用于受控运维，不是普通所有者自助入口。

确认入口为`GET/POST <publicBasePath>/bindings/<requestId>`。GET不授权；未登录先通过业务Pocket认证，再显示当前issuer/sub、设备名/ID、指纹、期限和business范围。POST校验同源Origin/CSRF、申请状态和当前设备指纹，明确确认或取消。同用户重复确认读回既有结果，他人重复、过期、换钥拒绝。授权持久后通过authorizations.snapshot同步Backend；Backend受限落盘并更新运行授权再ACK。ACK未到禁止证明授权，控制断开不能使用旧磁盘授权离线放行。

## 浏览器发现和代理

| 路径 | 边界 |
| --- | --- |
| GET `/api/auth/capabilities` | 公开登录方式及预登录CSRF上下文，无秘密 |
| GET `/api/auth/oidc/start`、`callback` | 标准发现、授权码/state/PKCE/nonce/JWKS；业务Pocket独立于Manager |
| GET `/api/auth/me`、`/api/browser-session` | 服务器内存会话视图，无token |
| GET `/api/backends` | Pocket只列本人获准设备；匿名/密码只列公开在线设备 |
| GET `/api/backends/<backendId>` | 公开发现或本人授权后返回最小地址 |
| `/api/browser-session/*` | 密码、目标选择、刷新、退出和短时WS票据按业务会话契约 |

旧`/api/session/backend`路由Cookie入口已移除。浏览器不持Backend双token；Relay服务端内存持密码token，或按有效Pocket授权生成单aud Ed25519证明。每次HTTP/WS都重新核验会话、目标、在线/政策/授权，删除浏览器提供的认证/证明/转发头后注入服务器凭据。

HTTP仅允许`<publicBasePath>/backend/<backendId>/api/*`，禁止代理auth、browser-session、machine路径；WS仅允许对应`/ws`且须单次票据和完整Origin。编码分隔符、NUL、路径穿越拒绝。写HTTP要求同源Origin/CSRF。WS上游未就绪只能有界缓存，错误/撤销主动关闭，101不是业务成功证明。

## 错误、资源与日志

统一错误为`{error:{code,message,requestId,retryAfterSeconds?}}`，会话修订冲突可附revision。401身份无效/过期，403来源/CSRF/目标禁止，409修订/操作冲突，410设备离线/申请过期，429速率/容量限制，502/504上游失败/超时；不能靠message猜动作。代码与HTTP映射见`apps/relay/src/errors.ts`。

限制请求体、来源速率、控制/在线设备、全局/单设备WS、并发HTTP和上游超时。流式HTTP有背压和断开取消，WS有负载与队列上限。普通日志仅记录requestId、目标、路径类别、状态、耗时、失败类别；禁止密码、Cookie、认证头、OIDC code、票据、证明、私钥、隧道token、请求/响应正文。

## 实现与验证入口

| 修改意图 | 入口 | 验证 |
| --- | --- | --- |
| 控制/代理/确认页 | `apps/relay/src/server.ts` / createRelayService | `apps/relay/test/browserSessionLan.test.ts`、relay.test.ts |
| 身份/授权持久格式 | identityStore.ts、authorizationStore.ts | deviceIdentity.test.ts、authorizationStore.test.ts、sessionConcurrency.test.ts |
| 全局隧道与客户端 | ratholeLeaseManager.ts、client.ts、clientConfig.ts | client.test.ts；Backend `relayRatholeLan.test.ts` |
| 业务提供方验证 | oidc.ts / BusinessOidc | businessOidc.test.ts；真实Pocket单独验收 |

真实双设备隔离验证可通过`LOGIN_RATHOLE_BINARY=<已核验绝对路径> npm run test:protocol:backend`执行，用户/浏览器入口用LAN地址10.2.3.6。测试提供方和合成adapter只证明隔离边界，不能声明Pocket、生产TLS/前缀或用户界面通过。
