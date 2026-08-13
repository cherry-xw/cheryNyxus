import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('paper stack workbench integration', () => {
  it('connects the persistent toolbar mode to the execution tree', async () => {
    const workbench = await readFile(
      resolve('src/features/agent/dialog/WorkbenchDialog.vue'),
      'utf8',
    )
    expect(workbench).toContain('paperMode: false')
    expect(workbench).toContain('paperMode: value?.paperMode === true')
    expect(workbench).toContain(':paper-mode="paperMode"')
    expect(workbench).not.toContain(':composer-open="nyxusDraftActive"')
    expect(workbench).toContain(':aria-pressed="paperMode"')
  })

  it('suppresses hover details and bridges the current paper to GPU highlighting', async () => {
    const tree = await readFile(
      resolve('src/features/pets/nyxus/components/MessageBranchTree.vue'),
      'utf8',
    )
    expect(tree).toContain('if (props.paperMode) return')
    expect(tree).toContain('buildPaperStack(paperGraph.value.nodes, nodeTitle)')
    expect(tree).toContain(':edges="paperGraph.edges"')
    expect(tree).toContain('(props.paperMode && activePaperNodeId.value === node.id)')
    expect(tree).toContain('@select="selectPaperIndex"')
    expect(tree).toContain('@latest="returnToLatestPaper"')
    expect(tree).not.toContain('canvas.panToPoint(target)')
    expect(tree).toContain('viewportSize.height - 150')
    expect(tree).not.toContain("'has-composer'")
    expect(tree).not.toContain('composerOpen ? 390')
    expect(tree).toContain(':sense-tools="agents.senseTools"')
    expect(tree).toContain(':question="activePaperQuestionPopover?.question"')
    expect(tree).toContain('if (activePaperQuestionPopover.value?.id === model.id) return []')
  })

  it('keeps the foreground reader and exposes clickable chronological title strips', async () => {
    const stack = await readFile(
      resolve('src/features/pets/nyxus/components/NodePaperStack.vue'),
      'utf8',
    )
    expect(stack).toContain('@wheel.stop')
    expect(stack).not.toContain('@wheel.prevent.stop')
    expect(stack).not.toContain('function onWheel')
    expect(stack).toContain('class="paper-title-strip"')
    expect(stack).toContain('@click="selectIndex(index)"')
    expect(stack).toContain('index === currentIndex ? entries.length + 50')
    expect(stack).toContain('paperChronologicalLayer(index)')
    expect(stack).not.toContain('entries.length - index')
    expect(stack).toContain('class="paper-current"')
    expect(stack).toContain('class="paper-bundle"')
    expect(stack).toContain('paperTitleLayerPlacements(stackLayers.value, titleRail.value.height)')
    expect(stack).toContain('paperVisibleLimits(')
    expect(stack).toContain('paper.offsetTop')
    expect(stack).toContain('paper.offsetHeight')
    expect(stack).toContain('paperBundlePageOffset(')
    expect(stack).toContain('zIndex: String(bundleLayer(bundle))')
    expect(stack).toContain('<PaperGameCard')
    expect(stack).not.toContain('variant="paper"')
  })

  it('uses the dedicated pixel game card and hover-to-pin side intelligence card', async () => {
    const card = await readFile(
      resolve('src/features/pets/nyxus/components/PaperGameCard.vue'),
      'utf8',
    )
    expect(card).toContain('class="game-card-face"')
    expect(card).toContain('class="scroll-roller is-top"')
    expect(card).toContain('class="detail-tile"')
    expect(card).toContain('@pointerenter="openPreview(detail)"')
    expect(card).toContain('@click="togglePinned(detail)"')
    expect(card).toContain('class="paper-side-card"')
    expect(card).toContain('@keydown.esc.stop="closeDetail"')
    expect(card).toContain('<PaperPixelIcon')
    expect(card).not.toContain('ExecutionNodePopover')
    expect(card).toContain('class="process-stage-list"')
    expect(card).toContain('class="process-name-viewport"')
    expect(card).toContain('animation: process-name-loop 11s linear infinite')
    expect(card).toContain('<QuestionCard')
    expect(card).toContain('v-if="currentQuestion && chatId"')
    expect(card.match(/<PaperGameCard/g)).toHaveLength(1)
    expect(card).toContain(':model="activeStageCard!"')
    expect(card).not.toContain('PaperSkillPopover')
  })

  it('keeps pixel-font card content at readable sizes across reused paper windows', async () => {
    const [card, stack, question] = await Promise.all([
      readFile(resolve('src/features/pets/nyxus/components/PaperGameCard.vue'), 'utf8'),
      readFile(resolve('src/features/pets/nyxus/components/NodePaperStack.vue'), 'utf8'),
      readFile(resolve('src/features/agent/cards/QuestionCard.vue'), 'utf8'),
    ])
    expect(card).toContain('--paper-font-caption: 10px')
    expect(card).toContain('--paper-font-body: 13px')
    expect(card).toContain('--paper-font-title: 16px')
    expect(card).toContain('.side-card-body :deep(.tool-field > dd)')
    expect(stack).toContain('font-synthesis: none')
    expect(stack).toContain('700 13px/1.25 ui-monospace')
    expect(question).toContain('.question-card.is-paper {')
    expect(question).toContain('font-size: var(--paper-font-body, 13px)')
  })

  it('previews pointer scrubbing, commits on release, and restores on cancellation', async () => {
    const stack = await readFile(
      resolve('src/features/pets/nyxus/components/NodePaperStack.vue'),
      'utf8',
    )
    expect(stack).toContain('type="range"')
    expect(stack).toContain('aria-label="选择节点卡牌"')
    expect(stack).toContain('if (dragging.value) return')
    expect(stack).toContain('@pointerup="commitScrubber"')
    expect(stack).toContain('@change="commitScrubber"')
    expect(stack).toContain('@pointercancel="cancelScrubber"')
    expect(stack).toContain('if (canceledPointerChange.value)')
    expect(stack).toContain('previewIndex.value = committedIndex.value')
    expect(stack).toContain('@keydown.stop="onScrubberKeydown"')
    expect(stack).toContain("selectIndex(clamped, 'keyboard')")
  })

  it('uses retargetable short motion with keyboard and reduced-motion fallbacks', async () => {
    const stack = await readFile(
      resolve('src/features/pets/nyxus/components/NodePaperStack.vue'),
      'utf8',
    )
    expect(stack).toContain('transform 280ms var(--paper-ease-in-out)')
    expect(stack).toContain('opacity 220ms var(--paper-ease-out)')
    expect(stack).not.toContain('transition: all')
    expect(stack).toContain('@media (hover: hover) and (pointer: fine)')
    expect(stack).toContain('@media (prefers-reduced-motion: reduce)')
    expect(stack).toContain('transition: opacity 100ms linear')
    expect(stack).toContain('.node-paper-stage.is-keyboard-navigation')
  })
})
