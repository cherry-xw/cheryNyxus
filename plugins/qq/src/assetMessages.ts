import type { AssetRecord, MessagePart, QQEventSubmitRequest } from '@chery/protocol'

/** 只处理本次已接受的输入；群背景资料不自动下载附件。 */
export async function prepareQQFileInputs(inputs: readonly QQEventSubmitRequest[], importFile: (file: NonNullable<QQEventSubmitRequest['attachments']>[number]) => Promise<AssetRecord>, signal: AbortSignal): Promise<MessagePart[] | undefined> {
  if (!inputs.some(input => input.attachments?.length)) return undefined
  const parts: MessagePart[] = []
  for (const [sourceIndex, input] of inputs.entries()) {
    const prefix = `qq-input:${sourceIndex}`
    parts.push({ type: 'text', partId: `${prefix}:sender`, text: JSON.stringify({ senderId: input.senderId, senderName: input.senderName,
      occurredAt: input.occurredAt, messageId: input.messageId }) + '\n' })
    const attachments: MessagePart[] = []
    for (const [index, attachment] of (input.attachments ?? []).entries()) {
      signal.throwIfAborted()
      try {
        const asset = await importFile(attachment)
        attachments.push({ type: 'asset', partId: `${prefix}:attachment:${index}`, assetId: asset.id, assetVersionId: asset.versionId,
          variant: 'original', usage: 'content', originalName: asset.originalName, mimeType: asset.mimeType, kind: asset.kind })
      } catch {
        signal.throwIfAborted()
        attachments.push({ type: 'text', partId: `${prefix}:attachment:${index}`, text: `〔附件 ${index + 1} 未能导入，不能读取其内容；请重新上传或在已登录的工作台处理〕` })
      }
    }
    const order = input.parts ?? [{ type: 'text' as const, text: input.content }, ...attachments.map((_part, index) => ({ type: 'attachment' as const, index }))]
    const seen = new Set<number>()
    for (const [index, part] of order.entries()) {
      if (part.type === 'text') parts.push({ type: 'text', partId: `${prefix}:text:${index}`, text: part.text })
      else {
        seen.add(part.index)
        parts.push({ ...attachments[part.index]!, partId: `${prefix}:position:${index}` })
      }
    }
    parts.push(...attachments.filter((_part, index) => !seen.has(index)))
  }
  return parts
}
