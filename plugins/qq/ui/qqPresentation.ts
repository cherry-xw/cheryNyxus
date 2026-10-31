import { type QQEntry, type QQEntryDetail, QQResponseSchemas } from '../../../packages/protocol/src/qq'
import type { z } from 'zod'

type Capability = z.infer<typeof QQResponseSchemas['qq.policy.get']>['capabilities'][number]
export function capabilityLabel(cap: Capability): string {
  const reasons: Record<string, string> = {missing_preset:'缺少有效预设',missing_tool:'工具组未选择',disabled:'已关闭',role_deny:'角色权限不允许',role_ask:'需要审批，不能自动执行',tool_unavailable:'工具当前不可用',not_connected:'QQ未连接或服务已暂停',not_supported:'当前目标不支持',voice_unconfigured:'未设置固定声音',unverified:'尚未验证实际可用性'}
  return reasons[cap.reason ?? ''] ?? (cap.ready === true ? '最近调用成功，不保证后续调用或QQ送达' : cap.allowed ? '已获许可，尚未验证实际可用性' : '许可尚未确认')
}
export function capabilityResultLabel(result: Capability['lastResult']): string {
  if (!result) return '尚无调用记录'
  const status: Record<string,string> = {ok:'工具执行成功',provider_error:'查询或执行未完成',error:'调用失败',unknown:'结果未知'}
  return `${result.current?'最近调用':'旧配置调用'}：${status[result.status]??'未确认成功'}；${new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'medium'}).format(result.at)}；QQ配置版本 ${result.qqConfigRevision??'未知'}；核心配置版本 ${result.configRevision??'未知'}；工具版本 ${result.registryVersion??'未知'}`
}

export const applyLabel = (value?: string) => ({ applied: '已应用', pending: '待应用', failed: '应用失败', restart_required: '需重启运行服务' }[value || ''] || '应用状态未知')
export const taskLabel = (value: string) => ({ queued: '排队中', running: '处理中', sending: '处理完成，等待发送确认', completed: '处理完成', failed: '处理失败', paused: '已暂停', cancelled: '已取消' }[value] || '任务状态未知')
export const recordKindLabel=(entry:Pick<QQEntry,'kind'>)=>entry.kind==='observation'?'观察（不直接发送回复）':entry.kind==='program'?'程序通知':'回复任务'
export const participationLabel=(value?:string)=>({reply:'选择回复',wait:'暂不参与',end:'结束参与'}[value??'']??'未作参与决定')
export function filterRecordEntries(entries:QQEntry[],kind:'all'|'observation'|'reply') {
  return kind==='all'?entries:entries.filter(entry=>kind==='observation'?entry.kind==='observation':entry.kind!=='observation')
}
export function recordProcessingRows(entry:QQEntryDetail) {
  const processing=entry.processing
  if(!processing)return [{label:'处理说明',value:'这条记录未保存处理说明'}]
  const rows=[{label:'参与模式',value:`${entry.conversationType==='private'?'私聊':processing.mode==='proactive'?'适度主动参与':'@后续聊'}（${{default:'默认设置',group:'本群覆盖',private:'私聊设置'}[processing.modeOrigin]}）`},
    {label:'参与决定',value:participationLabel(entry.participation)},
    {label:'启动前排队',value:processing.queueWaitMs===undefined?'尚未启动或没有记录':`${(processing.queueWaitMs/1000).toFixed(1)} 秒`},
    {label:'判断前补查',value:`${processing.contextReads} 次`},
  ]
  if(processing.anchorRecord)rows.push({label:'回应来源',value:`${processing.anchorRecord.recordId} · 版本 ${processing.anchorRecord.revision}`})
  if(processing.learning)rows.push({label:'当前来源范围的学习任务',value:`待处理 ${processing.learning.pending} · 失败 ${processing.learning.failed} · 已完成 ${processing.learning.completed}（不表示这条消息已经学会）`})
  return rows
}
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
