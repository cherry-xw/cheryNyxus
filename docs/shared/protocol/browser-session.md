# 业务浏览器会话与启动契约

公开登录发现使用PublicAuthCapabilitiesSchema，布尔方式、服务角色与有界CSRF字段strict校验，不猜默认能力。Web选择bootstrap与websocket域的最高共同版本（当前均为1）；relay控制范围仅为诊断，不限制直连。票据连接携带protocolVersion、bootstrapVersion、instanceId、capabilityRevision，Backend在消费票据前校验选择与当前实例/能力绑定；Relay保留选择及Lite查询参数并按完整上游路径签证明。QQ独立通道与机器连接不强加Web协商。bootstrap范围子对象strict且上限65535；必需域无交集拒绝启动。software按backend/relay域提供有界版本/buildId，仅排障，不作为相等准入条件。


本页是Backend、Relay和Web共同遵守的正式契约；不授予Manager管理权限。实现入口为`packages/protocol/src/browserSession.ts`和`bootstrap.ts`。生产及人工验收与代码实现分别判断。

## 身份与会话

浏览器仅持同源HttpOnly、SameSite=Lax的不透明随机Cookie，HTTPS设置Secure、不设置Domain；业务会话存在服务器内存，服务重启要求重登。设备身份与授权关系独立持久化。机器凭据只接受当前独立版本，旧格式明确拒绝且不迁移、不改写；设备身份文件只接受严格版本与Ed25519私钥，使用受限文件与不覆盖已有身份的原子发布。控制消息使用正式schema验证后才能更新本机授权。挑战、握手、租约、心跳、授权ACK、设备操作及结果均严格校验版本、字段、期限和标识；私有映射只允许loopback地址，未知字段和消息拒绝。设备控制断开立即停止该目标代理并撤销关联浏览器连接，不等待定时扫描。设备已签名控制通道提供申请、取消、申请状态、授权列表/撤销及政策保存/读回，仅作用于连接身份的设备；Manager通过独立机器HTTP入口转送，不需要全局Relay管理密钥。授权先持久保存、运行更新后ACK，断开控制通道停止证明授权并关闭对应WS。Manager使用自己的Cookie、机器认证和另外的Pocket配置，不参加业务会话广播。

GET `/api/browser-session`返回经过验证的会话视图，不返回access/refresh token、密码或用户证明。公开capabilities提供短时预登录CSRF上下文。所有响应no-store；写操作要求完整Origin与配置的公开origin相等、JSON Content-Type及绑定上下文的CSRF header。Cookie与显示状态不是离线授权。

| 请求 | 输入及结果 |
| --- | --- |
| POST `/api/browser-session/password` | username、password、可选backendId、expectedRevision、operationId；成功轮换会话ID |
| PUT `/api/browser-session/target` | backendId、expectedRevision、operationId；Pocket仅能选择获准目标，密码不可跨设备继承 |
| POST `/api/browser-session/refresh` | expectedRevision、operationId；成功原子更新期限和修订 |
| DELETE `/api/browser-session` | expectedRevision、operationId；撤销当前浏览器并关闭关联WS |
| POST `/api/browser-session/ws-ticket` | expectedRevision、可选backendId；票据30秒、单次、绑定会话/目标/修订 |

修订为正整数；过期写返回SESSION_REVISION_CONFLICT。同operationId仅同会话、同操作、同请求摘要幂等，内容不同返回OPERATION_CONFLICT。摘要不包含可恢复的明文密码，操作记录不保存请求秘密。未知写入先读回，不自动重复副作用。

用户证明固定Ed25519标准JWS，固定受信issuer与kid、公钥，不接受请求提供的JWKS地址。aud为唯一backendId；有效期不超过60秒，包含iat/nbf/exp/jti、sessionId、authorizationId、authorizationRevision及business权限，验证算法、受众、时效、重放与请求绑定。Pocket与密码使用相同业务权限计算，不可因此进入Manager。撤销必须关闭关联WS，不能仅等待证明过期。

## 全页签与恢复

localStorage仅保存版本、修订、状态与安全目标/显示摘要，不保存秘密。摘要启动恢复严格验证同源地址、受控路径和版本；switching、signed-out及locked通知立即停止旧连接，不能在操作未完成时读回旧会话使其复活。敏感发送前校对当前摘要与会话目标/修订。BroadcastChannel和storage仅通知变化；接收者必须重新读取服务器会话。Web Locks减少并发，服务器修订才是最终裁决。切换先停止旧发送/订阅；跨目标清pending，迟到响应不能修改新目标。离线退出立即锁定，但未确认服务器撤销时不能声称退出已生效。

## bootstrap

受保护config携带protocolVersion=1、instanceId、revision、basic/full preset、有效capabilities及protocolRanges。chat.core、interaction.respond、timeline.read为必需；未知可选能力忽略，未知版本、缺必需能力、逆序协议范围及重复能力拒绝。实例重启改变instanceId；实际能力变化改变revision。

基础档保留会话、交互、已提交历史；可选入口timeline.graph、task.overview、workspace.files、terminal.session、settings.manage、media.attach按有效能力开放。禁用显式RPC返回CAPABILITY_DISABLED，不能仅隐藏页面；共同内部执行和持久化不停止、不删除历史。两档首屏均不读取可编辑config.get与工具设置目录；完整档配置应用和任务概览订阅仅在对应页面打开时启动，关闭时停止。切换身份/目标清除会话、审批、概览、展示配置及窗口中引用的旧目标ID；同目标网络重连保留权威游标并重新读取快照。

验证入口：共享协议测试、Backend认证/路由测试、Relay会话及证明测试、Web身份与恢复测试。真实Pocket、rathole双设备流量、TLS/前缀和界面仍需独立环境验收。
