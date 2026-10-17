import { describe, expect, it } from 'vitest'
import { composeMessageParts, displayDraftFiles, encodeDraftFiles } from '../../src/domain/chat/messageParts'

const file = { assetId:'asset-1', assetVersionId:'version-1', filename:'原始资料.pdf', kind:'document' as const,
  mimeType:'application/pdf', referenceId:'ref-1', usage:'reference-only' as const, status:'ready' as const }

describe('ordered file message parts', () => {
  it('retains text, file, directive, role and workspace order without wire markers', () => {
    const parts = composeMessageParts('前文[[attachment:ref-1]]后文[[command:/check]][[role:@reviewer]][[file:src/]]', [file])
    expect(parts.map(p => p.type)).toEqual(['text','asset','text','directive','role_mention','workspace_ref'])
    expect(parts[1]).toMatchObject({ assetId:'asset-1', assetVersionId:'version-1', usage:'reference-only', variant:'original' })
    expect(JSON.stringify(parts)).not.toContain('[[attachment:')
  })
  it('does not resurrect a removed inline reference from the management list', () => {
    expect(composeMessageParts('仅保留文字', [file])).toEqual([{ partId:'part-0', type:'text', text:'仅保留文字' }])
  })
  it('rejects missing versions and unresolved uploads rather than silently dropping files', () => {
    expect(() => composeMessageParts('[[attachment:ref-1]]', [{ ...file, assetVersionId:'' }])).toThrow('版本缺失')
    expect(() => composeMessageParts('[[attachment:ref-1]]', [{ ...file, status:'failed' }])).toThrow('重试或移除')
    expect(() => composeMessageParts('[[attachment:missing]]', [file])).toThrow('引用已失效')
  })
  it('allows file-only inputs and only an existing adapted version', () => {
    expect(composeMessageParts('', [{ ...file, referenceId:undefined }])[0]?.type).toBe('asset')
    expect(composeMessageParts('[[attachment:ref-1]]', [{ ...file, useCompressed:true, compressed:{ assetId:'adapted', assetVersionId:'version-2', mimeType:'application/pdf' } }])[0]).toMatchObject({ assetVersionId:'version-2', variant:'adapted' })
  })
  it('preserves an adapted historical version when it is referenced again', () => {
    expect(composeMessageParts('[[attachment:ref-1]]', [{ ...file, variant:'adapted' }])[0]).toMatchObject({ assetVersionId:'version-1', variant:'adapted' })
  })
  it('round trips readable textarea references without leaking identifiers', () => {
    const original = '前文[[attachment:ref-1]]后文'
    const displayed = displayDraftFiles(original, [file])
    expect(displayed).toContain('附件 1 · 原始资料.pdf')
    expect(displayed).not.toContain('ref-1')
    expect(encodeDraftFiles(displayed, [file])).toBe(original)
  })
})
