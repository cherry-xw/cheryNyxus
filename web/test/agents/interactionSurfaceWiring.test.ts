import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../helpers/componentSource'

async function source(path: string): Promise<string> {
  return readComponentSource(resolve(import.meta.dirname, '../../src', path), 'utf8')
}

describe('approval and question surface wiring', () => {
  it('keeps approval/question interactions out of node-tree surfaces (pending panel owns them)', async () => {
    const [popover, stack, paper, tree] = await Promise.all([
      source('features/pets/nyxus/components/ExecutionNodePopover.vue'),
      source('features/pets/nyxus/components/NodePaperStack.vue'),
      source('features/pets/nyxus/components/PaperGameCard.vue'),
      source('features/pets/nyxus/components/MessageBranchTree.vue'),
    ])

    // 审批交互全部收敛到待操作面板；提问交互仅节点弹窗保留（纸牌/树不再内嵌）
    expect(popover).not.toContain('ApprovalCard')
    for (const surface of [stack, paper]) {
      expect(surface).not.toContain('ApprovalCard')
      expect(surface).not.toContain('QuestionCard')
    }
    expect(tree).not.toContain('activePaperApprovalPopover')
    expect(tree).not.toContain('activePaperQuestionPopover')
  })

  it('routes cards, Lite and the pending panel through the one interaction store', async () => {
    const [chatStore, liteCanonical, liteView, pendingPanel] = await Promise.all([
      source('stores/chats/index.ts'),
      source('features/lite/useLiteCanonicalView.ts'),
      source('features/lite/LiteView.vue'),
      source('features/agent/attention/PendingOperationsPanel.vue'),
    ])

    expect(chatStore).toContain('await interactions.decide(record, action)')
    expect(chatStore).toContain('await interactions.answer(')
    expect(liteCanonical).toContain('await interactions.decide(interaction, action)')
    expect(liteCanonical).toContain('await interactions.answer(')
    expect(liteView).toContain('@click="onDecide(activeInteraction, \'accept\')"')
    expect(liteView).toContain('@click="onAnswerBatch(activeInteraction)"')
    expect(pendingPanel).toContain('await interactions.decide(item, action)')
    expect(pendingPanel).toContain('await interactions.answer(item, submit)')
    expect(pendingPanel).toContain('item.deadlineAt')
    expect(pendingPanel).toContain('countdownOf(item).expired')
    expect(pendingPanel).toContain("? '已超时'")
  })
})
