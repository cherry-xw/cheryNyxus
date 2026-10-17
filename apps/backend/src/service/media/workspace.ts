import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { getAssetStore } from './store.js'
import type { AssetAccess } from './assetStore.js'
import { normalizeWorkspacePath, resolveChatWorkspaceEntry } from '../workspace/sandbox.js'

/** 只创建当前工作区内的新文件，绝不替换已有文件或跟随末级符号链接。 */
export async function saveAssetToWorkspace(ref: { assetId: string; assetVersionId: string }, access: AssetAccess, path: string) {
  if (!access.chatId) throw new Error('保存到工作区需要会话')
  const normalized = normalizeWorkspacePath(path)
  if (!normalized || basename(normalized).startsWith('.')) throw new Error('请选择工作区中的普通文件路径')
  const parent = await resolveChatWorkspaceEntry(access.chatId, dirname(normalized))
  if (!parent.stat.isDirectory()) throw new Error('目标文件夹不存在')
  const physicalParent = await realpath(parent.absolute)
  const inside = relative(parent.root, physicalParent)
  if (inside === '..' || inside.startsWith(`..${sep}`)) throw new Error('不能写入工作区外的路径')
  const target = join(physicalParent, basename(normalized))
  const { data, asset } = await getAssetStore().read(ref.assetId, access, ref.assetVersionId)
  const file = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { await file.writeFile(data); await file.sync() } finally { await file.close() }
  return { path: normalized, assetId: asset.id, assetVersionId: asset.versionId, sizeBytes: data.length }
}
