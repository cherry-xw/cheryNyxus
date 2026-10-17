import type { QQEntry, QQEntryDetail } from '../../../packages/protocol/src/qq.js'
import { digest, type Job, type Outbox } from './state.js'

// Only user-facing deliveries belong in the record; internal lookups are not messages.
function deliveries(job: Job, outbox: Outbox[]): Outbox[] {
  return outbox.filter(output => output.frame.data.requestId === job.requestId && (
    output.frame.type === 'qq.message.ack' || output.frame.type === 'qq.request.failed' ||
    ['qq.reply.part', 'qq.reply.file', 'qq.reply.video', 'qq.reply.images', 'qq.reply.action'].includes(output.frame.type)
  ))
}

export function recordEntry(job: Job, outbox: Outbox[]): QQEntry {
  const messages = job.mergedInputs?.length ? job.mergedInputs : [job.input]
  const delivery = { pending: 0, inflight: 0, sent: 0, unknown: 0, failed: 0 }
  for (const output of deliveries(job, outbox)) delivery[output.status]++
  return {
    requestId: job.requestId,
    eventId: job.input.eventId,
    target: digest([job.input.selfId, job.target]),
    targetId: job.input.targetId,
    senderId: job.input.senderId,
    senderName: job.input.senderName,
    conversationType: job.input.conversationType,
    state: job.state,
    acceptedAt: job.acceptedAt,
    policyRevision: job.snapshot.revision,
    preset: job.snapshot.preset,
    inputPreview: messages.map(message => message.content.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / ').slice(0, 300),
    replyPreview: job.reply.replace(/\s+/g, ' ').trim().slice(0, 300),
    messageCount: messages.length,
    attachmentCount: messages.reduce((count, message) => count + (message.attachments?.length || 0), 0),
    delivery,
    ...(job.reason ? { reason: job.reason } : {}),
  }
}

export function recordDetail(job: Job, outbox: Outbox[]): QQEntryDetail {
  const outputs = deliveries(job, outbox)
  return {
    ...recordEntry(job, outbox),
    messages: (job.mergedInputs?.length ? job.mergedInputs : [job.input]).map(message => ({
      eventId: message.eventId,
      senderId: message.senderId,
      senderName: message.senderName,
      content: message.content.slice(0, 20000),
      contentTruncated: message.content.length > 20000,
      attachments: (message.attachments || []).map(attachment => ({ type: attachment.type, ...(attachment.name ? { name: attachment.name } : {}) })),
    })),
    reply: job.reply.slice(0, 100000),
    replyTruncated: job.reply.length > 100000,
    deliveries: outputs.slice(-200).map(output => ({
      eventId: output.frame.data.eventId,
      type: output.frame.type,
      status: output.status,
      ...(output.issuedAt !== undefined ? { issuedAt: output.issuedAt } : {}),
      ...(output.confirmedAt !== undefined ? { confirmedAt: output.confirmedAt } : {}),
    })),
    deliveriesTruncated: outputs.length > 200,
  }
}
