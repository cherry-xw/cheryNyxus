import type { AssetRecord, MessageAssetPart, MessagePart, QQEventSubmitRequest } from '@chery/protocol'

type Attachment = NonNullable<QQEventSubmitRequest['attachments']>[number]
export interface QQFileSources {
  messages: readonly QQEventSubmitRequest[]
  /** Owned by the current conversation, persisted with queue state. */
  known: Record<string, MessagePart>
  /** Already-selected background window; only its images are imported. */
  background?: readonly QQEventSubmitRequest[]

  validate(part: MessageAssetPart): Promise<void>
  save(): void
  diagnostic?(detail: { stage: string; code: string; messageId: string; attachmentIndex: number }): void
}

/** Model contexts retain provenance/metadata, never attachment transport URLs. */
export function qqModelContext(_key: string, value: unknown): unknown {
  if (_key !== 'attachments' || !Array.isArray(value)) return value
  return value.map((file: Attachment, index) => ({ type: file.type, name: file.name, mimeType: file.mimeType,
    sourceAttachmentIndex: index, availability: 'metadata_only',
    instruction: '附件元信息不是图片内容；实际图片输入及固定资产引用以本次文件输入清单为准，未携图不得声称看过，不自行下载或OCR。' }))
}

const imageAttachment = (file: Attachment) => file.type === 'image' || !!file.mimeType?.startsWith('image/')
const sameConversation = (a: QQEventSubmitRequest, b: QQEventSubmitRequest) => a.selfId === b.selfId && a.conversationType === b.conversationType && a.targetId === b.targetId

/** Carry the selected conversation mechanically; interpretation and image selection belong to the model. */
export async function prepareQQFileInputs(inputs: readonly QQEventSubmitRequest[], importFile: (file: Attachment) => Promise<AssetRecord>, signal: AbortSignal, sources?: QQFileSources): Promise<MessagePart[] | undefined> {
  const background = (sources?.background ?? []).filter(message => inputs.some(input => sameConversation(message, input)) && !inputs.some(input => sameConversation(message, input) && message.messageId === input.messageId))
    .filter((message, index, all) => all.findIndex(other => sameConversation(message, other) && message.messageId === other.messageId) === index)
  if (!inputs.some(input => input.attachments?.length || input.replyToMessageId) && !background.some(message => message.attachments?.some(imageAttachment))) return undefined
  const parts: MessagePart[] = []
  const append = async (input: QQEventSubmitRequest, prefix: string, origin: 'current' | 'history' | 'quote') => {
    parts.push({ type: 'text', partId: `${prefix}:sender`, text: JSON.stringify({ senderId: input.senderId, senderName: input.senderName,
      occurredAt: input.occurredAt, messageId: input.messageId, replyToMessageId: input.replyToMessageId, quoted: origin === 'quote', background: origin === 'history' }) + '\n' })
    const attachments: MessagePart[] = []
    for (const [index, attachment] of (input.attachments ?? []).entries()) {
      if (origin !== 'current' && !imageAttachment(attachment)) continue
      signal.throwIfAborted()
      const key = JSON.stringify([input.selfId, input.conversationType, input.targetId, input.messageId, index])
      let stage = 'import'
      try {
        const known = sources?.known[key]
        let part: MessageAssetPart
        if (known?.type === 'asset') { stage = 'validate'; await sources!.validate(known); part = known }
        else {
          if (imageAttachment(attachment)) throw Object.assign(new Error('SOURCE_UNAVAILABLE'), {code:'SOURCE_UNAVAILABLE'})
          const asset = await importFile(attachment)
          part = { type: 'asset', partId: `${prefix}:attachment:${index}`, assetId: asset.id, assetVersionId: asset.versionId,
            variant: 'original', usage: 'content', originalName: asset.originalName, mimeType: asset.mimeType, kind: asset.kind }
          if (sources) { sources.known[key] = part; sources.save() }
        }
        attachments[index] = { ...part, partId: `${prefix}:attachment:${index}`, ...(origin !== 'current' ? { inputOrigin: origin } : {}) }
      } catch (error) {
        signal.throwIfAborted()
        // Only explicit safe categories/codes; never serialize errors, causes, URLs or message bodies.
        const failure = error as { stage?: unknown; code?: unknown } | null
        if (['download', 'invalid', 'permission'].includes(String(failure?.stage))) stage = String(failure?.stage)
        const code = (/^HTTP_[45][0-9]{2}$/.test(String(failure?.code)) || ['REMOTE_ADDRESS_REJECTED', 'EAI_ADDRFAMILY', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_INVALID_IP_ADDRESS', 'IDENTITY_REJECTED', 'FILE_DOWNLOAD_FAILED', 'FILE_INVALID', 'FILE_PERMISSION_DENIED'].includes(String(failure?.code))) ? String(failure?.code) : 'UNAVAILABLE'
        sources?.diagnostic?.({ stage, code, messageId: /^[a-zA-Z0-9_-]{1,128}$/.test(input.messageId) ? input.messageId : 'redacted', attachmentIndex: index })
        const reason = stage === 'download' ? '下载失败' : stage === 'invalid' ? '格式或大小无效' : stage === 'permission' ? '无权读取' : '不可用'
        attachments[index] = { type: 'text', partId: `${prefix}:attachment:${index}`, text: `〔附件 ${index + 1} ${reason}，不能读取其内容；请重新上传〕` }
      }
    }
    const order = input.parts ?? [{ type: 'text' as const, text: input.content }, ...(input.attachments ?? []).map((_part, index) => ({ type: 'attachment' as const, index }))]
    const seen = new Set<number>()
    for (const [index, part] of order.entries()) {
      if (part.type === 'text') parts.push({ type: 'text', partId: `${prefix}:text:${index}`, text: part.text })
      else if (attachments[part.index]) { seen.add(part.index); parts.push({ ...attachments[part.index]!, partId: `${prefix}:position:${index}` }) }
    }
    parts.push(...attachments.filter((part, index) => !!part && !seen.has(index)))
  }
  for (const [index, message] of background.entries()) await append(message, `qq-input:history:${index}`, 'history')
  for (const [index, input] of inputs.entries()) {
    if (input.replyToMessageId) {
      const source = sources?.messages.find(message => sameConversation(message, input) && message.messageId === input.replyToMessageId)
      if (source) await append(source, `qq-input:${index}:quote`, 'quote')
      else parts.push({ type: 'text', partId: `qq-input:${index}:quote-missing`, text: `〔引用消息 ${input.replyToMessageId} 不在当前同群已知记录内，无法读取原图〕` })
    }
    await append(input, `qq-input:${index}`, 'current')
  }
  return parts
}
