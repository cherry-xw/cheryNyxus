import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(path), 'utf8')
}

describe('approval presentation surfaces', () => {
  it('uses the shared semantic summary and structured arguments in every approval entry', () => {
    const surfaces = [
      'web/src/features/agent/cards/ApprovalCard.vue',
      'web/src/features/agent/attention/PendingOperationsPanel.vue',
      'web/src/features/agent/attention/WorkspaceSessionBrowser.vue',
      'web/src/features/lite/LiteView.vue',
    ]
    for (const file of surfaces) {
      const view = source(file)
      expect(view, file).toContain('ApprovalSummary')
      expect(view, file).toContain('ParsedArgs')
    }
    expect(source('web/src/features/agent/attention/WorkspaceSessionBrowser.vue')).not.toContain(
      '<pre v-if="item.kind === \'approval\'"',
    )
  })

  it('keeps the runtime and reusable template defaults at five minutes', () => {
    expect(source('.chery.template/config.yaml')).toContain('approval_timeout: 300000')
    expect(source('src/utils/config.ts')).toMatch(
      /approval_timeout\s*!==\s*undefined\s*\?\s*config\.global\.approval_timeout\s*:\s*300000/,
    )
  })

  it('keeps pending decisions out of node-tree popovers and paper cards', () => {
    const nodeTreeSurfaces = [
      'web/src/features/pets/nyxus/components/ExecutionNodePopover.vue',
      'web/src/features/pets/nyxus/components/NodePaperStack.vue',
      'web/src/features/pets/nyxus/components/PaperGameCard.vue',
    ]
    for (const file of nodeTreeSurfaces) {
      const view = source(file)
      expect(view, file).not.toContain('ApprovalCard')
      expect(view, file).not.toMatch(/\bapprovalNodeId\b/)
    }
    for (const file of nodeTreeSurfaces.slice(1)) {
      const view = source(file)
      expect(view, file).not.toContain('QuestionCard')
      expect(view, file).not.toMatch(/\bquestionNodeId\b/)
    }

    const controller = source(
      'web/src/features/pets/nyxus/components/useMessageBranchTreeController.ts',
    )
    expect(controller).toContain('if (model.approval || model.question) return []')
    expect(source('web/src/features/pets/nyxus/components/MessageBranchTree.vue')).not.toContain(
      'activePaperQuestionPopover',
    )
  })
})
