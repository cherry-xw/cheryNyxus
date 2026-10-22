import sharp from 'sharp'
import type { AssetRecord } from '@chery/protocol'

export const IMAGE_SIMILARITY_LIMITS = { candidates: 64, pixels: 24_000_000, bytes: 16 * 1024 * 1024, concurrency: 2 } as const
export interface ImageFingerprint { width: number; height: number; hash: Uint8Array; pixels: Uint8Array }
let decoding = 0
const waiting: Array<() => void> = []
async function decodeSlot<T>(run: () => Promise<T>): Promise<T> {
  if (decoding >= IMAGE_SIMILARITY_LIMITS.concurrency) await new Promise<void>(resolve => waiting.push(resolve))
  else decoding++
  try { return await run() } finally { const next = waiting.shift(); if (next) next(); else decoding-- }
}

/** Invalid/animated/oversized inputs remain eligible for normal file processing, never first-frame matching. */
export async function imageFingerprint(data: Buffer): Promise<ImageFingerprint | undefined> {
  if (data.length > IMAGE_SIMILARITY_LIMITS.bytes) return undefined
  return decodeSlot(async () => {
    try {
      const options = { limitInputPixels: IMAGE_SIMILARITY_LIMITS.pixels, failOn: 'warning' as const }
      const meta = await sharp(data, options).metadata()
      if (meta.format === 'gif' || (meta.pages ?? 1) !== 1 || meta.delay?.length || !meta.width || !meta.height) return undefined
      const pixels = await sharp(data, options).autoOrient().flatten({ background: '#ffffff' }).toColourspace('srgb').removeAlpha().resize(64, 64, { fit: 'fill' }).raw().toBuffer()
      const grey = await sharp(data, options).autoOrient().flatten({ background: '#ffffff' }).resize(17, 16, { fit: 'fill' }).greyscale().raw().toBuffer()
      const hash = new Uint8Array(256)
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) hash[y * 16 + x] = grey[y * 17 + x]! > grey[y * 17 + x + 1]! ? 1 : 0
      const rotated = [5, 6, 7, 8].includes(meta.orientation ?? 1)
      return { width: rotated ? meta.height : meta.width, height: rotated ? meta.width : meta.height, hash, pixels }
    } catch { return undefined }
  })
}

/** Conservative perceptual hash plus colour/detail check; only compare with a fixed representative. */
export function highVisualSimilarity(a: ImageFingerprint, b: ImageFingerprint): boolean {
  if (Math.abs((a.width / a.height) / (b.width / b.height) - 1) > 0.015) return false
  let hamming = 0
  for (let i = 0; i < a.hash.length; i++) if (a.hash[i] !== b.hash[i]) hamming++
  if (hamming > 12 || a.pixels.length !== b.pixels.length) return false
  let sum = 0, changed = 0
  for (let i = 0; i < a.pixels.length; i++) {
    const diff = Math.abs(a.pixels[i]! - b.pixels[i]!)
    sum += diff
    if (diff > 32) changed++
  }
  return sum / a.pixels.length <= 5 && changed / a.pixels.length <= 0.008
}

export interface ImageSelection { asset: AssetRecord; key: string }
/** The caller supplies only currently eligible, authorized conversation candidates. No global search/cache. */
export async function groupCurrentImages(items: readonly ImageSelection[], read: (item: ImageSelection) => Promise<Buffer>): Promise<Map<string, string>> {
  const aliases = new Map<string, string>()
  const representatives: Array<{ item: ImageSelection; fingerprint?: ImageFingerprint }> = []
  const exact = new Map<string, string>()
  // Prefer a larger original, then fixed ID for stability throughout repeated preparation/tool loops.
  const ordered = [...items].sort((a, b) => ((b.asset.transform?.width ?? 0) * (b.asset.transform?.height ?? 0)) - ((a.asset.transform?.width ?? 0) * (a.asset.transform?.height ?? 0)) || a.key.localeCompare(b.key))
  for (const [index, item] of ordered.entries()) {
    const same = exact.get(item.asset.sha256)
    if (same) { aliases.set(item.key, same); continue }
    let fingerprint: ImageFingerprint | undefined
    if (index < IMAGE_SIMILARITY_LIMITS.candidates && item.asset.sizeBytes <= IMAGE_SIMILARITY_LIMITS.bytes) {
      try { fingerprint = await imageFingerprint(await read(item)) } catch { /* Normal processing rechecks access and reports failures. */ }
    }
    const similar = fingerprint && representatives.find(rep => rep.fingerprint && highVisualSimilarity(rep.fingerprint, fingerprint!))
    const representative = similar ? similar.item.key : item.key
    aliases.set(item.key, representative)
    exact.set(item.asset.sha256, representative)
    if (!similar) representatives.push({ item, fingerprint })
  }
  return aliases
}
