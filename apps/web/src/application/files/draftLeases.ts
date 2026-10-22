import { fileApi } from '@/services/fileApi'
import { uuid } from '@/utils/uuid'

type AssetRef = { assetId: string; assetVersionId: string }
interface DraftLease {
  id: string
  context: string
  refs: () => AssetRef[]
  onError?: (cause: unknown) => void
  signature?: string
}

/** 浏览器内的草稿所有者负责解除；面板卸载不等于丢弃草稿。 */
export function createFileDraftLeases(api: Pick<typeof fileApi, 'contextKey' | 'retainDraft'>) {
  const leases = new Map<string, DraftLease>()
  let timer: ReturnType<typeof setInterval> | undefined
  function renew(lease: DraftLease, force = false) {
    if (lease.context !== api.contextKey()) return
    const refs = [...new Map(lease.refs().map(ref => [`${ref.assetId}:${ref.assetVersionId}`, ref])).values()]
    const signature = JSON.stringify(refs)
    if (!force && signature === lease.signature) return
    lease.signature = signature
    void api.retainDraft(lease.id, refs).catch(cause => {
      if ([...leases.values()].includes(lease) && lease.context === api.contextKey()) lease.onError?.(cause)
    })
  }
  return {
    set(key: string, context: string, refs: () => AssetRef[], onError?: (cause: unknown) => void) {
      let lease = leases.get(key)
      if (!lease || lease.context !== context) {
        lease = { id: uuid(), context, refs, onError }
        leases.set(key, lease)
      } else { lease.refs = refs; lease.onError = onError }
      renew(lease)
      timer ??= setInterval(() => { for (const item of leases.values()) renew(item, true) }, 60_000)
    },
    drop(key: string) {
      const lease = leases.get(key)
      if (!lease) return
      leases.delete(key)
      if (lease.context === api.contextKey()) void api.retainDraft(lease.id, []).catch(() => undefined)
      if (!leases.size) { clearInterval(timer); timer = undefined }
    },
    dispose() { clearInterval(timer); timer = undefined; leases.clear() },
  }
}

export const fileDraftLeases = createFileDraftLeases(fileApi)
