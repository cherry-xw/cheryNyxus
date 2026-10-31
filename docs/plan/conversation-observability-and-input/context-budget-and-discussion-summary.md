# 上下文预算与讨论总结：已批准设计

## 范围与证据边界
基于此前生产只读证据、当前源码及本次获取的官方项目文档。没有部署、重放、模型生成调用。用户已批准实施并选择替换旧内部机制；本文是目标契约，不表示已实现。外部项目按检索时文档描述，不宣称完成源码级复现；OpenCode搜索索引与实时正文的默认值/恢复策略不一致，以下不据索引片段固定参数。pi文档与仓库同名文档对reserveTokens用途也有版本差异，以获取的官方参考页为主，落地前固定版本再验源码。

## 外部可借鉴原则
OpenCode使用摘要+最近上下文，保留原始持久消息，提供独立compaction事件与请求幂等；超限恢复有次数限制，固定指令/工具占满时不能靠压缩解决。[1]
Pi在新输入前及工具结果追加后检查最终上下文投影；用firstKeptEntryId持久记录保留边界，不在工具结果中间割裂调用关系；独立reserve与keep策略，并记录压缩失败事件。[2]
LangChain提供触发条件、保留范围和自定义计数器；提醒文本摘要不等于多媒体压缩。其trim_tokens_to_summarize可直接截短输入，不应原样照搬到本项目的历史完整性要求。[3]
Claude官方计数支持结构化输入但依然是估计，部分server tools、URL/file来源不支持；不能把官方预检描述为绝对准确或把失败视为0。[4] OpenAI Responses提供独立input_tokens端点，但不能据协议名称推定兼容站支持。[5]

## 实施约定
### 1 Backend唯一预算入口
每次模型调用前（新消息、工具续轮、问答/审批续接）统一prepareModelStep。固定身份/权限/配置版本和模型能力，生成一次实际请求投影，所有计量和压缩决定基于此投影。压缩成功后重建投影并重新验证。身份和审批状态来自持久安全契约，不能从摘要还原授权。

生成BudgetSnapshot：projectionId（受保护内部指纹，不公开内容）、model/protocol/configRevision、contextLimit/inputLimit/outputReserve、payloadBytes、measuredOrEstimatedInputTokens、measurementSource、mediaKnown、phase、各段组成、effectiveCeiling。显示和压缩消费同一快照，旧done用量应标“上一轮”，不能冒充本轮。

计数优先：同模型同端点同投影的受支持官方预检 -> 有明确模型映射的本地tokenizer -> 文本启发式估算。上轮usage仅供同模型且前缀可比较情况下校准，不直接当本轮计数；cache token按厂商契约归一，不无条件加总。媒体未知独立显示，URL/base64字节不转换成token。

保留32MiB字节保护。当前停止以UTF8字节上界直接判token超限仅是止血，不是容量管理完成。官方计数也可能有误差，仍需余量与实际provider拒绝分类。

### 2 不新增QQ容量阈值，复用现有Backend配置
保持brain.contextLimit与global.command.auto。概念触发上界为 min(现有配置阈值, 模型明确input上限减余量, contextLimit减输出保留与余量)，缺失项不参与min；不可机械给所有协议同时减两次输出。输入limit和总context必须区分，输出按本次请求与模型契约解析。先不改80%默认，不新增大批UI旋钮。

### 3 压缩成为独立受预算约束的维护操作
状态pending/running/completed/failed/cancelled，包含operationId、baseBoundary、throughMessageId、firstKeptMessageId、config/model快照和恢复信息。单会话single-flight，安全边界执行，不与工具副作用竞争。

保留原始历史；活跃投影为系统+验证摘要+最近完整消息组+本轮待处理输入。保持tool-call/result配对、待答题和审批引用；大单条结果先存artifact并提供可追溯投影，不静默截断原始证据。附件由独立媒体保留策略控制，沿用已授权规则，不擅删历史图片。

摘要输入也独立预算；过大时按完整消息组分块、分层合并，每块有覆盖水位和成功状态。只有所有需要的块成功后提交总边界；不以丢弃最旧消息伪装成功。固定提示词/工具/单条新输入已占满时明确拒绝并给出具体减量建议，不换模型不循环摘要。

提交前比较会话边界/版本；摘要与覆盖范围原子提交，保留之后入站内容。失败保持原边界。用户原任务不入队两次、不重跑工具，摘要是维护阶段而非最终回答。事件按started/completed/failed区分。

### 4 受控超限恢复
只处理provider已声明context overflow，非任意400/422或自然语言猜测；在无可见输出、无本次不确定执行证据时允许同模型步骤一次压缩恢复。已输出/未知server工具状态不自动重试。每步持久记录恢复次数，重启不重置；第二次仍超限明确失败。仅对新运行的安全步骤生效，禁止重放旧任务。

### 5 QQ讨论总结保留独立业务语义
保留讨论结束触发，不与容量auto阈值合并。独立保存summaryStatus、throughEventId、lastSummaryAt、phase/reason、attempt、nextAttemptAt；旧summary与正在生成的新summary分开。总结只覆盖快照水位；后来消息保持未覆盖。

群记忆提取失败不能静默跳过保留前置条件：分别记录memory/summary阶段。可以先生成候选摘要，但若长期记忆尚未保存就不提交会遗失唯一事实的历史替换；摘要展示与压缩边界提交可分离。恢复时按阶段继续，而不是每次从头重复全部生成。

总结操作不无限持有群执行busy。通过会话single-writer短提交锁、版本比较和合作式取消让新前台任务优先；取消仅维护任务不取消原用户任务，也不对普通任务擅加截止时间。无法取消时不允许旧摘要覆盖后来数据。

错误按稳定code分类：认证/配置/权限失败等待修复，安全可重试网络错误按退避；过预算改为分块任务，不每五分钟原样重复。管理页可见阶段/水位/成功时间，默认不往群里发摘要以免扰群，可另行决定提示。

## 实施优先级与验收
P0：统一请求预算快照与显示；移除字节冒充token残余路径；所有调用入口同检查；确认真实模型limit契约。
P1：独立摘要状态/预算/保留边界与原子提交，真实超限一次安全恢复；原任务/权限/工具去重。
P2：QQ总结阶段可恢复、覆盖水位、前台优先，细化失败与管理显示。

必须有真实组件离线回归：中文/ASCII等长差异；固定工具和群背景；未知媒体；官方计数不支持/误差/取消；新消息与工具结果骤增；待答/审批resume；摘要本身过大/部分块失败；摘要非合规答复；写库前后重启；总结期间新消息；失败不丢原历史；原任务单次续接与副作用不重放。检查展示快照与实际预算snapshotId一致，而非只断言各自数字“合理”。

## Sources

[1] https://opencode.ai/v2/docs/compaction
[2] https://pi.dev/docs/latest/compaction
[3] https://docs.langchain.com/oss/python/langchain/middleware/built-in
[4] https://platform.claude.com/docs/en/build-with-claude/token-counting
[5] https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens
