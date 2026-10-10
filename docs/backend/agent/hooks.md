# Hooks 运行阶段契约

源码入口 [hooks/](../../../apps/backend/src/agent/hooks)，上级 [Agent](README.md)。本文唯一负责阶段、载荷、允许返回字段、执行顺序和结果应用。跨模块请求身份/请求视图、注册归属与包版本由 [统一宿主](../../shared/architecture/ingress-plugins.md) 定义，不在这里再建身份对象。

状态：阶段契约已实现并经通用宿主与QQ包定向离线测试覆盖；部署和用户验收尚未执行。

## 任务定位

| 修改意图 | 入口与关键符号 | 验证入口 |
| --- | --- | --- |
| 阶段输入与输出类型 | [types.ts](../../../apps/backend/src/agent/hooks/types.ts)：HookEvent、HookPayloadMap、HookDecisionMap | [dispatch.test.ts](../../../apps/backend/test/agent/hooks/dispatch.test.ts) |
| 调度与命令执行 | [dispatch.ts](../../../apps/backend/src/agent/hooks/dispatch.ts)：dispatch、runHandler、applyDecisionToPayload | 同上 |
| 函数注册与身份投影 | [functions.ts](../../../apps/backend/src/agent/hooks/functions.ts)、[decisions.ts](../../../apps/backend/src/agent/hooks/decisions.ts)、[request.ts](../../../apps/backend/src/agent/hooks/request.ts) | [ingressApi2.test.ts](../../../apps/backend/test/service/ingressApi2.test.ts)、[ingressRequest.test.ts](../../../apps/backend/test/service/ingressRequest.test.ts) |
| 命令配置、筛选与加载 | [registry.ts](../../../apps/backend/src/agent/hooks/registry.ts)：loadHookRegistry；[matcher.ts](../../../apps/backend/src/agent/hooks/matcher.ts)：matches、evalIf、expandCommandTemplate | [registry.test.ts](../../../apps/backend/test/agent/hooks/registry.test.ts)、[matcher.test.ts](../../../apps/backend/test/agent/hooks/matcher.test.ts) |
| 请求上下文与响应结果 | [chat.ts](../../../apps/backend/src/agent/middleware/chat.ts)：prepareModelHistory、dispatchPostLLMResponse、dispatchStop | 现有dispatch测试 |
| 工具前后与固定安全检查 | [tool.ts](../../../apps/backend/src/agent/middleware/tool.ts)：doExecuteSense | [middleware测试目录](../../../apps/backend/test/agent/middleware) |
| 协议参数修改 | [protocolHook.ts](../../../apps/backend/src/agent/provider/protocolHook.ts) 供各 provider 在构造后 fetch 前调用 | [anthropic.test.ts](../../../apps/backend/test/agent/provider/anthropic.test.ts) |

## 阶段契约

当前命令全局在前、brain在后；返回字段Object.assign后置覆盖。shell/启动错误与超时抛ClassifiedError，非0/2退出、JSON解析失败记录后继续。runHandler未接收AbortSignal，也未给stdout/stderr设置收集上限。命令处理器有主进程权限，不是沙箱。

现行调度入口为 `dispatch`，命令入口为 `runCommand`；[`functions.ts`](../../../apps/backend/src/agent/hooks/functions.ts) 管理插件函数和身份投影，[`decisions.ts`](../../../apps/backend/src/agent/hooks/decisions.ts) 校验阶段返回字段，[`request.ts`](../../../apps/backend/src/agent/hooks/request.ts) 实施 `prepareRequest/finishRequest/endSession`，[`protocolHook.ts`](../../../apps/backend/src/agent/provider/protocolHook.ts) 供模型协议调用。当前拒绝直接阻止对应操作，只读事件失败仅记录，超时及取消隔离迟到返回。正式调用验证见 [`ingressApi2.test.ts`](../../../apps/backend/test/service/ingressApi2.test.ts)、[`ingressRequest.test.ts`](../../../apps/backend/test/service/ingressRequest.test.ts) 和模型/工具测试。

## 命令配置的保留部分

