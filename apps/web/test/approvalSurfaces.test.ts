import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(path), 'utf8')
}

describe('approval presentation surfaces', () => {
  it('uses the shared semantic summary and structured arguments in every approval entry', () => {
    const surfaces = [
      'apps/web/src/features/agent/cards/ApprovalCard.vue',
      'apps/web/src/features/agent/task-center/TaskCenterAttentionWorkspace.vue',
      'apps/web/src/features/agent/attention/InteractionCard.vue',
      'apps/web/src/features/lite/LiteInteractionView.vue',
    ]
    for (const file of surfaces) {
      const view = source(file)
      expect(view, file).toContain('ApprovalSummary')
      expect(view, file).toContain('ParsedArgs')
    }
    // 注意力面板经 InteractionCard 间接使用共享呈现；不得回退到裸 <pre> 展示参数。
    expect(source('apps/web/src/features/agent/attention/WorkspaceSessionBrowser.vue')).not.toContain(
      '<pre',
    )
  })

  it('keeps the runtime and reusable template defaults at five minutes', () => {
    expect(source('apps/backend/.chery.template/config.yaml')).toContain('approval_timeout: 300000')
    expect(source('apps/backend/src/utils/config.ts')).toMatch(
      /approval_timeout\s*!==\s*undefined\s*\?\s*config\.global\.approval_timeout\s*:\s*300000/,
    )
  })

  it('keeps pending decisions out of paper cards and tree popovers under the current surface map', () => {
    // 9ef10dc7 收敛审批/提问面后，941940a8 起节点树弹窗重新成为待审批入口：
    // 弹窗允许 ApprovalCard/QuestionCard；纸牌（PaperStack/GameCard）仍禁止渲染待决策。
    const paperSurfaces = [
      'apps/web/src/features/pets/nyxus/components/NodePaperStack.vue',
      'apps/web/src/features/pets/nyxus/components/PaperGameCard.vue',
    ]
    for (const file of paperSurfaces) {
      const view = source(file)
      expect(view, file).not.toContain('ApprovalCard')
      expect(view, file).not.toContain('QuestionCard')
      expect(view, file).not.toMatch(/\bapprovalNodeId\b/)
      expect(view, file).not.toMatch(/\bquestionNodeId\b/)
    }
    expect(
      source('apps/web/src/features/pets/nyxus/components/ExecutionNodePopover.vue'),
    ).not.toMatch(/\bapprovalNodeId\b|\bquestionNodeId\b/)
  })
})
