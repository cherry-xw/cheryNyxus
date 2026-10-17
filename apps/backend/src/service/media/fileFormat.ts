import type { AssetKind } from '@chery/protocol'

const DOCUMENTS = new Set(['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'])

/** 核对已识别的文件头，不将扩展名或任意客户端 MIME 当作原生图像支持证明。 */
export function identifyFile(body: Buffer, declared: string): { mimeType: string; kind: AssetKind } {
  const mime = declared.split(';')[0]!.trim().toLowerCase() || 'application/octet-stream'
  let detected: string | undefined
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) detected = 'image/png'
  else if (body[0] === 255 && body[1] === 216 && body[2] === 255) detected = 'image/jpeg'
  else if (['GIF87a', 'GIF89a'].includes(body.subarray(0, 6).toString('ascii'))) detected = 'image/gif'
  else if (body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP') detected = 'image/webp'
  else if (body.subarray(0, 5).toString() === '%PDF-') detected = 'application/pdf'
  else if (body.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) detected = 'application/zip'
  else if (body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WAVE') detected = 'audio/wav'
  else if (body.subarray(0, 4).toString() === 'OggS') detected = mime.startsWith('audio/') ? mime : 'audio/ogg'
  else if (body.subarray(0, 3).toString() === 'ID3') detected = 'audio/mpeg'
  const officeZip = detected === 'application/zip' && mime.startsWith('application/vnd.openxmlformats-officedocument.')
  if (detected && mime !== 'application/octet-stream' && detected !== mime && !officeZip)
    throw new Error('声明的文件格式与文件内容不一致')
  if (!detected && ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'].includes(mime))
    throw new Error('无法识别声明的文件格式')
  const mimeType = officeZip ? mime : detected ?? mime
  const kind: AssetKind = mimeType.startsWith('image/') && !!detected ? 'image'
    : mimeType.startsWith('audio/') ? 'audio' : mimeType.startsWith('video/') ? 'video'
      : DOCUMENTS.has(mimeType) || mimeType.startsWith('text/') ? 'document' : 'file'
  return { mimeType, kind }
}
