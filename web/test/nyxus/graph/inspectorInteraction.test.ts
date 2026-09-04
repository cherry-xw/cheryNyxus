import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../../helpers/componentSource'

describe('node inspector interaction', () => {
  it('anchors to visual bounds and upgrades a click to one resizable inspector', async () => {
    const [controller, tree, styles] = await Promise.all([
      readComponentSource(
        resolve('web/src/features/pets/nyxus/components/useMessageBranchTreeController.ts'),
        'utf8',
      ),
      readComponentSource(
        resolve('web/src/features/pets/nyxus/components/MessageBranchTree.vue'),
        'utf8',
      ),
      readComponentSource(
        resolve('web/src/features/pets/nyxus/components/ExecutionNodePopover.vue'),
        'utf8',
      ),
    ])
    expect(controller).toContain('const bounds = node.visualBounds')
    expect(controller).toContain('const detailSize = ref({ width: 640, height: 520 })')
    expect(controller).toContain('Math.max(360')
    expect(controller).toContain('Math.max(240')
    expect(tree).toContain("v-for=\"direction in ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']")
    expect(styles).toContain('.node-popover.is-pinned:not(.is-wrap)')
    expect(styles).toContain('@media (forced-colors: active)')
  })

  it('promotes a hovered detail window to a persistent window when its title bar is dragged', async () => {
    const [controller, tree, popoverController] = await Promise.all([
      readComponentSource(
        resolve('web/src/features/pets/nyxus/components/useMessageBranchTreeController.ts'),
        'utf8',
      ),
      readComponentSource(
        resolve('web/src/features/pets/nyxus/components/MessageBranchTree.vue'),
        'utf8',
      ),
      readComponentSource(
        resolve('web/src/features/pets/nyxus/components/useExecutionNodePopoverController.ts'),
        'utf8',
      ),
    ])

    expect(tree).toContain(':draggable="true"')
    expect(controller).toContain('if (!pinnedDetailNodeId.value && node)')
    expect(controller).toContain('detailManualPos.value = { left: baseLeft, top: baseTop }')
    expect(controller).toContain('cancelDetailHide()')
    expect(popoverController).toContain('const DRAG_START_DISTANCE = 4')
    expect(popoverController).toContain('if (dragStarted) emit(\'dragEnd\')')
  })
})
