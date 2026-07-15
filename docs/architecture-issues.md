# 架构问题（待决项）

> 已修复项（07-12 起陆续解决：失败语义 success:false、前端错误可见、结构化 attachments、上传/认证 httpUrl、媒体展示/播放 httpUrl、config thinking→on 等）已移除。本文件仅列**仍待处理**的问题。

## 仍待处理

### 前端类型检查

- **问题卡关闭方法缺失**：`QuestionCard.vue` 在四个提交/取消路径调用 `agents.dismissQuestion(chatId)`，但 agents store 未公开该方法，导致 `vue-tsc` 报 4 处 `TS2339`。
- **思考档位枚举过期**：`RoleConfigPopover.vue` 的 `THINKING_LABEL` 包含已不存在的 `thinking` 键；当前 `ThinkingLevel` 不接受该键，导致 `TS2353`。
- **历史项更新类型不完整**：`agents/index.ts` 用展开的可选历史项回写 `stream.history[idx]`，`role` 被推断为可选，与 `HistoryItem` 的必填 `role` 不兼容，导致 `TS2322`。

### 运行与验证

- **video/audio 输入能力**：`media:{}` 仍为空，且无 brain 声明 `capabilities.input.video/audio`，因此当前实例尚不能接收视频/音频。配置并启用对应 media 网关后可走文本转写降级；原生输入仍需实际支持该协议的 brain。
- **端到端测试**：test 模块当前整体推迟（见项目约定），协议兼容性兜底暂靠 TSC + 手测。
