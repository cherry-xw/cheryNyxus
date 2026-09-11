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
  sourcePort: HeaderPort
  targetPort: HeaderPort
  label?: string
  role: 'flow' | 'condition' | 'retry' | 'loop' | 'compact' | 'collaboration' | 'supply'
  via: HeaderPoint[]
  sourceOffset?: number
  targetOffset?: number
  labelPoint?: HeaderPoint
}

const groups = [
  { id: 'intake', title: '输入接入', x: 40, y: 484, width: 1072, height: 190 },
  { id: 'request', title: '上下文与请求', x: 1120, y: 268, width: 280, height: 406 },
  { id: 'model', title: '模型与响应通道', x: 1408, y: 268, width: 584, height: 406 },
  { id: 'control', title: '记录与继续判断', x: 3664, y: 484, width: 824, height: 190 },
  { id: 'compact', title: '上下文压缩', x: 568, y: 88, width: 824, height: 152 },
  { id: 'tools', title: '共享工具处理链', x: 1672, y: 660, width: 1960, height: 896 },
  { id: 'collaboration', title: '等待与协作', x: 3664, y: 872, width: 824, height: 724 },
] as const

function step(
  id: string,
  group: string,
  title: string,
  x: number,
  y: number,
  kinds: WorkflowStepKind[],
  detail: string,
  extra: Partial<Pick<HeaderTemplateNode, 'shape' | 'match'>> = {},
): HeaderTemplateNode {
  return {
    id,
    group,
    title,
    position: { x, y },
    width: 184,
    height: id === 'rejection' ? 200 : 80,
    shape: 'step',
    kinds,
    detail,
    ...extra,
  }
}

