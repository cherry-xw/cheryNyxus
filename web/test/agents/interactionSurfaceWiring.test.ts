import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../helpers/componentSource'

async function source(path: string): Promise<string> {
  return readComponentSource(resolve(import.meta.dirname, '../../src', path), 'utf8')
}

describe('approval and question surface wiring', () => {
  it('keeps approval decisions centralized while retaining node question details', async () => {
    const [popover, stack, paper, tree] = await Promise.all([
      source('features/pets/nyxus/components/ExecutionNodePopover.vue'),
      source('features/pets/nyxus/components/NodePaperStack.vue'),
      source('features/pets/nyxus/components/PaperGameCard.vue'),
      source('features/pets/nyxus/components/MessageBranchTree.vue'),
    ])

    // 审批交互由任务中心 / Lite 处理；提问交互仍保留节点弹窗入口。
    expect(popover).not.toContain('ApprovalCard')
    for (const surface of [stack, paper]) {
      expect(surface).not.toContain('ApprovalCard')
      expect(surface).not.toContain('QuestionCard')
    }
    expect(tree).not.toContain('activePaperApprovalPopover')
    expect(tree).not.toContain('activePaperQuestionPopover')
  })

  it('routes cards, Lite and attention workspaces through the one interaction store', async () => {
    const [chatStore, liteCanonical, liteView, taskCenter, decisionContext] =
      await Promise.all([
        source('stores/chats/index.ts'),
        source('features/lite/useLiteCanonicalView.ts'),
        source('features/lite/LiteView.vue'),
        source('features/agent/task-center/TaskCenterAttentionWorkspace.vue'),
        source('features/agent/attention/InteractionDecisionContext.vue'),
      ])

    expect(chatStore).toContain('await interactions.decide(record, action)')
    expect(chatStore).toContain('await interactions.answer(')
    expect(liteCanonical).toContain('await interactions.decide(interaction, action)')
    expect(liteCanonical).toContain('await interactions.answer(')
    expect(liteView).toContain('@click="onDecide(activeInteraction, \'accept\')"')
    expect(liteView).toContain('@click="onAnswerBatch(activeInteraction)"')
    expect(taskCenter).toContain('await interactions.decide(item, action)')
    expect(taskCenter).toContain('await interactions.answer(item, answers)')
    expect(taskCenter).toContain('item.deadlineAt')
    expect(decisionContext).toContain('为什么需要你决定')
    expect(decisionContext).toContain('决定后会发生什么')
  })
})
