import type { MessagePart } from '@chery/protocol'

export interface DraftFileReference {
  assetId: string
  assetVersionId: string
  filename: string
  kind: 'image' | 'video' | 'audio' | 'document' | 'file'
  mimeType: string
  usage?: 'content' | 'reference-only'
  variant?: 'original' | 'adapted'
  status?: 'uploading' | 'ready' | 'failed'
  referenceId?: string
  useCompressed?: boolean
  compressed?: { assetId: string; assetVersionId: string; mimeType: string }
}

export function displayDraftFiles(text: string, files: DraftFileReference[]): string {
  return files.reduce((value, file, index) => file.referenceId ? value.replaceAll(`[[attachment:${file.referenceId}]]`, `〔附件 ${index + 1} · ${file.filename}〕`) : value, text)
}
export function encodeDraftFiles(text: string, files: DraftFileReference[]): string {
  return files.reduce((value, file, index) => file.referenceId ? value.replaceAll(`〔附件 ${index + 1} · ${file.filename}〕`, `[[attachment:${file.referenceId}]]`) : value, text)
}

/** Editor notation is consumed here; only structured parts cross the wire. */
export function composeMessageParts(text: string, files: DraftFileReference[] = []): MessagePart[] {
  const parts: MessagePart[] = []
  let cursor = 0
  const id = () => `part-${parts.length}`
  const addFile = (file: DraftFileReference) => {
    if (file.status && file.status !== 'ready') throw new Error(`请先重试或移除未上传完成的文件：${file.filename}`)
    const chosen = file.useCompressed && file.compressed ? file.compressed : file
    if (!chosen.assetVersionId) throw new Error(`文件版本缺失，请重新选择：${file.filename}`)
    parts.push({ partId: id(), type: 'asset', assetId: chosen.assetId, assetVersionId: chosen.assetVersionId,
      variant: chosen === file ? file.variant ?? 'original' : 'adapted', usage: file.usage ?? 'content',
      originalName: file.filename, mimeType: chosen.mimeType, kind: file.kind })
  }
  for (const match of text.matchAll(/\[\[(command|role|file|attachment):([^\]\r\n]+)\]\]/g)) {
    if (match.index! > cursor) parts.push({ partId: id(), type: 'text', text: text.slice(cursor, match.index) })
    const value = match[2]!
    if (match[1] === 'attachment') {
      const file = files.find(f => f.referenceId === value)
      if (!file) throw new Error('此文件引用已失效，请移除引用并重新选择文件。')
      addFile(file)
    }
    else if (match[1] === 'command') parts.push({ partId: id(), type: 'directive', command: value })
    else if (match[1] === 'role') parts.push({ partId: id(), type: 'role_mention', roleName: value.replace(/^@/, '') })
    else parts.push({ partId: id(), type: 'workspace_ref', path: value, ...(value.endsWith('/') ? { kind: 'directory' as const } : {}) })
    cursor = match.index! + match[0].length
  }
  if (cursor < text.length) parts.push({ partId: id(), type: 'text', text: text.slice(cursor) })
  for (const file of files) {
    if (!file.referenceId) addFile(file)
  }
  return parts
}
