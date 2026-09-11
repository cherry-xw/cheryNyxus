import type { WorkflowStepKind } from '@chery/protocol'

export type HeaderPort = 'left' | 'right' | 'top' | 'bottom'
export type HeaderPoint = { x: number; y: number }
export interface HeaderTemplateNode {
  id: string
  group: string
  title: string
  position: HeaderPoint
  width: number
  height: number
  shape: 'step' | 'condition' | 'note'
  kinds: WorkflowStepKind[]
  detail: string
  match?: 'response' | 'rejection' | 'wait' | 'unobserved'
}
export interface HeaderTemplateEdge {
  id: string
  source: string
  target: string
  label?: string
  role: 'flow' | 'condition' | 'retry' | 'loop' | 'compact' | 'collaboration' | 'supply'
  sourcePort: HeaderPort
  targetPort: HeaderPort
  sourceOffset?: number
  targetOffset?: number
}
export interface HeaderLayer {
  id: string
  title: string
  parent?: string
  child?: string
  before: string[]
  after: string[][]
  center?: string[]
}
export const HEADER_NODE_SIZE = { width: 176, height: 88 } as const
export const HEADER_LAYERS: readonly HeaderLayer[] = [
  { id: 'loop', title: '循环调度', child: 'record', before: ['entry'], after: [['decision'], ['wait'], ['result']] },
  { id: 'record', title: '内容记录', parent: 'loop', child: 'tools', before: ['input', 'command'], after: [['checkpoint']] },
  { id: 'tools', title: '工具处理', parent: 'record', child: 'retry-layer', before: [], after: [['tool-list', 'validation', 'authorization', 'approval-needed', 'preflight', 'execution', 'tool-result'], ['resume', '', '', 'approval', '', '', 'rejection']] },
  { id: 'retry-layer', title: '重试控制', parent: 'tools', child: 'model-layer', before: [], after: [['error'], ['retry']] },
  { id: 'model-layer', title: '模型调用', parent: 'retry-layer', before: ['request'], center: ['model', 'channels'], after: [['response']] },
  { id: 'intake', title: '输入与资源', before: [], center: ['submission', 'queue', 'context', 'wake'], after: [] },
  { id: 'compact', title: '上下文压缩', before: [], center: ['compact-request', 'compact-summary', 'compact-applied'], after: [] },
  { id: 'collaboration', title: '任务协作', before: [], center: ['dispatch', 'child-run', 'child-return', 'parent-receive'], after: [] },
]
const n = (id: string, group: string, title: string, kinds: WorkflowStepKind[], detail: string, match?: HeaderTemplateNode['match']): HeaderTemplateNode => ({
  id, group, title, kinds, detail, match, position: { x: 0, y: 0 }, ...HEADER_NODE_SIZE,
  shape: match === 'unobserved' ? 'note' : ['decision', 'response', 'error', 'approval-needed'].includes(id) ? 'condition' : 'step',
})
const nodes = [
  n('entry', 'loop', '本轮入口', [], '每次 Loop 从这里进入完整中间件链；这是结构边界，没有独立步骤记录。', 'unobserved'),
  n('submission', 'intake', '输入接收', ['submission'], '已接收不等于已消费。'),
  n('queue', 'intake', '输入排队', ['queue'], '等待本轮消费的输入。'),
  n('context', 'intake', '上下文构建 / 恢复', ['context'], '角色、环境、记忆、技能和历史属于资源供给；细项没有独立事件。'),
  n('wake', 'intake', '实际唤醒', ['wake'], '仅实际唤醒事实代表继续；接收子结果不自动证明唤醒。'),
  n('input', 'record', '消费与输入记录', ['input'], '本轮实际消费的输入；等待回答按明确原因显示。'),
  n('command', 'record', '指令注入', ['command'], '有指令时注入，没有指令可直接进入内层。'),
  n('checkpoint', 'record', '内容记录', ['checkpoint'], '归集响应和工具结果；流式期间也可发生，不代表整个任务完成。'),
  n('request', 'model-layer', '请求准备', ['request'], '媒体、选项、消息转换和上下文守卫；这些细项不伪造独立运行态。'),
  n('model', 'model-layer', '模型请求与响应', ['model'], '展示当前运行、轮次与尝试的模型调用。'),
  n('response', 'model-layer', '响应分流', ['model'], '文本、摘要和工具调用可交错流回外层。', 'response'),
  n('channels', 'model-layer', '文本 / 摘要 / 工具', [], '通道可交错到达，不是三个串行执行步骤。', 'unobserved'),
  n('error', 'retry-layer', '错误判断', ['model', 'retry'], '仅实际失败证据；可恢复进入退避，不可恢复或耗尽才结束运行。', 'rejection'),
  n('retry', 'retry-layer', '退避与重试', ['retry'], '再次尝试只重新进入模型层，不重跑外层输入或整个 Loop。'),
  n('tool-list', 'tools', '调用清单', ['tool-list'], '同名调用按 callId 隔离；清单顺序不是执行依赖。'),
  n('validation', 'tools', '参数校验', ['tool-validation'], '当前调用的参数校验。'),
  n('authorization', 'tools', '权限校验', ['tool-authorization'], '当前调用的权限和安全策略。'),
  n('approval-needed', 'tools', '是否需要审批', [], '条件分支，没有独立事件时不推断已通过。', 'unobserved'),
  n('approval', 'tools', '等待审批', ['tool-approval'], '批准后仍须执行前检查；拒绝不执行。'),
  n('preflight', 'tools', '执行前检查', ['tool-preflight'], '包含执行前守卫及适用的再次授权。'),
  n('execution', 'tools', '执行工具', ['tool-execution'], '当前查看调用的真实执行。'),
  n('tool-result', 'tools', '工具结果', ['tool-result'], '成功、失败或拒绝结果按调用隔离。'),
  n('rejection', 'tools', '拒绝 / 失败结果', ['tool-validation', 'tool-authorization', 'tool-approval', 'tool-preflight', 'tool-execution'], '收集适用的失败或拒绝，不等待所有来源，也不表示后续步骤已执行。', 'rejection'),
  n('resume', 'tools', '工具续接', [], '重建待执行调用并经过适用校验、授权及审批；本次跳过模型。', 'unobserved'),
  n('decision', 'loop', '继续判断', ['loop-decision'], '按真实控制事实选择下一轮、等待或结束。'),
  n('wait', 'loop', '等待输入 / 子任务', ['loop-decision', 'input'], '仅明确等待回答或子任务事实。', 'wait'),
  n('result', 'loop', '运行结束', ['result'], '成功、失败、暂停或取消只读取真实控制事实。'),
  n('compact-request', 'compact', '压缩请求', ['compact-request'], '提出压缩请求，尚未采用摘要。'),
  n('compact-summary', 'compact', '生成摘要', ['compact-summary'], '生成摘要不代表采用。'),
  n('compact-applied', 'compact', '实际采用', ['compact-applied'], '采用事实才改变上下文阶段。'),
  n('dispatch', 'collaboration', '派发子任务', ['dispatch'], '派发不等于执行完成。'),
  n('child-run', 'collaboration', '子任务执行', ['child-run'], '子会话拥有独立执行身份，此处仅呈现协作摘要。'),
  n('child-return', 'collaboration', '结果回传', ['child-return'], '回传与父接收、唤醒分别判断。'),
  n('parent-receive', 'collaboration', '父流程接收', ['parent-receive'], '父流程可能仍在运行，不强制进入等待。'),
]
const e = (source: string, target: string, label?: string, role: HeaderTemplateEdge['role'] = 'flow'): HeaderTemplateEdge => ({
  id: `${source}:${target}`, source, target, label, role, sourcePort: 'right', targetPort: 'left',
})
const edges = [
  e('submission', 'queue'), e('queue', 'entry'), e('entry', 'input'),
  e('input', 'command', '有指令', 'condition'), e('command', 'request'), e('input', 'request', '无指令', 'condition'),
  e('context', 'request', '资源供给', 'supply'), e('request', 'model'), e('model', 'response'),
  e('model', 'channels', '交错通道', 'supply'), e('response', 'checkpoint', '文本 / 摘要', 'condition'),
  e('response', 'tool-list', '工具调用', 'condition'), e('model', 'error', '尝试失败', 'retry'),
  e('error', 'retry', '可恢复', 'retry'), e('retry', 'request', '再次尝试', 'retry'), e('error', 'result', '不可恢复 / 耗尽', 'retry'),
  e('tool-list', 'validation'), e('validation', 'authorization'), e('authorization', 'approval-needed'),
  e('approval-needed', 'approval', '需要', 'condition'), e('approval-needed', 'preflight', '无需', 'condition'),
  e('approval', 'preflight', '通过', 'condition'), e('preflight', 'execution'), e('execution', 'tool-result'),
  ...['validation', 'authorization', 'approval', 'preflight', 'execution'].map((id) => e(id, 'rejection', id === 'approval' ? '拒绝' : '失败', 'condition')),
  e('rejection', 'tool-result', '记录结果'), e('tool-result', 'checkpoint'), e('checkpoint', 'decision'),
  e('decision', 'entry', '下一轮', 'loop'), e('decision', 'wait', '等待', 'loop'), e('decision', 'result', '完成', 'condition'),
  e('wait', 'wake', '实际唤醒', 'loop'), e('wake', 'entry', '进入本轮', 'loop'),
  e('resume', 'tool-list', '重建调用'), e('resume', 'tool-result', '工具失效', 'condition'),
  e('execution', 'dispatch', '派发', 'collaboration'), e('dispatch', 'child-run', '子执行', 'collaboration'),
  e('child-run', 'child-return', '回传', 'collaboration'), e('child-return', 'parent-receive', '接收', 'collaboration'),
  e('parent-receive', 'wake', '明确唤醒', 'collaboration'), e('parent-receive', 'input', '实际消费', 'collaboration'),
  e('request', 'compact-request', '压缩请求', 'compact'), e('compact-request', 'compact-summary', '生成', 'compact'),
  e('compact-summary', 'compact-applied', '采用', 'compact'), e('compact-applied', 'request', '采用后准备', 'compact'),
]
export const WORKFLOW_HEADER_TEMPLATE = { version: 3 as const, nodes, edges, groups: HEADER_LAYERS, width: 3400, height: 1600 }
export function headerHandleId(type: 'in' | 'out', port: HeaderPort, offset = 0): string { return `${type}-${port}-${offset}` }
export interface HeaderNodePort { id: string; type: 'source' | 'target'; side: HeaderPort; offset: number }

