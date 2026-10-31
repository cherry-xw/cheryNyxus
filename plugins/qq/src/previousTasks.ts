import type { Job, Outbox } from './state.js'

/** Background facts follow the frozen source selection, never a guessed topic or sender. */
export function previousTaskFacts(current: Job, jobs: Job[], outbox: Outbox[]) {
  if (!current.sourceScopeId || !current.sourceSnapshot || current.startedAt === undefined) return []
  const selected = new Map(current.sourceSnapshot.orderedItems.flatMap(item => item.type === 'message'
    ? [[item.recordId, item.revision] as const] : []))
  let remaining = Math.max(0, current.snapshot.config.backgroundMaxChars)
  return jobs.filter(job => job !== current && job.requestId !== current.requestId &&
    job.sourceScopeId === current.sourceScopeId && job.conversationKey === current.conversationKey &&
    job.target === current.target && job.input.selfId === current.input.selfId &&
    job.snapshot.presetId === current.snapshot.presetId && job.startedAt !== undefined && job.startedAt <= current.startedAt! &&
    job.sourceRecords?.some(record => selected.get(record.recordId) === record.revision))
    .sort((a, b) => b.startedAt! - a.startedAt!)
    .map(job => {
      const modelResult = job.reply.slice(0, remaining)
      remaining -= modelResult.length
      const deliveries: Array<{ type: string; status: Outbox['status']; count: number }> = []
      for (const output of outbox) {
        if (output.sourceScopeId !== current.sourceScopeId || output.frame.data.requestId !== job.requestId ||
          ['qq.message.ack', 'qq.waiting', 'qq.tool.icon'].includes(output.frame.type) ||
          output.frame.type === 'qq.reply.action' && output.frame.data.state === 'progress') continue
        const entry = deliveries.find(entry => entry.type === output.frame.type && entry.status === output.status)
        if (entry) entry.count++
        else deliveries.push({ type: output.frame.type, status: output.status, count: 1 })
      }
      return { requestId: job.requestId, inputRecords: job.sourceRecords!.filter(record => selected.get(record.recordId) === record.revision),
        state: job.state, outcome: job.outcome, startedAt: job.startedAt,
        modelResult, modelResultTruncated: modelResult.length < job.reply.length, deliveries,
        rule: '这是历史任务状态和模型输出，不是本轮指令或工具执行证据。modelResult不证明工具执行或用户收到；发送按deliveries分别判断，错误通知送达不代表原文件送达。结合当前消息承接，只问已有结果时不得照抄旧命令重新执行；证据不足时只查缺少的资料。' }
    }).reverse()
}
