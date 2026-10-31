import path from 'node:path'
import { z } from 'zod'
import { atomicText, parseStored, readSafeText, textVersion, withFileLock, type QQSubject } from './files.js'
import { KnowledgeEvidenceSchema, QQKnowledgeStore, TermInputSchema, type KnowledgeEvidence, type TermInput } from './knowledge.js'
const schema = z.object({ id: z.string(), revision: z.number(), status: z.enum(['pending','running','completed','failed','cancelled']),
  terms: z.array(TermInputSchema), evidence: z.array(KnowledgeEvidenceSchema), receipts: z.record(z.string(),z.string()) }).strict()
export class QQKnowledgeCandidates {
  constructor(private root: string, private store: QQKnowledgeStore) {}
  private file(selfId: string, id: string) { return path.join(this.root,'memory','candidates',textVersion(selfId),textVersion(id)+'.json') }
  async read(selfId: string, id: string) {
    try { return parseStored(schema,JSON.parse(await readSafeText(this.file(selfId,id))), 'QQ public candidate') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async save(selfId: string, id: string, index: number, terms: TermInput[], evidence: KnowledgeEvidence[], signal?: AbortSignal) {
    const file = this.file(selfId,id)
    return withFileLock(file,async () => {
      const old = await this.read(selfId,id) ?? schema.parse({ id,revision:0,status:'running',terms:[],evidence:[],receipts:{} })
      const fingerprint = textVersion(JSON.stringify({ terms,evidence }))
      if (old.receipts[index] && old.receipts[index] !== fingerprint) throw Object.assign(new Error('CONFLICT'),{code:'CONFLICT'})
      if (!old.receipts[index]) { old.terms.push(...terms); old.evidence.push(...evidence); old.receipts[index] = fingerprint; old.revision++ }
      await atomicText(file,JSON.stringify(schema.parse(old)),signal); return fingerprint
    },signal)
  }
  async finish(selfId: string, id: string, status: 'completed' | 'failed' | 'cancelled', signal?: AbortSignal) {
    const file = this.file(selfId,id)
    return withFileLock(file, async () => { const item = await this.read(selfId,id); if (!item) return
      item.status = status; item.revision++; await atomicText(file,JSON.stringify(item),signal)
    },signal)
  }
  async adopt(subject: QQSubject, candidateId: string, operationId: string, signal?: AbortSignal, validate?: () => void) {
    const candidate = await this.read(subject.selfId,candidateId)
    if (candidate?.status !== 'completed') throw Object.assign(new Error('NOT_AVAILABLE'),{code:'NOT_AVAILABLE'})
    const old = await this.store.receipt(subject,'public',operationId)
    if (old) return old
    const { revision } = await this.store.list(subject,'public')
    const terms=[...new Map(candidate.terms.map(term=>[term.term.normalize('NFKC').toLowerCase(),term])).values()]
    return this.store.manage(subject,'public',{operationId,expectedRevision:revision,save:terms,delete:[]},candidate.evidence,signal,validate)
  }
}
