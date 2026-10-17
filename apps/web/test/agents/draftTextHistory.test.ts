import { describe, expect, it } from 'vitest'
import { createDraftTextHistory } from '@/features/agent/composer/model/draftTextHistory'

describe('有序草稿撤销', () => {
  it('附件插入、位置删除和文字编辑均可撤销与重做', () => {
    const history = createDraftTextHistory('问题')
    history.record('问题[[attachment:one]]')
    history.record('问题[[attachment:one]]继续')
    history.record('问题继续')
    expect(history.move(-1)).toBe('问题[[attachment:one]]继续')
    expect(history.move(-1)).toBe('问题[[attachment:one]]')
    expect(history.move(1)).toBe('问题[[attachment:one]]继续')
    history.record('新内容')
    expect(history.move(1)).toBeUndefined()
  })
  it('切换会话和发送后的重置不会恢复其他会话或已发送的输入', () => {
    const history = createDraftTextHistory()
    history.record('已发送')
    history.reset('另一会话')
    expect(history.move(-1)).toBeUndefined()
    history.record('另一会话的新输入')
    expect(history.move(-1)).toBe('另一会话')
    history.reset('')
    expect(history.move(-1)).toBeUndefined()
  })
})