保留 `.chery/hooks/hooks.json` 按事件数组配置以及 brain 的相对 hooks 路径。条目使用 `command`、可选 `matcher`、`if`、`timeout`（秒）、`required?:boolean`。matcher仍为精确字符串/分隔集合/正则，if仍使用已有字段比较子集。注册表准备后局部发布，失败保留旧表；开始的处理器不重跑。

POSIX命令继续通过 [resolvePosixShell](../../../apps/backend/src/core/security/sandbox.ts) 解析：Linux/macOS使用sh；Windows依次探测PATH bash/sh、Git for Windows的bash及已有常见安装位置。不可用返回HOOK_SHELL_UNAVAILABLE；不改用cmd解释POSIX脚本。Windows子进程windowsHide=true。具体配置状态仍沿既有hooks.get与shellInfo，不在插件内部另造配置副本。

## 阶段定义

新增函数注册类型 `IngressHookRegistration<E>` 由公开宿主API导出并引用这里的HookPayloadMap/HookDecisionMap：`{event:E,priority?:number,required?:boolean,timeoutMs?:number,handler:(payload:Readonly<HookPayloadMap[E]>,ctx:IngressHookContext)=>void|HookDecisionMap[E]|Promise<void|HookDecisionMap[E]>}`。priority为[-1000,1000]整数、默认0，较小先执行；required默认true，timeoutMs默认10000、范围[1,30000]。command timeout继续秒单位、相同默认与上限。只读阶段默认required=false，但失败必须记录。

`IngressHookContext` 为 `{requestId?:string,inputId?:string,chatId?:string,brain:string,requestView?:Readonly<IngressRequestView>,signal:AbortSignal}`。RequestPrepare使用尚未带contexts的view，其余请求阶段使用同一冻结view；Session级可无requestId。subject按宿主授予的身份权限投影。命令stdin为 `{event,payload,ctx}` 的可序列化安全投影，不含AbortSignal、身份句柄、subject、秘密/header/认证材料；原始输入和工具参数只在相应阶段传给可信本地处理器，不写日志。函数与命令不得返回任意核心对象引用。

以下各行列出公开字段和唯一允许输出。RequestPrepare、ToolFailed、RequestCompleted、RequestFailed、RequestCancelled、ChannelSendResult 由请求与回执路径触发；其余现有事件按本表语义执行，不保留无限字段接口。

| 阶段 | payload字段 | output字段白名单与应用点 |
| --- | --- | --- |
| SessionStart | `{chatId,brain}` | `{additionalContext?:string}`，只用于本次请求准备，不写会话历史 |
| SessionEnd | `{chatId,reason:'user_stop'|'error'|'close'|'unknown'}` | 无；只读 |
| UserPromptSubmit | `{chatId,prompt,role:'user'|'role'|'subagent'}` | `{decision?:'block'|'allow',reason?,additionalContext?}`；新输入准备前，block拒绝该输入，不重复在每次工具循环调用 |
| RequestPrepare | `{requestId,inputId,chatId}`，配置/身份/工具从ctx.requestView取 | `{decision?:'block'|'allow',reason?,contexts?:Array<{key:string,content:string,configRevision:number}>}`；每新输入一次，owner由宿主补，QQ记忆在这里读取，循环复用 |
| PreLLMRequest | `{provider,model,url,thinking,stream,body}`，保留当前字段 | `{decision?:'block'|'allow',reason?,body?:Record<string,unknown>}`；所有模型协议在构造后fetch前调用，只修改协议参数，不重新生成身份/工具/记忆 |
| PostLLMResponse | `{provider,model,content,thinking?,thinkingBlocks?,senseCalls?}` | `{decision?:'block'|'allow',reason?}`；先应用拒绝再向工具/最终回答推进；不允许改工具名/调用/签名thinking blocks或悄悄改响应 |
| PreToolUse | `{name,args,chatId}` | `{decision?:'allow'|'deny'|'ask',updatedInput?:Record<string,unknown>,reason?}`；参数按序patch，全部后重检schema、可用性、路径、范围与精确参数授权；deny不执行，ask走现有审批（QQ无审批入口则拒绝） |
| PostToolUse | `{name,args,result:{content,hash?,replaced?},hash?,chatId}` | 无；只读已完成工具事实，不能用拒绝改写实际执行结果 |
| ToolFailed | `{name,chatId,operationId,status,errorCode}` | 无；只读，status取既有执行控制非成功终态，不带Error原文 |
| Stop | `{chatId,message,stopReason}` | 无；只读最终模型结束，不承诺强制继续或覆写取消 |
| PreCompact | `{chatId,tokenCount}` | `{decision?:'block'|'allow',reason?}`；压缩写入之前，block拒绝压缩 |
| PostCompact | `{chatId,summary,tokenCount}` | 无；只读压缩已提交事实 |
| RequestCompleted | `{requestId,inputId,chatId,completedAt}` | 无；只读核心请求完成，不等于QQ已送达 |
| RequestFailed | `{requestId,inputId,chatId,failedAt,errorCode}` | 无；只读失败，不触发自动重试 |
| RequestCancelled | `{requestId,inputId,chatId,cancelledAt,reasonCode}` | 无；只读取消，不继续模型循环 |
| ChannelSendResult | `{requestId,eventId,channel,status:'sent'|'unknown',terminal:boolean,recordedAt}` | 无；在可信渠道回执校验并持久化后，sent才表示渠道发送确认，不用核心RequestCompleted代替 |

