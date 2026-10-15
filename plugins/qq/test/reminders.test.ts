import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { ReminderStore, reminderTools } from '../src/reminders.js'
it('persists reminders, scopes management to sender/group, recovers claimed tasks and excludes cancelled/sent ones', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'qq-reminders-'))
 try {
  const store = new ReminderStore(root), tools = reminderTools(store)
  const ctx = { requestView: { identity: { channel: 'qq', subject: { selfId: '123', groupId: '456', userId: '789', conversationType: 'group' } } } } as any
  const call = (name: string, args: any, context = ctx) => tools.find(t => t.sense.definition.function.name === name)!.sense.executor.execute(args, {} as any, context)
  const result = await call('qq_reminder_create', { dueAt: new Date(Date.now()+60000).toISOString(), text: '喝水', mention: true })
  const item = JSON.parse(result.content!)
  const other = structuredClone(ctx); other.requestView.identity.subject.userId = '111'
  await expect(call('qq_reminder_cancel', { id: item.id }, other)).rejects.toThrow('not found')
  expect(JSON.parse((await call('qq_reminder_list', {}, other)).content!).items).toEqual([])
  expect(await store.due(Date.now())).toEqual([])
  expect(await new ReminderStore(root).due(Date.now()+61000)).toHaveLength(1)
  expect(await new ReminderStore(root).due(Date.now()+61000)).toHaveLength(1)
  await store.result(item.id,'sent')
  expect(await store.due(Date.now()+61000)).toEqual([])
  const second = JSON.parse((await call('qq_reminder_create',{dueAt:new Date(Date.now()+60000).toISOString(),text:'休息'})).content!)
  await call('qq_reminder_cancel',{id:second.id})
  expect(await store.due(Date.now()+61000)).toEqual([])
 } finally { await rm(root,{recursive:true,force:true}) }
})
