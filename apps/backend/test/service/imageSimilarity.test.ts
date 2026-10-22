import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import type { AssetRecord } from '@chery/protocol'
import { groupCurrentImages, imageFingerprint, highVisualSimilarity, type ImageSelection } from '@/service/fileServices/imageSimilarity.js'
async function synthetic() {
  const width = 512, height = 384
  const data = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3
    data[i] = Math.round((Math.sin(x / 30) + 1) * 70 + y / 8)
    data[i + 1] = Math.round((Math.cos(y / 25) + 1) * 90 + x / 10)
    data[i + 2] = ((x >> 6) + (y >> 6)) % 2 ? 180 : 40
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer()
}
function selection(key: string, data: Buffer): ImageSelection {
  return { key, asset: { id: key, versionId: `v-${key}`, sha256: createHash('sha256').update(data).digest('hex'), sizeBytes: data.length, kind: 'image', mimeType: 'image/png' } as AssetRecord }
}
describe('current-context static image similarity', () => {
  it('compression, resize and re-encode form one deterministic representative; exact match skips read', async () => {
    const original = await synthetic()
    const jpeg = await sharp(original).jpeg({ quality: 85 }).toBuffer()
    const webp = await sharp(original).resize(256).webp({ quality: 85 }).toBuffer()
    const bytes = { A: original, B: jpeg, C: webp, D: original }
    let reads = 0
    const aliases = await groupCurrentImages(Object.entries(bytes).map(([key, data]) => selection(key, data)), async item => { reads++; return bytes[item.key as keyof typeof bytes] })
    expect([...aliases.values()]).toEqual(['A', 'A', 'A', 'A'])
    expect(reads).toBe(3)
  })
  it('different colour and changed text/shape are not merged', async () => {
    const original = await synthetic()
    const changed = await sharp(original).composite([{ input: Buffer.from('<svg width="512" height="384"><rect x="40" y="70" width="230" height="100" fill="white"/><text x="45" y="130" font-size="48">Changed</text></svg>') }]).png().toBuffer()
    const colour = await sharp({ create: { width: 512, height: 384, channels: 3, background: '#ff0000' } }).png().toBuffer()
    const a = await imageFingerprint(original)
    expect(a).toBeDefined()
    expect(highVisualSimilarity(a!, (await imageFingerprint(changed))!)).toBe(false)
    expect(highVisualSimilarity(a!, (await imageFingerprint(colour))!)).toBe(false)
  })
  it('GIF is exact-only, corrupted input falls back without blocking normal input', async () => {
    const original = await synthetic()
    const gif = await sharp(original).gif().toBuffer()
    expect(await imageFingerprint(gif)).toBeUndefined()
    expect(await imageFingerprint(Buffer.from('not an image'))).toBeUndefined()
    const items = [selection('a', gif), selection('b', gif), selection('c', Buffer.from('invalid'))]
    const aliases = await groupCurrentImages(items, async item => item.key === 'c' ? Buffer.from('invalid') : gif)
    expect(aliases.get('b')).toBe('a')
    expect(aliases.get('c')).toBe('c')
  })
  it('does not merge through a transitive similarity chain', async () => {
    const bytes: Record<string, Buffer> = {}
    for (const [key, shade] of [['a', 80], ['b', 84], ['c', 88]] as const) bytes[key] = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: shade, g: shade, b: shade } } }).png().toBuffer()
    const aliases = await groupCurrentImages(Object.entries(bytes).map(([key, data]) => selection(key, data)), async item => bytes[item.key]!)
    expect([...aliases.entries()]).toEqual([['a', 'a'], ['b', 'a'], ['c', 'c']])
  })
  it('animated WebP with shared first frame remains distinct; oversized decode falls back', async () => {
    const stacked = Buffer.alloc(32 * 64 * 3, 120)
    stacked.fill(240, 32 * 32 * 3)
    const animated = await sharp(stacked, { raw: { width: 32, height: 64, channels: 3, pageHeight: 32 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer()
    expect((await sharp(animated).metadata()).pages).toBe(2)
    expect(await imageFingerprint(animated)).toBeUndefined()
    const oversized = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#aaa' } }).png().toBuffer()
    expect(await imageFingerprint(oversized)).toBeUndefined()
  })
  it('candidate lists are supplied by caller, previous calls never expand the next conversation', async () => {
    const original = await synthetic()
    await groupCurrentImages([selection('group-a', original)], async () => original)
    const aliases = await groupCurrentImages([selection('group-b', original)], async () => original)
    expect([...aliases.entries()]).toEqual([['group-b', 'group-b']])
  })
})
