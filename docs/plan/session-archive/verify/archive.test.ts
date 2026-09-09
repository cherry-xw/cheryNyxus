// Temporary integration check for the archived-session contract. No production data.
import { beforeAll, afterAll, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, copyFileSync, cpSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'

let chat: typeof import('@/db/chat')
let db: typeof import('@/db/index')
let api: typeof import('@/service/chat/archive')
let epochs: typeof import('@/db/epoch')
let branches: typeof import('@/db/conversationBranch')
let lifecycle: typeof import('@/service/config/roleLifecycle')
let families: typeof import('@/db/chatFamily')
const ctx = {} as import('@/service/message/router').HandlerContext

beforeAll(async () => {
  const out = resolve('docs/plan/session-archive/verify/out')
  mkdirSync(out, { recursive: true })
  const fixture = mkdtempSync(join(out, 'archive-'))
  mkdirSync(join(fixture, '.chery'))
  copyFileSync('.chery.template/config.yaml', join(fixture, '.chery/config.yaml'))
  cpSync('.chery.template/prompt', join(fixture, '.chery/prompt'), { recursive: true })
  process.env.CHERY_DIR = fixture
  process.env.DB_DIR = join(fixture, 'db')
  process.env.CHERY_AUTH_SESSION_SECRET = 'archive-verification-only'
  chat = await import('@/db/chat')
  db = await import('@/db/index')
  api = await import('@/service/chat/archive')
  epochs = await import('@/db/epoch')
  branches = await import('@/db/conversationBranch')
  lifecycle = await import('@/service/config/roleLifecycle')
  families = await import('@/db/chatFamily')
})
afterAll(() => db?.closeAllDbs())

it('archives one family, preserves history, enforces root ownership and retries shard failure', async () => {
  const root = randomUUID(),
    child = randomUUID(),
    grandchild = randomUUID(),
    branch = randomUUID(),
    other = randomUUID()
  chat.createChat(root, { preset: 'archive-fixture', presetId: 'archive-fixture' })
  const epoch = epochs.ensureActiveChatEpoch({ chatId: root, revisionId: 'archive-fixture' }).epoch
  chat.createChat(child, { type: 'researcher' }, root)
  chat.createChat(grandchild, { type: 'grandchild-search-target' }, child)
  chat.createChat(branch, {}, undefined)
  chat.createChat(other)
  const { task } = branches.ensureConversationTask(root, {})
  branches.insertConversationBranch({
    branchId: randomUUID(),
    taskId: task.taskId,
    chatId: branch,
    kind: 'detail',
    runtimeSnapshot: {},
  })
  chat.addMessage(randomUUID(), child, { role: 'user', content: 'preserved content' })
  await expect(api.handleChatDelete(ctx, { chatId: root })).rejects.toThrow()
  await expect(api.handleChatArchive(ctx, { chatId: child })).rejects.toThrow()
  const result = await api.handleChatArchive(ctx, { chatId: root })
  expect(new Set(result.archivedChatIds)).toEqual(new Set([root, child, grandchild, branch]))
  expect(chat.getMessages(child).some((message) => message.content === 'preserved content')).toBe(
    true,
  )
  expect(chat.getChat(other)?.lifecycle).toBe('active')
  expect(() => epochs.assertEpochExecutable(root, epoch.epochId)).toThrow()
  expect(() => epochs.ensureActiveChatEpoch({ chatId: root, revisionId: 'new' })).toThrow()
  expect(chat.listRootChatsForPresets([{ presetId: 'archive-fixture' }])).toHaveLength(0)
  const listed = await api.handleArchiveList(ctx, { query: 'grandchild-search-target' })
  expect(listed.groups).toHaveLength(1)
  expect(listed.groups[0]?.chats).toHaveLength(4)
  const timestamp = listed.groups[0]?.archivedAt
  await api.handleChatArchive(ctx, { chatId: root })
  expect(
    (await api.handleArchiveList(ctx, {})).groups.find((group) => group.rootChatId === root)
      ?.archivedAt,
  ).toBe(timestamp)
  await expect(api.handleChatDelete(ctx, { chatId: child })).rejects.toThrow()
  await expect(api.handleChatDelete(ctx, { chatId: branch })).rejects.toThrow()
  const monthly = db.getMonthlyDb(chat.getChat(child)!.messages_month)
  monthly.exec(
    "CREATE TRIGGER archive_test_failure BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
  )
  await expect(api.handleChatDelete(ctx, { chatId: root })).rejects.toThrow('injected failure')
  for (const id of result.archivedChatIds) expect(chat.getChat(id)).toBeDefined()
  monthly.exec('DROP TRIGGER archive_test_failure')
  const removed = await api.handleChatDelete(ctx, { chatId: root })
  expect(new Set(removed.deletedChatIds)).toEqual(new Set(result.archivedChatIds))
  for (const id of result.archivedChatIds) expect(chat.getChat(id)).toBeUndefined()
  expect(branches.getConversationTask(task.taskId)).toBeUndefined()
  expect(chat.getChat(other)).toBeDefined()
  expect((await api.handleChatDelete(ctx, { chatId: root })).deletedChatIds).toEqual([])
})

it('paginates roots, includes legacy archives, and validates request constraints', async () => {
  const { ArchiveListRequestSchema } = await import('@chery/protocol')
  expect(ArchiveListRequestSchema.safeParse({ page: -1 }).success).toBe(false)
  expect(ArchiveListRequestSchema.safeParse({ pageSize: 1000 }).success).toBe(false)
  for (let i = 0; i < 22; i++) {
    const id = randomUUID()
    chat.createChat(id, { preset: 'pagination', presetId: 'pagination' })
    db.getSoulDb().prepare("UPDATE chats SET lifecycle = 'archived' WHERE id = ?").run(id)
  }
  const first = await api.handleArchiveList(ctx, { presetId: 'pagination' })
  expect(first.total).toBe(22)
  expect(first.groups).toHaveLength(20)
  expect(first.groups[0]?.archivedAt).toBeUndefined()
  const last = await api.handleArchiveList(ctx, { presetId: 'pagination', page: 99 })
  expect(last.page).toBe(2)
  expect(last.groups).toHaveLength(2)
})

it('groups a child task branch under the top-level root and archives each preset family once', () => {
  const presetId = randomUUID()
  const root = randomUUID(),
    child = randomUUID(),
    branch = randomUUID(),
    branchChild = randomUUID()
  chat.createChat(root, { preset: 'nested-branch', presetId })
  chat.createChat(child, { preset: 'nested-branch', presetId, type: 'researcher' }, root)
  chat.createChat(branch, { preset: 'nested-branch', presetId })
  chat.createChat(branchChild, { type: 'writer' }, branch)
  const { task } = branches.ensureConversationTask(child, {})
  branches.insertConversationBranch({
    branchId: randomUUID(),
    taskId: task.taskId,
    chatId: branch,
    kind: 'continuation',
    runtimeSnapshot: {},
  })

  expect(new Set(families.getChatFamily(root)?.chats.map((row) => row.id))).toEqual(
    new Set([root, child, branch, branchChild]),
  )
  expect(families.getChatFamily(branch)?.rootChatId).toBe(root)
  expect(lifecycle.archivePresetRoots([presetId], 'preset removed')).toEqual([root])
  for (const id of [root, child, branch, branchChild])
    expect(chat.getChat(id)?.lifecycle).toBe('archived')
})
