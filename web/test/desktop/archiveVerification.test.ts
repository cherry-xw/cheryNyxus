import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse, compileScript } from 'vue/compiler-sfc'

describe('temporary archive verification entry', () => {
  it('lists archived roots from history and opens the existing history viewer', async () => {
    const source = readFileSync('web/src/features/desktop/ArchiveVerification.vue', 'utf8')
    const { descriptor } = parse(source)
    const compiled = compileScript(descriptor, { id: 'archive-verification' })
    expect(compiled.content).toContain('workspace.openHistoryRoot(chatId)')
    expect(source).toContain("scope: 'history'")
    expect(source).toContain("chat.lifecycle === 'archived' && !chat.parentChatId")
    expect(source).toContain('不可继续执行')
    expect(source).toContain('role="alert"')
    const host = readFileSync('web/src/features/desktop/CyberDesktopHost.vue', 'utf8')
    expect(host).toContain('<ArchiveVerification />')
  })
})
