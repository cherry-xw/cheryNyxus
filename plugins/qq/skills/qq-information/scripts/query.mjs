import { pathToFileURL } from 'node:url'

export const kinds = ['history', 'profile', 'group', 'members', 'member', 'notices', 'files', 'file_url', 'file_space', 'essence', 'albums', 'album_media', 'honor']
export function prepareQuery(input, subject) {
  if (!kinds.includes(input.kind)) throw new Error('Unsupported read-only query')
  const count = input.count ?? 50
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('count must be 1..100')
  const group = subject.conversationType === 'group'
  if (!group && !['history', 'profile'].includes(input.kind)) throw new Error('当前私聊仅允许自己的历史和资料查询')
  const user = input.userId || subject.userId
  if (!/^[1-9]\d{0,19}$/.test(user)) throw new Error('Invalid user ID')
  if (!group && user !== subject.userId) throw new Error('不能查询其他私聊用户')
  for (const key of ['folderId', 'fileId', 'albumId']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 256 || /[\x00-\x1f]/.test(input[key]))) throw new Error('Invalid resource ID')
  return { kind: input.kind, count, userId: user, ...(input.folderId ? {folderId: input.folderId} : {}), ...(input.fileId ? {fileId: input.fileId} : {}), ...(input.albumId ? {albumId: input.albumId} : {}) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(prepareQuery(JSON.parse(process.argv[2]), JSON.parse(process.argv[3])))) }
  catch (e) { console.log(JSON.stringify({ok:false,error:e.message})); process.exitCode = 1 }
}
