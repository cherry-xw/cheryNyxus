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
 *  2. rail popout 改为承载纵向可编辑身份卡（非 readonly RoleConfigPopover）；
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

    // 2) rail popout 承载纵向可编辑身份卡（三视图共用 rail 入口）。
    expect(dialog).toContain('aria-label="小组角色编制"')
    expect(dialog).toContain('class="nyxus-role-configs"')
    expect(dialog).toContain('class="role-tags role-stack-list"')
    expect(dialog).toContain('class="role-stack-item"')
    expect(dialog).toContain('class="role-stack-nameplate"')
    // 名字标签并入卡片内部（一个整体，随卡片同一 transform 移动），不再有独立覆盖层。
    expect(dialog).not.toContain('role-stack-nameplates')
    expect(dialog).toContain('Math.max(0, activeHeight - peek - ROLE_STACK_OVERLAP) : 0')
    expect(dialog).toContain('只把它之前的卡片向 Y 轴下方移动')
    expect(dialog).toContain('(items.length - 1 - index) * peek + (index < active ? expandedDistance : 0)')
    expect(dialog).not.toContain('positions[index] = 0')
    expect(dialog).toContain('class="workbench-role-card"')
    expect(dialog).toContain('v-for="([role, selection], index) in orderedRoleSelections"')
    expect(dialog).toContain('zIndex: String(100 - index)')
    expect(dialog).toContain('new ResizeObserver(updateRoleStackLayout)')
    expect(dialog).not.toContain('index === activeRoleStackIndex.value ? 20')
    // rail 内 RoleConfigPopover 不再只读（可编辑角色编制）。
    expect(dialogBody).not.toContain('readonly')
    // rail 按钮语义名同步。
    expect(dialog).toContain('aria-label="小组角色编制"')

    // 3) 外部点击关闭：身份卡本身位于 popout 内，编辑时不被误关。
    expect(controller).toContain("t?.closest('.nyxus-role-popout')")
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

  it('renders complete editable role cards with direct model choices', async () => {
    const [dialog, roleCard] = await Promise.all([
      readComponentSource(resolve('src/features/agent/workbench/WorkbenchDialog.vue'), 'utf8'),
      readFile(resolve('web/src/features/agent/runtime/RoleConfigPopover.vue'), 'utf8'),
    ])

    expect(dialog).toContain('<RoleConfigPopover')
    expect(roleCard).toContain('class="role-card terraria-role-card"')
    expect(roleCard).toContain('showRoleName?: boolean')
    expect(roleCard).toContain('role="radiogroup" aria-label="选择模型"')
    expect(roleCard).toContain('@click="selectBrain(localSelection, brain.name)"')
    expect(roleCard).toContain('class="brain-facts"')
    expect(roleCard).toContain('roleUsage?:')
    expect(roleCard).toContain('role-usage-fact')
    expect(roleCard).toContain('class="profile-sense-icons"')
    expect(roleCard).toContain('class="role-card terraria-role-card"')
    expect(roleCard).toContain('--terraria-gold')
    expect(roleCard).toContain('class="choice-option"')
  })
})
