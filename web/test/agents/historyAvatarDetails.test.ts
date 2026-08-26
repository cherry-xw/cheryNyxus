import { readComponentSourceSync } from '../helpers/componentSource'
import { describe, expect, it } from 'vitest'

const drawer = readComponentSourceSync(
  new URL('../../src/features/agent/drawer/HistoryDrawerPanel.vue', import.meta.url),
)
const avatar = readComponentSourceSync(
  new URL('../../src/features/agent/chat/MessageAvatar.vue', import.meta.url),
)

describe('history avatar details regressions', () => {
  it('keeps timeline runtime snapshots and falls back to the matching session runtime', () => {
    expect(drawer).toContain('...(node.runtime ? { runtime: node.runtime } : {})')
    expect(drawer).toContain(
      'chatSessions.sessionsById[chatId]?.context.runtime ?? agents.petForChat(chatId)?.runtime',
    )
  })

  it('renders the main agent glyph with a contrasting foreground', () => {
    const assistantRule = avatar.match(/&\.role-assistant\s*\{([\s\S]*?)\n\s*\}/)?.[1]
    expect(assistantRule).toContain('background: linear-gradient(135deg, #ffd27a, #f6b73c);')
    expect(assistantRule).toContain('color: #3b2b12;')
    expect(assistantRule).not.toContain('color: #f6b73c;')
  })
})
