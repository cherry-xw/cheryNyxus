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
  const matches = [...text.matchAll(/\/api\/media\/([a-f0-9-]+\.[a-z0-9]+)/gi)]
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
