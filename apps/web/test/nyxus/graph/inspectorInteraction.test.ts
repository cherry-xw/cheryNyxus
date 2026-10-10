import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../../helpers/componentSource'

describe('node inspector interaction', () => {
  it('anchors to visual bounds and cycles a pinned inspector through size presets', async () => {
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
    expect(controller).toContain('function detailSizePresets()')
    expect(controller).toContain("{ width: 640, height: 520, label: 'S' }")
    expect(controller).toContain("{ width: 800, height: 650, label: 'M' }")
    expect(controller).toContain("{ width: 960, height: 780, label: 'L' }")
    expect(controller).toContain('function cycleDetailSize(): void')
    expect(controller).not.toContain('function startDetailResize')
    // 常驻窗口固定后点击普通节点 → 窗口内容切换到该节点。
    expect(controller).toContain('pinnedDetailNodeId.value && hasNodeHoverDetail(node)')
    expect(tree).not.toContain("v-for=\"direction in ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']")
    expect(tree).toContain('@cycle-size="cycleDetailSize"')
    expect(styles).toContain('.node-popover.is-pinned:not(.is-wrap)')
    expect(styles).toContain('--popover-content-font')
    expect(styles).toContain('.node-popover.is-size-s')
    expect(styles).toContain('.node-popover.is-size-l')
    // 换行开关的 tip 必须具体说明两种状态，不得退回模糊的“自动换行”。
    expect(styles).toContain('保持长行并横向滚动：代码、命令、文件内容保留原始长行')
    expect(styles).toContain('自动换行：代码、命令、文件内容自动折行')
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
