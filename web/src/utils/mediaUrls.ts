import type { MediaAssetRef } from '@/domain/chat/projectionTypes'

const EXT_MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
}

export function extractMediaUrls(text: string): MediaAssetRef[] {
  // 同时识别两类引用：展示型 URL（/api/media/<filename>，生成图/历史）与
  // 上传图内部标记（[[media:<filename>]]，发送后落库在 user content 里，不向用户展示原文）。
  // 按出现位置排序，保证返回顺序与文本一致。
  const matches = [
    ...text.matchAll(/\/api\/media\/([a-f0-9-]+\.[a-z0-9]+)/gi),
    ...text.matchAll(/\[\[media:([a-f0-9-]+\.[a-z0-9]+)\]\]/gi),
  ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  return matches.map((match) => {
    const filename = match[1]!
    const ext = filename.split('.').pop()?.toLowerCase() ?? ''
    const mimeType = EXT_MIME_MAP[ext] ?? 'application/octet-stream'
    const kind: MediaAssetRef['kind'] = mimeType.startsWith('image/')
      ? 'image'
      : mimeType.startsWith('video/')
        ? 'video'
        : mimeType.startsWith('audio/')
          ? 'audio'
          : 'image'
    return { filename, kind, mimeType }
  })
}

/** 剥离 user 消息里的 [[media:...]] 内部标记（不向用户展示原文）。 */
export function stripMediaMarkers(text: string): string {
  return text.replace(/\[\[media:[a-f0-9-]+\.[a-z0-9]+\]\]/gi, '').trim()
}
