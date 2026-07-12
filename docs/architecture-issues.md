• 结论：当前状态不能支撑可靠的完整交互，文本链路已实质失效，图文视频链路也未达到可用条件。

  核心原因：

  - 文本请求确实到达后端并入库，但当前 ali_glm5 返回 401 invalid access token or token expired。
    日志可见 .chery/logs/2026-07-11.log:936 和 .chery/logs/2026-07-11.log:944。

  - 数据库最新三条消息全部是 user，没有任何 assistant 回复。
  - 后端把模型失败转成 error notification 后，仍继续发 done，最终 RPC 甚至记录为 success:true，
    见 src/agent/middleware/retry.ts:114、src/service/chat/streamMapper.ts:135 和 src/service/
    chat/send.ts:118。

  - 前端发送后没有等待最终 Response，web/src/stores/agents/index.ts:334 直接进入工作态；收到错误
    也只写 console.error，没有用户可见错误提示，见 web/src/stores/agents/index.ts:639。因此表现
    为“点击发送后毫无响应”。

  媒体方面：

  - WebSocket 的 chat.send 仍只有 {chatId, prompt:string}，没有结构化附件字段，docs/
    protocol.md:138。

  - 当前实现是先通过 HTTP 上传文件，再把 [[media:filename]] 文本标记塞入 prompt，并由媒体网关转
    换成文本理解结果；不是模型原生图像/视频消息。

  - 当前配置没有任何 media.image/video/audio
    网关，也没有已启用的媒体输入能力，所以现在图片、视频实际不可用。

  - 打包版 Electron 中媒体上传和认证仍使用相对 /api/...，在 file:// 下也存在直接失败风险，见
    web/src/services/agentApi.ts:357 和 web/src/App.vue:23。

  建议修复优先级：

  1. 立即更新 ali_glm5 密钥或切换到有效 brain，恢复基础文本调用。
  2. 模型调用失败必须产生最终 Response.success=false，不得随后发送 done/success。
  3. 前端必须处理 done Promise、显示可见错误状态，并解除“假工作中”状态。
  4. 将附件改成结构化协议，例如 attachments:[{assetId,kind,mimeType}]，不要继续依赖正文标记。
  5. 配置并验证图片/视频媒体网关、模型能力和 Electron HTTP 地址。
  6. 补齐端到端测试；当前类型检查通过，但选定协议/服务测试有 35 项失败，现有测试无法为协议兼容性
     兜底。

  本轮只进行了检查和诊断，没有修改现有代码。