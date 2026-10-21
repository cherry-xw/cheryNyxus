# 中转连接模式

首次入口为[PreloadRoot](../../apps/web/src/PreloadRoot.vue)与[PreloadLoginShell](../../apps/web/src/features/auth/PreloadLoginShell.vue)。认证状态由[auth store](../../apps/web/src/stores/auth.ts)唯一维护，HTTP适配为[BrowserSessionApi](../../apps/web/src/services/browserSession.ts)。正式身份与接口见[业务会话](../shared/protocol/browser-session.md)及[中转协议](../shared/protocol/relay.md)，不在本文重复字段。

## 用户流程

1. 在当前同源业务入口检查服务；普通直连不要求Backend ID。异源目标先导航到该目标同源工作台，不能跨域发送旧凭据。
2. 根据真实capabilities显示密码、Pocket或本机信任方式。本机信任由实际来源确认，不能由输入localhost冒充。
3. Pocket可无ID发起登录，Relay回调建立目标为空的内存会话；重新读身份与本人设备，空列表显示绑定指引，错误与空列表分开。
4. 选择获准设备后通过CAS更新目标，读取并校验bootstrap、取得单次票据、连接WS及chat.list业务读回，成功后才动态加载App。
5. 密码在同源POST提交给服务器适配层，直连/Relay服务器内存持双token；Web不存密码、Bearer、Pocket token或用户证明。

## 同浏览器与恢复

所有页签共享安全目标摘要、唯一身份和目标，通过BroadcastChannel/storage通知后核验服务器；Web Locks减少同源并发，服务器CAS最终裁决。切换/退出先锁定旧目标、关闭WS和清缓存，不重发旧pending；旧socket与迟到请求响应不得写入新目标。相同目标断线重取bootstrap及快照，不自动重复未知写入。资源加载失败可重新加载，不要求重复密码登录。

## 验证

行为测试见`apps/web/test/auth/activeConnection.test.ts`、`browserSessionSync.test.ts`、WS生命周期测试和Backend/Relay LAN测试。真实Pocket、浏览器多页签/子路径/视觉及生产部署须用户独立验收；接口存在、类型/构建通过和health不能替代业务往返。
