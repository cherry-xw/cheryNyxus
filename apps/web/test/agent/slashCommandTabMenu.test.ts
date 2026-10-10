import { readComponentSource } from '../helpers/componentSource'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 回归测试：对话/精简模式的「/」指令菜单升级为与树页面一致的 tab 栏（指令/技能/组合技）。
 *
 * 需求：树页面输入「/」弹出带 tab 栏的技能指令选择；对话、精简模式要有同样效果，
 * 选中后插入的 token 与树页面完全一致（[[command:/name]]）。
 *
 * 断言防回归：
 *  1. useInstructionSuggestions 按树页面同源分组（builtin/skill/combo），token 用 serializeCommandToken；
 *  2. InstructionSuggestions 渲染 tab 栏，点击 tab 触发 selectTab；
 *  3. ConversationView / LiteView 都向菜单组件传入 tabs/activeTab 并监听 selectTab。
 */
describe('conversation and lite slash-command tab menu', () => {
  it('groups slash suggestions into instruction/skill/combo tabs with tree-consistent tokens', async () => {
    const hook = await readComponentSource(
      resolve('src/features/agent/composer/useInstructionSuggestions.ts'),
      'utf8',
    )

    // 三档分组：内置指令 / 独立技能 / 插件组合技（与树页面 useAgentDialogOptions 同源）。
    expect(hook).toContain("id: 'builtin', label: '指令'")
    expect(hook).toContain("id: 'skill', label: '技能'")
    expect(hook).toContain("id: 'combo', label: '组合技'")
    expect(hook).toContain("command.kind === 'builtin' ? 'builtin' : command.plugin ? 'combo' : 'skill'")
    // token 与树页面一致（serializeCommandToken = [[command:/name]]）。
    expect(hook).toContain('serializeCommandToken(command)')
    // 左右键切 tab。
    expect(hook).toContain("event.key === 'ArrowLeft' || event.key === 'ArrowRight'")
    expect(hook).toContain('moveTab(')
  })

  it('renders the tab bar and forwards tab selection in both views', async () => {
    const [component, conversation, lite] = await Promise.all([
      readComponentSource(
        resolve('src/features/agent/composer/InstructionSuggestions.vue'),
        'utf8',
      ),
      readComponentSource(
        resolve('src/features/agent/workbench/ConversationView.vue'),
        'utf8',
      ),
      readComponentSource(resolve('src/features/lite/LiteView.vue'), 'utf8'),
    ])

    // 组件渲染 tab 栏（tablist + 每档 tab 按钮），点击转发 selectTab。
    expect(component).toContain('instruction-tabs')
    expect(component).toContain('role="tablist"')
    expect(component).toContain('@click="emit(\'selectTab\', tab.id)"')
    expect(component).toContain('role="tab"')

    // 两个视图都接入 tabs / activeTab / selectTab。
    expect(conversation).toContain(':tabs="menu.tabs.value"')
    expect(conversation).toContain(':active-tab="menu.activeTab.value"')
    expect(conversation).toContain('@select-tab="menu.selectTab"')
    expect(lite).toContain(':tabs="menu.tabs.value"')
    expect(lite).toContain(':active-tab="menu.activeTab.value"')
    expect(lite).toContain('@select-tab="menu.selectTab"')
  })
})
