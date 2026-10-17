import type { QQEntry } from '../../../packages/protocol/src/qq'

export const applyLabel = (value?: string) => ({ applied: '已应用', pending: '待应用', failed: '应用失败', restart_required: '需重启运行服务' }[value || ''] || '应用状态未知')
export const taskLabel = (value: string) => ({ queued: '排队中', running: '处理中', sending: '处理完成，等待发送确认', completed: '处理完成', failed: '处理失败', paused: '已暂停' }[value] || value)
export const deliveryLabel = (value: string) => ({ pending: '待发送', inflight: '发送中', sent: '已确认发送', unknown: '发送结果未知', failed: '发送失败' }[value] || value)
export const outputLabel = (value: string) => ({ 'qq.message.ack': '收到消息的确认表情', 'qq.reply.part': '回复文字', 'qq.reply.file': '文件', 'qq.reply.video': '视频', 'qq.reply.images': '图片', 'qq.reply.action': 'QQ 互动 / 语音', 'qq.request.failed': '失败说明（不是原回复）' }[value] || value)

export function deliverySummary(entry: QQEntry): string {
  const parts = Object.entries(entry.delivery).filter(([, count]) => count > 0).map(([status, count]) => `${deliveryLabel(status)} ${count}`)
  return parts.length ? parts.join(' · ') : '尚无投递记录'
}

export function recordPage(entries: QQEntry[], requestedPage: number, pageSize = 25) {
  const sorted = [...entries].sort((a, b) => b.acceptedAt - a.acceptedAt || a.requestId.localeCompare(b.requestId))
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const page = Math.max(1, Math.min(pages, requestedPage))
  return { page, pages, total: sorted.length, entries: sorted.slice((page - 1) * pageSize, page * pageSize) }
}