const nodes: HeaderTemplateNode[] = [
  step(
    'submission',
    'intake',
    '输入接收',
    64,
    560,
    ['submission'],
    '外部输入已被接收，不表示已消费。',
  ),
  step(
    'queue',
    'intake',
    '输入排队',
    344,
    560,
    ['queue'],
    '输入进入队列，消费由明确的输入步骤记录。',
  ),
  step(
    'input',
    'intake',
    '消费与输入记录',
    624,
    560,
    ['input'],
    '消费并记录输入；等待回答也在此保留真实状态。',
  ),
  step('command', 'intake', '指令注入', 904, 560, ['command'], '本轮实际的指令注入边界。'),
  step(
    'context',
    'request',
    '上下文构建 / 恢复',
    1168,
    320,
    ['context'],
    '角色与环境、记忆、技能、有效历史是资源供给；这些细项未单独记录，不随上下文步骤一起高亮。',
  ),
  step(
    'request',
    'request',
    '请求准备',
    1168,
    560,
    ['request'],
    '媒体与选项、消息转换、上下文守卫属于请求内部说明，未单独记录。',
  ),
  step(
    'model',
    'model',
    '模型请求与响应',
    1456,
    560,
    ['model'],
    '按本次尝试的真实请求、等待模型、处理响应边界显示。',
  ),
  step(
    'retry',
    'model',
    '退避与重试',
    1456,
    320,
    ['retry'],
    '本次失败、内容撤回、退避、下次请求分别有证据才成立；重试不重演上下文。',
  ),
  step(
    'channels',
    'model',
    '文本 / 摘要 / 工具',
    1744,
    320,
    [],
    '文本、可用思考摘要和工具调用可交错到达，并非三个串行步骤。正文沿已有内容锚点读取。',
    { shape: 'note', match: 'unobserved' },
  ),
  step(
    'response',
    'model',
    '响应分流',
    1744,
    560,
    ['model'],
    '模型明确进入响应阶段后，文本或可用摘要进入记录，工具调用进入共享处理链。',
    { shape: 'condition', match: 'response' },
  ),
  step(
    'checkpoint',
    'control',
    '内容记录',
    3704,
    560,
    ['checkpoint'],
    '记录完成仅表示内容已记录，不代表任务完成。',
  ),
  step(
    'decision',
    'control',
    '继续判断',
    3984,
    560,
    ['loop-decision'],
    '下一轮、等待或完成由实际 Loop 决策决定，静态路径不表示已经执行。',
    { shape: 'condition' },
  ),
  step(
    'result',
    'control',
    '本轮结束',
    4264,
    560,
    ['result'],
    '只读取本轮真实结束事实，不由断线或暂时无新事件推断。',
  ),
  step(
    'compact-request',
    'compact',
    '压缩请求',
    600,
    140,
    ['compact-request'],
    '提出压缩请求，此时尚未采用新摘要。',
  ),
  step(
    'compact-summary',
    'compact',
    '生成摘要',
    880,
    140,
    ['compact-summary'],
    '摘要实际生成；不表示已替换有效上下文。',
  ),
  step(
    'compact-applied',
    'compact',
    '实际采用',
    1168,
    140,
    ['compact-applied'],
    '实际采用摘要后才改变上下文阶段，再进入请求。',
  ),
  step(
    'tool-list',
    'tools',
    '调用清单',
    1744,
    900,
    ['tool-list'],
    '全部调用列在下方；同名调用按身份隔离，只用所查看调用的证据驱动处理链。',
  ),
  step(
    'validation',
    'tools',
    '参数校验',
    2024,
    900,
    ['tool-validation'],
    '校验当前查看调用的参数。',
  ),
  step(
    'authorization',
    'tools',
    '权限校验',
    2304,
    900,
    ['tool-authorization'],
    '当前查看调用的安全策略和授权边界。',
  ),
  step(
    'approval-needed',
    'tools',
    '是否需要审批',
    2584,
    900,
    [],
    '需要审批进入等待；无需审批进入预检。当前协议未单独记录此判断，不从缺少审批推断无需审批。',
    { shape: 'condition', match: 'unobserved' },
  ),
  step(
    'approval',
    'tools',
    '等待审批',
    2584,
    1080,
    ['tool-approval'],
    '通过后仍须执行前检查；拒绝不会自动执行工具。',
  ),
  step(
    'preflight',
    'tools',
    '执行前检查',
    2864,
    900,
    ['tool-preflight'],
    '审批通过或工具续接仍须经过实际执行前检查。',
  ),
  step(
    'execution',
    'tools',
    '执行工具',
    3144,
    900,
    ['tool-execution'],
    '所查看调用的实际执行状态。',
  ),
  step(
    'tool-result',
    'tools',
    '工具结果',
    3424,
    900,
    ['tool-result'],
    '成功、拒绝、失败等结果按调用身份记录。',
  ),
  step(
    'rejection',
    'tools',
    '拒绝 / 失败结果',
    3424,
    1300,
    ['tool-validation', 'tool-authorization', 'tool-approval', 'tool-preflight', 'tool-execution'],
    '只展示当前调用真实的拒绝或失败边界；后续未发生步骤保持中性。',
    { match: 'rejection' },
  ),
  step(
    'resume',
    'tools',
    '工具续接',
    2864,
    700,
    [],
    '仅按明确续接状态进入已通过边界后的处理，不能绕过执行前检查。当前步骤协议未单独记录续接。',
    { match: 'unobserved' },
  ),
  step(
    'wait',
    'collaboration',
    '等待输入 / 子任务',
    3984,
    1460,
    ['loop-decision', 'input'],
    '只读取明确的等待回答或等待子任务状态；子任务回传本身不表示父流程正在等待。',
    { match: 'wait' },
  ),
  step(
    'wake',
    'collaboration',
    '实际唤醒',
    3704,
    1460,
    ['wake'],
    '只有父流程真实唤醒才显示继续，回传或接收不代替唤醒。',
  ),
  step(
    'dispatch',
    'collaboration',
    '派发子任务',
    3984,
    960,
    ['dispatch'],
    '派发成功不等于子任务执行完成。',
  ),
  step(
    'child-run',
    'collaboration',
    '子任务执行',
    4264,
    960,
    ['child-run'],
    '只显示该会话记录的协作执行证据，子 Agent 自身步骤仍在其简略头部。',
  ),
  step(
    'child-return',
    'collaboration',
    '结果回传',
    4264,
    1200,
    ['child-return'],
    '子任务实际回传，与父流程接收及继续分别记录。',
  ),
  step(
    'parent-receive',
    'collaboration',
    '父流程接收',
    3984,
    1200,
    ['parent-receive'],
    '接收到子结果；继续仍需真实唤醒事实。',
  ),
]

const labelPositions: Record<string, HeaderPoint> = {
  'model:retry': { x: 1548, y: 448 },
  'retry:model': { x: 1500, y: 520 },
  'model:channels': { x: 1752, y: 440 },
  'response:checkpoint': { x: 2400, y: 600 },
  'response:tool-list': { x: 1836, y: 780 },
  'approval:preflight': { x: 2840, y: 1120 },
  'validation:rejection': { x: 2220, y: 1460 },
  'authorization:rejection': { x: 2500, y: 1420 },
  'approval:rejection': { x: 2780, y: 1380 },
  'preflight:rejection': { x: 3110, y: 1340 },
  'execution:rejection': { x: 3376, y: 1260 },
  'decision:request': { x: 2680, y: 96 },
  'decision:wait': { x: 4336, y: 740 },
  'wake:input': { x: 2260, y: 1800 },
  'execution:dispatch': { x: 3420, y: 808 },
  'request:compact-request': { x: 892, y: 248 },
  'compact-applied:request': { x: 1368, y: 464 },
}

