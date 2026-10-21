import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initBackendResumeTables } from '@/db/backendResume.js'

const state = vi.hoisted(() => ({ db: undefined as unknown as Database.Database,
  rows: new Map<string, { id: string; content?: string }[]>(), execute: vi.fn() }))
vi.mock('@/db/index.js', () => ({ getSoulDb: () => state.db }))
vi.mock('@/db/chat.js', () => ({ getChat: (id: string) => id === 'chat' ? { id } : undefined }))
vi.mock('@/db/message.js', () => ({
  getMessages: (id: string) => state.rows.get(id) ?? [],
  addMessage: (id: string, chatId: string, data: { content?: string }) => {
    const rows = state.rows.get(chatId) ?? []
    rows.push({ id, content: data.content }); state.rows.set(chatId, rows)
  },
  fillApprovalResult: (chatId: string, id: string, data: { content: string }) => {
    Object.assign(state.rows.get(chatId)!.find(row => row.id === id)!, data)
  },
}))
import { recordToolStart, recoverInterruptedTools, releaseToolStart } from '@/service/chat/toolRecovery.js'

describe('interrupted tool recovery', () => {
  beforeEach(() => {
    state.rows.clear(); state.execute.mockClear()
    state.db = new Database(':memory:')
    state.db.exec("CREATE TABLE chats(id TEXT PRIMARY KEY); INSERT INTO chats VALUES ('chat')")
    initBackendResumeTables(state.db)
  })
  afterEach(() => state.db.close())
  it('does not create executable tool history for private request tools', () => {
    expect(recordToolStart('chat', 'private', 'external', '{}', true)).toBe(false)
    expect(state.rows.get('chat')).toBeUndefined()
    recoverInterruptedTools()
    expect(state.rows.get('chat')?.[0]?.content).toContain('不会自动重放')
  })
  it('fills an unknown result without executing an external operation again', () => {
    expect(recordToolStart('chat', 'call', 'remote_action', '{}')).toBe(true)
    recoverInterruptedTools()
    expect(state.rows.get('chat')?.[0]?.content).toContain('执行结果未确认')
    expect(state.rows.get('chat')?.[0]?.content).toContain('不会自动重放')
    expect(state.execute).not.toHaveBeenCalled()
    expect(state.db.prepare('SELECT * FROM tool_execution_starts').all()).toEqual([])
    recoverInterruptedTools()
    expect(state.rows.get('chat')).toHaveLength(1)
  })
  it('preserves completed results, unanswered questions and not-yet-started approvals', () => {
    state.rows.set('chat', [{ id: 'done', content: 'saved result' }, { id: 'approval' }, { id: 'question' }])
    recordToolStart('chat', 'done', 'external', '{}')
    expect(recordToolStart('chat', 'question', 'ask_user_question', '{}')).toBe(false)
    recoverInterruptedTools()
    expect(state.rows.get('chat')).toEqual([{ id: 'done', content: 'saved result' }, { id: 'approval' }, { id: 'question' }])
    recordToolStart('chat', 'next', 'external', '{}')
    releaseToolStart('chat', 'next')
    expect(state.db.prepare('SELECT * FROM tool_execution_starts').all()).toEqual([])
  })
})
