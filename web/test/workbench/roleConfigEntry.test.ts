import { readFile } from 'node:fs/promises'
import { readComponentSource } from '../helpers/componentSource'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 回归测试：小组角色编制入口迁移到右侧 rail（三视图共用）。
 *
 * 需求：树页面 composer 内的「小组角色编制」折叠面板移至右侧 rail 按钮组，
 * 替换原只读「角色列表」popout；composer 内不再内置该功能。这样树/对话/精简
 * 三视图都通过 rail 的同一入口打开可编辑的角色编制。
 *
 * 断言三类防回归：
 *  1. composer 不再有 ⚙ 按钮 / 折叠面板（rolesExpanded、role-configs-toggle 等已删除）；
 *  2. rail popout 改为承载可编辑的 role-summary-tag 标签行（非 readonly RoleConfigPopover）；
 *  3. rail 按钮的语义名改为「小组角色编制」，且外部点击关闭逻辑把编辑弹窗视为内部。
 */
describe('workbench role config entry migration', () => {
  it('removes the composer-embedded role config panel and keeps the rail entry editable', async () => {
    const [dialog, controller, dialogBody] = await Promise.all([
      readComponentSource(
        resolve('src/features/agent/workbench/WorkbenchDialog.vue'),
        'utf8',
      ),
      readComponentSource(
        resolve('src/features/agent/workbench/useWorkbenchDialogController.ts'),
        'utf8',
      ),
      readFile(resolve('web/src/features/agent/workbench/WorkbenchDialog.vue'), 'utf8'),
    ])

    // 1) composer 内不再内置小组角色编制（⚙ 触发器与折叠面板移除）。
    expect(dialog).not.toContain('nyxus-role-config-trigger')
    expect(dialog).not.toContain('rolesExpanded')
    expect(dialog).not.toContain('role-configs-toggle')

    // 2) rail popout 承载可编辑的角色编制标签行（三视图共用 rail 入口）。
    expect(dialog).toContain('aria-label="小组角色编制"')
    expect(dialog).toContain('class="nyxus-role-configs"')
    expect(dialog).toContain('class="role-tags"')
    expect(dialog).toContain('role-summary-tag')
    // rail 内 RoleConfigPopover 不再只读（可编辑角色编制）。
    expect(dialogBody).not.toContain('readonly')
    // rail 按钮语义名同步。
    expect(dialog).toContain('aria-label="小组角色编制"')

    // 3) 外部点击关闭：role-summary-tag 打开的编辑 el-popover（挂 body）视为 popout 内部，
    //    编辑时不被误关。
    expect(controller).toContain("t?.closest('.role-runtime-popper')")
  })

  it('keeps the rail role popout trigger and close scheduling intact', async () => {
    const dialog = await readComponentSource(
      resolve('src/features/agent/workbench/WorkbenchDialog.vue'),
      'utf8',
    )

    // 弹出/关闭交互保留（hover 展开、延迟关闭、交互锁定）。
    expect(dialog).toContain('@pointerenter="showRoleList"')
    expect(dialog).toContain('@pointerleave="scheduleRoleListClose"')
    expect(dialog).toContain('@pointerdown="roleListPinned = true"')
    expect(dialog).toContain('@click="toggleRoleList"')
  })
})
