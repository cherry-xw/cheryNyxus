import type { AssetRecord } from '@chery/protocol'
import type { FilesImageAdaptationConfig } from '@chery/plugin-api'
import type { AssetAccess, AssetStore } from './assetStore.js'
import { prepareImage } from './prepareImage.js'

/** The original is immutable; no oversized intermediate is published. */
export async function adaptAssetImage(store: AssetStore, assetId: string, access: AssetAccess,
  options: FilesImageAdaptationConfig = {}): Promise<AssetRecord> {
  const { asset, data } = await store.read(assetId, access)
  if (asset.kind !== 'image') throw new Error('此文件不是图片')
  const prepared = await prepareImage(data, options)
  if (prepared.data === data) return asset
  return store.saveAdapted(prepared.data, asset, access, {
    variant: 'adapted', maxEdge: options.maxEdge ?? 2048, quality: options.quality ?? 85,
    width: prepared.width, height: prepared.height,
    preservedTransparency: prepared.preservedTransparency,
    preservedAnimation: prepared.preservedAnimation,
  }, prepared.mimeType)
}
