import { validateLoadable } from '@/utils/config.js'
import { readConfigImage, getSavedBaseRevision } from './commit.js'

/** Read-only: a delayed restart must not overwrite edits made after the accepted candidate. */
export function validateRestartCandidate(
  expectedRevision?: string,
): { ok: true } | { ok: false; error: string } {
  const image = readConfigImage()
  if (expectedRevision && getSavedBaseRevision(image) !== expectedRevision)
    return { ok: false, error: '磁盘配置已变化，请重新校验后保存' }
  const validation = validateLoadable(image.config)
  return validation.ok ? { ok: true } : { ok: false, error: '磁盘配置验证失败，请修复后重新保存' }
}
