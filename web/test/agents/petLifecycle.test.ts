import { describe, expect, it } from 'vitest'
import {
  CHERY_NYXUS_PRESET,
  registerNewNyxusSession,
  selectRefreshRecoveryChats,
} from '../../src/stores/agents/data/petLifecycle'

describe('registerNewNyxusSession', () => {
  it('makes a newly-created session immediately identifiable as Nyxus', () => {
    expect(registerNewNyxusSession([], 'new-nyxus', 100)).toEqual([
      {
        chatId: 'new-nyxus',
        createdAt: 100,
        updatedAt: 100,
        preset: CHERY_NYXUS_PRESET,
      },
    ])
  })

  it('replaces an existing local entry instead of duplicating the chat', () => {
    const sessions = registerNewNyxusSession(
      [
        { chatId: 'new-nyxus', preset: 'stale', updatedAt: 1 },
        { chatId: 'other', preset: CHERY_NYXUS_PRESET },
      ],
      'new-nyxus',
      100,
    )

    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toMatchObject({
      chatId: 'new-nyxus',
      preset: CHERY_NYXUS_PRESET,
      updatedAt: 100,
    })
  })
})

describe('selectRefreshRecoveryChats', () => {
  it('keeps refresh recovery scoped to visible ordinary Pets', () => {
    const chats = [
      { chatId: 'ordinary-root', preset: 'assistant' },
      { chatId: 'ordinary-child', parentChatId: 'ordinary-root' },
      { chatId: 'hidden-root', preset: 'assistant' },
      { chatId: 'nyxus-root', preset: CHERY_NYXUS_PRESET },
      { chatId: 'nyxus-child', parentChatId: 'nyxus-root' },
      { chatId: 'nyxus-grandchild', parentChatId: 'nyxus-child' },
    ]

    expect(
      selectRefreshRecoveryChats(
        chats,
        new Set(chats.map((chat) => chat.chatId)),
      ).map((chat) => chat.chatId),
    ).toEqual(['ordinary-root', 'ordinary-child', 'hidden-root'])

    expect(
      selectRefreshRecoveryChats(chats, new Set(['ordinary-root', 'nyxus-root'])).map(
        (chat) => chat.chatId,
      ),
    ).toEqual(['ordinary-root'])
  })
})
