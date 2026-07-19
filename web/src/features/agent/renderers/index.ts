/**
 * 渲染器注册入口 + 分发组件。
 *
 * 职责：
 * 1. 注册内置工具的专用渲染器（声明式，一行代码）
 * 2. 提供 SenseCallRenderer 分发组件（动态加载 + 降级保护）
 * 3. 导出类型和工具函数
 */

import { defineComponent, defineAsyncComponent, type PropType, h } from 'vue'
import type { SenseCallRecord } from '@/stores/agents'
import { registerRenderer, getRenderer, hasRenderer } from './registry'

// ============== 注册内置工具渲染器 ==============
// 每个内置工具一行声明，易于维护

registerRenderer('update_todo', () => import('./TodoRenderer.vue'))
registerRenderer('execute_command', () => import('./CommandRenderer.vue'))
registerRenderer('read_file', () => import('./FileReadRenderer.vue'))
registerRenderer('write_file', () => import('./FileWriteRenderer.vue'))
registerRenderer('generate_image', () => import('./MediaRenderer.vue'))
registerRenderer('generate_video', () => import('./MediaRenderer.vue'))
registerRenderer('generate_audio', () => import('./MediaRenderer.vue'))
registerRenderer('search_codebase', () => import('./SearchRenderer.vue'))
registerRenderer('spawn_role', () => import('./SpawnRenderer.vue'))
registerRenderer('skill', () => import('./SkillRenderer.vue'))
registerRenderer('ask_user_question', () => import('./QuestionRenderer.vue'))

// ============== 动态分发组件 ==============
import SenseCallBox from '../SenseCallBox.vue'

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
  },
  setup(props) {
    // 快速路径：未注册工具直接用通用渲染器（避免异步开销）
    if (!hasRenderer(props.call.name)) {
      return () => h(SenseCallBox, { call: props.call, id: props.id })
    }

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

    return () => h(asyncComponent, { call: props.call, id: props.id })
  },
})

// ============== 导出类型和工具函数 ==============
export * from './types'
export { registerRenderer, hasRenderer, getRenderer, getRegisteredTools } from './registry'