function edge(
  source: string,
  target: string,
  label?: string,
  role: HeaderTemplateEdge['role'] = 'flow',
  sourcePort: HeaderPort = 'right',
  targetPort: HeaderPort = 'left',
  via: Array<[number, number]> = [],
  routing: Pick<HeaderTemplateEdge, 'sourceOffset' | 'targetOffset' | 'labelPoint'> = {},
): HeaderTemplateEdge {
  return {
    id: `${source}:${target}`,
    source,
    target,
    label,
    role,
    sourcePort,
    targetPort,
    via: via.map(([x, y]) => ({ x, y })),
    labelPoint: labelPositions[`${source}:${target}`],
    ...routing,
  }
}

const edges: HeaderTemplateEdge[] = [
  edge('submission', 'queue', undefined, 'flow', 'right', 'left', []),
  edge('queue', 'input', undefined, 'flow', 'right', 'left', []),
  edge('input', 'command', undefined, 'flow', 'right', 'left', []),
  edge('command', 'request', undefined, 'flow', 'right', 'left', []),
  edge('context', 'request', '资源供给', 'supply', 'bottom', 'top', []),
  edge('request', 'model', undefined, 'flow', 'right', 'left', []),
  edge('model', 'response', undefined, 'flow', 'right', 'left', []),
  edge('model', 'retry', '尝试失败 / 撤回', 'retry', 'top', 'bottom', []),
  edge(
    'retry',
    'model',
    '下一次请求',
    'retry',
    'left',
    'top',
    [
      [1424, 360],
      [1424, 464],
      [1500, 464],
    ],
    { sourceOffset: 0, targetOffset: -48 },
  ),
  edge(
    'model',
    'channels',
    '可交错通道',
    'supply',
    'right',
    'bottom',
    [
      [1688, 580],
      [1688, 440],
      [1836, 440],
    ],
    { sourceOffset: -20, targetOffset: 0 },
  ),
  edge('response', 'checkpoint', '文本 / 摘要', 'condition', 'right', 'left', []),
  edge('response', 'tool-list', '工具调用', 'condition', 'bottom', 'top', []),
  edge('tool-list', 'validation', undefined, 'flow', 'right', 'left', []),
  edge('validation', 'authorization', undefined, 'flow', 'right', 'left', []),
  edge('authorization', 'approval-needed', undefined, 'flow', 'right', 'left', []),
  edge('approval-needed', 'approval', '需要', 'condition', 'bottom', 'top', []),
  edge('approval-needed', 'preflight', '无需', 'condition', 'right', 'left', []),
  edge('approval', 'preflight', '通过', 'condition', 'right', 'bottom', [[2908, 1120]], {
    sourceOffset: 0,
    targetOffset: -48,
  }),
  edge('approval', 'rejection', '拒绝', 'condition', 'bottom', 'left', [[2676, 1380]], {
    sourceOffset: 0,
    targetOffset: -20,
  }),
  edge('validation', 'rejection', '校验失败', 'condition', 'bottom', 'left', [[2116, 1460]], {
    sourceOffset: 0,
    targetOffset: 60,
  }),
  edge('authorization', 'rejection', '授权失败', 'condition', 'bottom', 'left', [[2396, 1420]], {
    sourceOffset: 0,
    targetOffset: 20,
  }),
  edge('preflight', 'rejection', '预检失败', 'condition', 'bottom', 'left', [[3004, 1340]], {
    sourceOffset: 48,
    targetOffset: -60,
  }),
  edge('preflight', 'execution', undefined, 'flow', 'right', 'left', []),
  edge('execution', 'tool-result', '执行结果', 'flow', 'right', 'left', []),
  edge('execution', 'rejection', '执行失败', 'condition', 'bottom', 'top', [
    [3236, 1260],
    [3516, 1260],
  ]),
  edge('rejection', 'tool-result', '记录拒绝 / 失败', 'flow', 'right', 'bottom', [
    [3640, 1400],
    [3640, 1040],
    [3516, 1040],
  ]),
  edge('tool-result', 'checkpoint', '记录工具结果', 'flow', 'right', 'bottom', [[3796, 940]]),
  edge('checkpoint', 'decision', undefined, 'flow', 'right', 'left', []),
  edge('decision', 'result', '完成', 'condition', 'right', 'left', []),
  edge(
    'decision',
    'request',
    '下一轮',
    'loop',
    'top',
    'left',
    [
      [4076, 96],
      [1136, 96],
      [1136, 620],
    ],
    { sourceOffset: 0, targetOffset: 20 },
  ),
  edge('decision', 'wait', '等待输入 / 子任务', 'loop', 'bottom', 'right', [
    [4076, 740],
    [4536, 740],
    [4536, 1500],
  ]),
  edge('wait', 'wake', '实际唤醒', 'loop', 'left', 'right', []),
  edge('wake', 'input', '消费新输入', 'loop', 'bottom', 'bottom', [
    [3796, 1800],
    [716, 1800],
  ]),
  edge('resume', 'preflight', '续接仍需预检', 'flow', 'bottom', 'top', []),
  edge('execution', 'dispatch', '派发', 'collaboration', 'top', 'top', [
    [3236, 808],
    [4076, 808],
  ]),
  edge('dispatch', 'child-run', '子执行', 'collaboration', 'right', 'left', []),
  edge('child-run', 'child-return', '回传', 'collaboration', 'bottom', 'top', []),
  edge('child-return', 'parent-receive', '父接收', 'collaboration', 'left', 'right', []),
  edge('parent-receive', 'wait', '等待实际唤醒', 'collaboration', 'bottom', 'top', []),
  edge(
    'request',
    'compact-request',
    '压缩请求',
    'compact',
    'top',
    'bottom',
    [
      [1212, 520],
      [1104, 520],
      [1104, 248],
      [692, 248],
    ],
    { sourceOffset: -48, targetOffset: 0 },
  ),
  edge('compact-request', 'compact-summary', '生成', 'compact', 'right', 'left', []),
  edge('compact-summary', 'compact-applied', '采用', 'compact', 'right', 'left', []),
  edge(
    'compact-applied',
    'request',
    '采用后准备请求',
    'compact',
    'bottom',
    'top',
    [
      [1260, 248],
      [1368, 248],
      [1368, 520],
      [1308, 520],
    ],
    { sourceOffset: 0, targetOffset: 48 },
  ),
]

