/**
 * 渲染器注册入口 + 分发组件。
 *
 * 职责：
 * 1. 注册内置工具的专用渲染器（声明式，一行代码）
 * 2. 提供 SenseCallRenderer 分发组件（动态加载 + 降级保护）
 * 3. 导出类型和工具函数
 */

import { defineComponent, defineAsyncComponent, type PropType, h } from 'vue'
import type { SenseCallRecord } from '@/domain/chat/projectionTypes'
import { registerRenderer, getRenderer, hasRenderer } from './registry'
import RiskBadge from '@/components/RiskBadge.vue'

// ============== 注册内置工具渲染器 ==============
// 每个内置工具一行声明，易于维护

registerRenderer('update_todo', () => import('./io/TodoRenderer.vue'))
registerRenderer('execute_command', () => import('./core/CommandRenderer.vue'))
registerRenderer('read_file', () => import('./io/FileReadRenderer.vue'))
registerRenderer('write_file', () => import('./io/FileWriteRenderer.vue'))
registerRenderer('generate_image', () => import('./io/MediaRenderer.vue'))
registerRenderer('generate_video', () => import('./io/MediaRenderer.vue'))
registerRenderer('generate_audio', () => import('./io/MediaRenderer.vue'))
registerRenderer('search_codebase', () => import('./core/SearchRenderer.vue'))
registerRenderer('spawn_role', () => import('./io/SpawnRenderer.vue'))
registerRenderer('skill', () => import('./core/SkillRenderer.vue'))
registerRenderer('ask_user_question', () => import('./core/QuestionRenderer.vue'))

// ============== 动态分发组件 ==============
import SenseCallBox from '../chat/SenseCallBox.vue'

/**
 * SenseCallRenderer：工具调用统一分发入口。
 *
 * 行为：
 * 1. 检查工具是否注册专用渲染器
 * 2. 有 → 异步加载专用渲染器
 * 3. 无/加载失败 → 使用通用 SenseCallBox
 *
 * 优势：
 * - MessageBubble 只需一个组件，无需 v-if 分支
 * - 内置工具渲染器按需加载（首屏优化）
 * - 渲染器加载失败自动降级（稳定性）
 */
export const SenseCallRenderer = defineComponent({
  name: 'SenseCallRenderer',
  props: {
    call: { type: Object as PropType<SenseCallRecord>, required: true },
    id: { type: String, required: false },
    defaultExpanded: { type: Boolean, required: false },
  },
  setup(props) {
    // 工具安全性标签：作为 named slot `risk` 注入渲染器标题行（各渲染器在标题行内放置
    // `<slot name="risk" />`，如单选工具放在「单选」标签后面）。compact 形态 = 纯 chip，
    // 判定明细在 title 提示里；完整判定仍可在节点树 hover 窗/审批卡片查看。
    // 一处覆盖 MessageBubble 折叠 popover 与展开列表两条路径。
    const riskSlot = () => h(RiskBadge, { auth: props.call.security, compact: true })

    // 快速路径：未注册工具直接用通用渲染器（避免异步开销）
    let innerRenderer: () => ReturnType<typeof h>
    if (!hasRenderer(props.call.name)) {
      innerRenderer = () =>
        h(
          SenseCallBox,
          { call: props.call, id: props.id, defaultExpanded: props.defaultExpanded },
          { risk: riskSlot },
        )
    } else {
      // 注册工具：异步加载专用渲染器
      const asyncComponent = defineAsyncComponent({
        loader: async () => {
          const renderer = await getRenderer(props.call.name)
          return renderer ?? SenseCallBox
        },
        loadingComponent: SenseCallBox, // 加载中显示通用渲染器（避免闪烁）
        errorComponent: SenseCallBox, // 加载失败降级
        delay: 0, // 立即显示 loading
      })

      innerRenderer = () =>
        h(
          asyncComponent,
          { call: props.call, id: props.id, defaultExpanded: props.defaultExpanded },
          { risk: riskSlot },
        )
    }

    return () => innerRenderer()
  },
})

// ============== 导出类型和工具函数 ==============
export * from './types'
export { registerRenderer, hasRenderer, getRenderer, getRegisteredTools } from './registry'
