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
})
