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

    // 树模式审批/提问交互统一收敛到节点弹窗（点击闪烁节点打开交互卡）；
    // 纸卡面（stack/paper）不承载审批与提问交互。
    expect(popover).toContain('ApprovalCard')
    for (const surface of [stack, paper]) {
      expect(surface).not.toContain('ApprovalCard')
      expect(surface).not.toContain('QuestionCard')
    }
    expect(tree).not.toContain('activePaperApprovalPopover')
    expect(tree).not.toContain('activePaperQuestionPopover')
  })

  it('routes cards, Lite and attention workspaces through the one interaction store', async () => {
    const [chatStore, liteCanonical, liteView, interactionView, taskCenter, decisionContext] =
      await Promise.all([
        source('stores/chats/index.ts'),
        source('features/lite/useLiteCanonicalView.ts'),
        source('features/lite/LiteView.vue'),
        source('features/lite/LiteInteractionView.vue'),
        source('features/agent/task-center/TaskCenterAttentionWorkspace.vue'),
        source('features/agent/attention/InteractionDecisionContext.vue'),
      ])

    expect(chatStore).toContain('await interactions.decide(record, action)')
    expect(chatStore).toContain('await interactions.answer(')
    expect(liteCanonical).toContain('await interactions.decide(interaction, action)')
    expect(liteCanonical).toContain('await interactions.answer(')
    // v2026-11：审批/提问交互迁入详情抽屉（LiteInteractionView），主视图不再直接持有交互动作。
    expect(liteView).not.toContain('onDecide(')
    expect(liteView).not.toContain('onAnswerBatch(')
    expect(interactionView).toContain("@click=\"interactions.onDecide(interaction, 'accept')\"")
    expect(interactionView).toContain('@click="interactions.onAnswerBatch(interaction)"')
    expect(taskCenter).toContain('await interactions.decide(item, action)')
    expect(taskCenter).toContain('await interactions.answer(item, answers)')
    expect(taskCenter).toContain('item.deadlineAt')
    expect(decisionContext).toContain('为什么需要你决定')
    expect(decisionContext).toContain('决定后会发生什么')
  })
})
