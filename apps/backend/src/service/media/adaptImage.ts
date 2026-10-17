import sharp from 'sharp'
import type { AssetRecord } from '@chery/protocol'
import type { AssetAccess, AssetStore } from './assetStore.js'

/** 使用原版生成固定适配版本；不允许静默去掉透明通道或动画帧。 */
export async function adaptAssetImage(store: AssetStore, assetId: string, access: AssetAccess,
  options: { maxEdge?: number; quality?: number } = {}): Promise<AssetRecord> {
  const maxEdge = options.maxEdge ?? 2048
  const quality = options.quality ?? 85
  if (!Number.isInteger(maxEdge) || maxEdge < 1 || maxEdge > 16384 ||
    !Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('图片适配参数无效')
  const { asset, data } = await store.read(assetId, access)
  if (asset.kind !== 'image') throw new Error('此文件不是图片')
  const input = sharp(data, { animated: true, limitInputPixels: 268_402_689 })
  const metadata = await input.metadata()
  if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format ?? ''))
    throw new Error('此图片格式不能在保留原意的前提下适配，请使用原版')
  // PNG 动图不可由当前编码器原样保留；明确拒绝，不退成首帧。
  if (metadata.format === 'png' && (metadata.pages ?? 1) > 1)
    throw new Error('PNG 动图请使用原版')
  let pipeline = input.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
  if ((metadata.pages ?? 1) <= 1) pipeline = pipeline.autoOrient()
  switch (metadata.format) {
    case 'jpeg': pipeline = pipeline.jpeg({ quality }); break
    case 'png': pipeline = pipeline.png(); break
    case 'webp': pipeline = pipeline.webp({ quality, alphaQuality: 100 }); break
    case 'gif': pipeline = pipeline.gif({ keepDuplicateFrames: true }); break
  }
  const { data: adapted, info } = await pipeline.timeout({ seconds: 30 }).toBuffer({ resolveWithObject: true })
  return store.saveAdapted(adapted, asset, access, {
    variant: 'adapted', maxEdge, quality, width: info.width, height: info.pageHeight ?? info.height,
    preservedTransparency: metadata.hasAlpha ?? false,
    preservedAnimation: (metadata.pages ?? 1) > 1,
  }, `image/${info.format}`)
}
