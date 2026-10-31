import path from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { IngressContext } from '@chery/plugin-api'
import { atomicText, parseStored, readSafeText, withFileLock } from './files.js'
import { withOperations, operationId } from './operationPolicy.js'
const itemSchema = z.object({ id: z.string(), selfId: z.string(), groupId: z.string(), userId: z.string(), dueAt: z.number(), text: z.string(), mention: z.boolean(), state: z.enum(['pending', 'claimed', 'sent', 'cancelled', 'unknown', 'failed']), createdAt: z.number() }).strict()
export type Reminder = z.infer<typeof itemSchema>
export class ReminderStore {
  private file: string
  constructor(root: string) { this.file = path.join(root, 'reminders.json') }
  private async read() { try { return parseStored(z.array(itemSchema).max(1000), JSON.parse(await readSafeText(this.file)), 'reminders') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e } }
  async change<T>(fn: (items: Reminder[]) => T): Promise<T> { return withFileLock(this.file, async () => { const items = await this.read(); const before = JSON.stringify(items); const result = fn(items); const after = JSON.stringify(items); if (after !== before) await atomicText(this.file, after); return result }) }
  async due(now: number) { return this.change(items => items.filter(i => (i.state === 'pending' || i.state === 'claimed') && i.dueAt <= now).map(i => { i.state = 'claimed'; return { ...i } })) }
  async result(id: string, state: 'sent' | 'unknown' | 'failed') { await this.change(items => { const item = items.find(i => i.id === id); if (item) item.state = state }) }
}
type Registration = Parameters<IngressContext['tools']['register']>[0]
export function reminderTools(store: ReminderStore): Registration[] {
  const schema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('create'), operationId, dueAt: z.string().datetime({ offset: true }), text: z.string().min(1).max(500), mention: z.boolean().default(true) }).strict(),
    z.object({ action: z.literal('list') }).strict(),
    z.object({ action: z.literal('cancel'), operationId, id: z.string().min(1).max(100) }).strict(),
  ])
  return [(() => {
    const name = 'qq_reminder'
    const json = z.toJSONSchema(schema)
    const description = '当前群当前成员的一次性提醒。action=create/list/cancel，create/cancel必须operationId，重试不换ID。创建dueAt为带时区ISO时间，最多366天、20个待发；只提醒不执行命令。取消必填id且只能取消自己的未执行提醒。'
    return withOperations({ sense: { definition: { type: 'function', function: { name, description, parameters: { type: 'object', ...json } as any } }, supervisionLevel: 0, executor: { schema, execute: async (input, _shared, ctx) => {
      const subject = ctx?.requestView?.identity.subject
      if (ctx?.requestView?.identity.channel !== 'qq' || subject?.conversationType !== 'group' || !subject.groupId) throw new Error('Trusted group required')
      const args = schema.parse(input) as any
      const result = await store.change(items => {
        const own = items.filter(i => i.groupId === subject.groupId && i.selfId === subject.selfId && i.userId === subject.userId)
        if (args.action === 'list') return { now: new Date().toISOString(), items: own }
        if (args.action === 'cancel') { const item = own.find(i => i.id === args.id && ['pending','cancelled'].includes(i.state)); if (!item) throw new Error('Pending reminder not found'); item.state = 'cancelled'; return { cancelled: item.id } }
        const id = createHash('sha256').update(JSON.stringify([ctx!.requestView!.requestId, args.operationId])).digest('hex')
        const old = items.find(item => item.id === id)
        if (old) { if (old.dueAt !== Date.parse(args.dueAt) || old.text !== args.text || old.mention !== args.mention || !own.includes(old)) throw new Error('CONFLICT'); return old }
        const dueAt = Date.parse(args.dueAt), now = Date.now()
        if (dueAt <= now || dueAt > now + 366 * 86400000 || own.filter(i => i.state === 'pending').length >= 20 || items.length >= 1000) throw new Error('Invalid time or reminder capacity reached')
        const item: Reminder = { id, selfId: subject.selfId!, groupId: subject.groupId!, userId: subject.userId!, dueAt, text: args.text, mention: args.mention, state: 'pending', createdAt: now }; items.push(item); return item
      })
      return { content: JSON.stringify(result), status: 'ok' }
    } } }, metadata: { label: name, description, icon: 'qq', doc: description } }, 'action', ['create','list','cancel'])
  })()]
}
