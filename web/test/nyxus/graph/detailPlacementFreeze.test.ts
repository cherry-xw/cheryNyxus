import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../../helpers/componentSource'

describe('node detail popover placement freeze', () => {
  it('freezes placement per show session instead of recomputing live', async () => {
    const controller = await readComponentSource(
      resolve('web/src/features/pets/nyxus/components/useMessageBranchTreeController.ts'),
      'utf8',
    )
    // 冻结契约：detailPlacement 读一次性快照，不直接重算 anchoredPopoverPositionBelow
    expect(controller).toContain('frozenDetailPlacement ??= decideDetailPlacement()')
    // 快照生命周期：切节点/重开显示会话时清空，实测高度同步清零不串位
    expect(controller).toContain('() => detailNode.value?.id')
    expect(controller).toContain('measuredDetailHeight.value = 0')
    // hover → pinned 切换不算新会话：清空只挂在 detailNode.id 变化上
    expect(controller).toContain('let frozenDetailPlacement: DetailPlacementDecision | null = null')
  })
})