未知输出字段一律拒绝，不通过类型断言默许。只读输出必须空对象/undefined；返回修改视为处理器失败，但不得撤销已发生业务事实。additionalContext/key/content须字符串，key非空最多100字符，reason为安全文案最多500字符；contexts总限由宿主请求视图规定。brain传实际已选择名称，不再调用处固定空字符串。

PreLLMRequest的body是完整候选body，但只允许更改以下协议参数：`thinking`、`reasoning`、`reasoning_effort`、`max_tokens`、`max_output_tokens`、`max_completion_tokens`、`temperature`、`top_p`、`top_k`、`stop`、`stop_sequences`。其他字段须与构造结果保持一致：messages/input/system/tools/tool_choice/model/stream以及安全身份不可改变；不改URL、认证header或provider。不同协议只接受它支持的字段与类型，协议适配器校验范围/模型限制，未知字段或错类型拒绝，不把上层动态上下文塞进此Hook。

### 顺序、合并和失败

1. 只使用已发布业务Hooks。插件按宿主依赖顺序及ID、插件内priority和注册序执行；然后全局命令按配置序，最后brain命令按配置序。brain不能覆盖拒绝。相同阶段保持稳定序，不并发修改。
2. block/deny一旦出现即为最终拒绝；可立即短路，不执行后续allow。ask不能覆盖deny；固定安全检查的deny优先于所有Hooks。上下文按实际执行顺序收集；合法参数patch按序作用于候选值，后续处理器读取前序候选，但不能篡改原请求view。
3. 必需处理器异常、非法输出、非零退出（除明确exit2拒绝）、超时、shell不可用都拒绝当前操作；可选处理器同类失败只记录安全code并继续。显式block/deny或exit2无论required取值均拒绝。命令空stdout等同无返回，非法非空JSON是失败，不默默忽略。
4. 请求signal、插件停用和处理器deadline传播AbortSignal；取消优先且不可恢复为allow。命令取消终止进程及已登记子进程，函数忽略signal不能让迟到结果生效；达到30000ms上限后不等待。stdout/stderr各最多256KiB，超过按失败处理，不无限收集；不把stderr原文当公开错误或完整写日志。
5. 观察只读完成/失败/取消/发送结果时，业务事实已经确定。观察失败只记安全诊断，不改成功为失败、不重新发QQ、不重复工具副作用。每requestId只有一个核心终态观察；实际发送可有多个eventId，同eventId同状态重复回执不重复观察；unknown经可信核实转sent可再记录一次，按宿主reportSendResult契约执行。
6. 安全校验与执行前再次检查由固定代码实施，不是可选插件。日志仅owner/event/requestId/终态/安全code/耗时，不记录消息、用户号、记忆、参数、模型Key、Cookie或原始Error。

## 验证边界

自动验证仅离线合成处理器和mock provider，无真实模型/QQ发送、浏览器、图片或界面操作；真实部署、真实QQ回执和用户验收另行执行。本文发布只检查文档。
