import { shallowReactive, computed, type InjectionKey, type Ref } from 'vue'
import type { AssetRecord } from '@/application/files/public'
import type { MediaAttachment } from '../composables/useComposerMedia'

/** Provided by the owning input surface; never falls back to a global active window. */
export const FILE_REFERENCE_TARGET: InjectionKey<(asset: AssetRecord) => Promise<void>> = Symbol('file-reference-target')

interface ReferenceTarget {
  id: string
  identity: () => string
  label: () => string
  reference: (asset: AssetRecord) => Promise<void>
}
const targets = shallowReactive(new Map<string, ReferenceTarget>())
/** 全局历史只能通过用户明确选择的输入框引用，不读取全局活动窗口。 */
export function registerFileReferenceTarget(target: ReferenceTarget): () => void {
  targets.set(target.id, target)
  return () => { targets.delete(target.id) }
}
export function useFileReferenceTargets() {
  return computed(() => [...targets.values()].map(target => {
    const identity = target.identity()
    return { id: JSON.stringify([target.id, identity]), label: target.label(), reference: async (asset: AssetRecord) => {
      if (!targets.has(target.id) || identity !== target.identity()) throw new Error('目标输入框已关闭或切换会话，请重新选择')
      await target.reference(asset)
    } }
  }))
}

export const COMPOSER_FILE_DRAFT: InjectionKey<{
  text: Ref<string>
  files: Ref<MediaAttachment[]>
  uploading: Ref<boolean>
  hint: Ref<string>
  send: (chatId: string) => Promise<boolean>
  upload: (file: import('element-plus').UploadFile) => Promise<void>
  remove: (file: MediaAttachment) => void
  toggle: (file: MediaAttachment, field?: 'variant' | 'usage') => void
}> = Symbol('composer-file-draft')