export const WORKFLOW_HEADER_TEMPLATE = {
  version: 2 as const,
  width: 4608,
  height: 1880,
  groups,
  nodes,
  edges,
  callList: { x: 1708, y: 1040, width: 256, height: 264 },
} as const

export function headerPortPoint(
  node: HeaderTemplateNode,
  port: HeaderPort,
  offset = 0,
): HeaderPoint {
  const { x, y } = node.position
  if (port === 'left') return { x, y: y + node.height / 2 + offset }
  if (port === 'right') return { x: x + node.width, y: y + node.height / 2 + offset }
  if (port === 'top') return { x: x + node.width / 2 + offset, y }
  return { x: x + node.width / 2 + offset, y: y + node.height }
}

export function headerHandleId(type: 'in' | 'out', port: HeaderPort, offset = 0): string {
  return `${type}-${port}-${offset}`
}

export function headerNodePorts(nodeId: string) {
  const ports = edges.flatMap((edge) => [
    ...(edge.source === nodeId
      ? [
          {
            type: 'source' as const,
            side: edge.sourcePort,
            offset: edge.sourceOffset ?? 0,
            id: headerHandleId('out', edge.sourcePort, edge.sourceOffset),
          },
        ]
      : []),
    ...(edge.target === nodeId
      ? [
          {
            type: 'target' as const,
            side: edge.targetPort,
            offset: edge.targetOffset ?? 0,
            id: headerHandleId('in', edge.targetPort, edge.targetOffset),
          },
        ]
      : []),
  ])
  return [...new Map(ports.map((port) => [port.id, port])).values()]
}

export function headerEdgeLabelPoint(edge: HeaderTemplateEdge): HeaderPoint {
  if (edge.labelPoint) return edge.labelPoint
  const points = headerEdgePoints(edge)
  const segment = points
    .slice(1)
    .map((end, index) => ({ start: points[index]!, end }))
    .sort(
      (a, b) =>
        Math.abs(b.end.x - b.start.x) +
        Math.abs(b.end.y - b.start.y) -
        (Math.abs(a.end.x - a.start.x) + Math.abs(a.end.y - a.start.y)),
    )[0]!
  return { x: (segment.start.x + segment.end.x) / 2, y: (segment.start.y + segment.end.y) / 2 }
}

/** Precomputed in template coordinates; no DOM measurements or animation clock. */
export function headerEdgePoints(edge: HeaderTemplateEdge): HeaderPoint[] {
  const source = nodes.find((node) => node.id === edge.source)!
  const target = nodes.find((node) => node.id === edge.target)!
  const start = headerPortPoint(source, edge.sourcePort, edge.sourceOffset)
  const end = headerPortPoint(target, edge.targetPort, edge.targetOffset)
  if (edge.via.length) return [start, ...edge.via, end]
  if (start.x === end.x || start.y === end.y) return [start, end]
  return [
    start,
    { x: (start.x + end.x) / 2, y: start.y },
    { x: (start.x + end.x) / 2, y: end.y },
    end,
  ]
}
