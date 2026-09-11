import type {
  WorkflowFact,
  WorkflowNodeId,
  WorkflowSnapshot,
  WorkflowUpdated,
} from '@chery/protocol'

export const workflowNodes: Array<{
  id: WorkflowNodeId
  label: string
  description: string
  conditional?: boolean
}> = [
  { id: 'context', label: '上下文准备', description: '构建或恢复本次生效的提示词与有效历史' },
  { id: 'input', label: '输入接入', description: '用户输入、续接或子任务回传实际进入主 Agent' },
  { id: 'model', label: '模型调用', description: '请求准备、调用及响应处理' },
  {
    id: 'tools',
    label: '工具执行',
    description: '完整批次按实际顺序执行，派发只显示主 Agent 边界',
  },
  { id: 'checkpoint', label: '记录汇总', description: 'Checkpoint 汇总本轮消息和工具结果' },
  { id: 'decision', label: '循环判断', description: '继续下一轮、等待、暂停或结束' },
  { id: 'result', label: '本轮结果', description: '本轮完成与整个任务完成可能不同' },
  {
    id: 'command',
    label: '执行指令',
    description: '内置指令正文加载与注入，不代表指令任务已完成',
    conditional: true,
  },
  {
    id: 'retry',
    label: '重试退避',
    description: '模型请求失败后的实际重试，工具失败不会自动进入这里',
    conditional: true,
  },
  {
    id: 'compact',
    label: '上下文压缩',
    description: '仅在实际采用摘要并裁剪上下文后生效',
    conditional: true,
  },
]

export function acceptWorkflow(
  current: WorkflowUpdated | undefined,
  event: WorkflowUpdated,
  lease: Pick<WorkflowUpdated, 'subscriptionId' | 'streamId'>,
  chatId: string,
): boolean {
  if (!event.snapshot) return false
  return (
    event.subscriptionId === lease.subscriptionId &&
    event.streamId === lease.streamId &&
    event.snapshot.chatId === chatId &&
    (!current ||
      current.streamId !== event.streamId ||
      !current.snapshot ||
      event.snapshot.revision > current.snapshot.revision)
  )
}

export function replayFrames(facts: WorkflowFact[]): WorkflowFact[] {
  return facts.flatMap((fact) => {
    if (!fact.batch) return [fact]
    const batch = fact.batch
    if (!batch.complete) return []
    const calls = batch.calls.map((call) => ({
      ...call,
      resources: undefined,
      status: 'pending' as const,
    }))
    const frames: WorkflowFact[] = [
      {
        ...fact,
        resources: undefined,
        label: '完整工具清单',
        status: 'running',
        batch: { ...batch, calls },
      },
    ]
    for (let index = 0; index < batch.calls.length; index++) {
      const call = batch.calls[index]!
      const done = batch.calls.slice(0, index)
      const rest = calls.slice(index + 1)
      // A missing result does not prove that execution ever started.
      if (call.status !== 'unknown' && call.status !== 'pending')
        frames.push({
          ...fact,
          resources: undefined,
          id: `${fact.id}:${call.id}:start`,
          label: `执行 ${call.name}`.slice(0, 200),
          callId: call.id,
          status: 'running',
          batch: {
            ...batch,
            calls: [...done, { ...call, resources: undefined, status: 'running' }, ...rest],
          },
        })
      frames.push({
        ...fact,
        resources:
          call.resources ?? (index === batch.calls.length - 1 ? fact.resources : undefined),
        id: `${fact.id}:${call.id}:result`,
        label: `${call.name} 结果`.slice(0, 200),
        callId: call.id,
        status: 'running',
        batch: { ...batch, calls: [...done, call, ...rest] },
      })
    }
    return frames
  })
}

export function replaySnapshot(
  base: WorkflowSnapshot,
  frames: WorkflowFact[],
  index: number,
): WorkflowSnapshot {
  const snapshot: WorkflowSnapshot = {
    ...base,
    status: 'unknown',
    visitedNodeIds: [],
    dispatches: [],
    batch: undefined,
    modelHooks: undefined,
    activeNodeId: undefined,
    phaseLabel: undefined,
    waitReason: undefined,
    attempt: undefined,
    iteration: undefined,
  }
  for (const frame of frames.slice(0, index + 1)) {
    if (frame.nodeId === 'model') snapshot.visitedNodeIds = []
    else if (snapshot.activeNodeId && !snapshot.visitedNodeIds.includes(snapshot.activeNodeId))
      snapshot.visitedNodeIds.push(snapshot.activeNodeId)
    snapshot.activeNodeId = frame.nodeId
    snapshot.phaseKnown = true
    snapshot.phaseLabel = frame.label
    snapshot.status = frame.nodeId === 'result' ? frame.status : 'running'
    snapshot.runId = frame.runId
    if (frame.batch) snapshot.batch = frame.batch
    if (frame.dispatches)
      for (const dispatch of frame.dispatches) {
        snapshot.dispatches = [
          ...snapshot.dispatches.filter((item) => item.id !== dispatch.id),
          dispatch,
        ]
      }
    if (frame.resources) snapshot.resources = frame.resources
    if (frame.nodeId === 'compact' && frame.status === 'completed') {
      snapshot.batch = undefined
      snapshot.resources = {
        ...snapshot.resources,
        loadedSkillCount: 0,
        loadedSkillsComplete: true,
      }
    }
  }
  return snapshot
}
