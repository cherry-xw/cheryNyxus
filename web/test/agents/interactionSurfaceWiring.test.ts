import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../helpers/componentSource'

async function source(path: string): Promise<string> {
  return readComponentSource(resolve(import.meta.dirname, '../../src', path), 'utf8')
}

describe('approval and question surface wiring', () => {
  it('renders the shared interaction cards in node popovers and paper cards', async () => {
    const [popover, paper, tree] = await Promise.all([
      source('features/pets/nyxus/components/ExecutionNodePopover.vue'),
      source('features/pets/nyxus/components/PaperGameCard.vue'),
      source('features/pets/nyxus/components/MessageBranchTree.vue'),
    ])

    for (const surface of [popover, paper]) {
      expect(surface).toContain('ApprovalCard')
      expect(surface).toContain('QuestionCard')
      expect(surface).toContain('<ApprovalCard')
      expect(surface).toContain('<QuestionCard')
    }
    expect(tree).toContain(':approval="activePaperApprovalPopover?.approval"')
    expect(tree).toContain(':approval-node-id="activePaperApprovalPopover?.displayNodeId"')
    expect(tree).toContain(':question="activePaperQuestionPopover?.question"')
    expect(tree).toContain(':question-node-id="activePaperQuestionPopover?.displayNodeId"')
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
    expect(liteView).toContain("@click=\"onDecide(activeInteraction, 'accept')\"")
    expect(liteView).toContain('@click="onAnswerBatch(activeInteraction)"')
    expect(pendingPanel).toContain("await interactions.decide(item, action)")
    expect(pendingPanel).toContain('await interactions.answer(item, submit)')
    expect(pendingPanel).toContain('item.deadlineAt')
    expect(pendingPanel).toContain('countdownOf(item).expired')
    expect(pendingPanel).toContain("? '已超时'")
  })
})
