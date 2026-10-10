import { z } from 'zod'
import { sense, type SenseResult } from '@/core/sense'
import { SupervisionLevel } from '@/core/config'
import { hashGenerator } from '@/utils/hash.js'

/** Todo 状态枚举 */
const TodoStatus = z.enum(['pending', 'in_progress', 'completed'])

/** 单个 Todo 项结构 */
const TodoItem = z.object({
  content: z.string().min(1, 'content 不能为空'),
  status: TodoStatus,
  activeForm: z.string().min(1).optional(),
})

const TodoWriteSchema = z.object({
  todos: z.array(TodoItem).describe('完整的任务列表，替换之前的列表'),
})

/** 状态图标映射 */
const STATUS_ICON = {
  pending: ' ',
  in_progress: '→',
  completed: '✓',
} as const

/**
 * 格式化 todos 为可读字符串
 * 格式：- [ ] pending
 *        - [→] in_progress (activeForm)
 *        - [✓] completed
 */
function formatTodos(todos: z.infer<typeof TodoWriteSchema>['todos']): string {
  return todos
    .map((t) => {
      const icon = STATUS_ICON[t.status]
      const suffix = t.activeForm ? ` (${t.activeForm})` : ''
      return `- [${icon}] ${t.content}${suffix}`
    })
    .join('\n')
}

export default sense(
  'update_todo',
  `创建和更新任务列表，用于跟踪当前工作进度

使用场景：
- 多步骤任务开始时，列出执行计划
- 复杂修改前，规划任务清单
- 进度更新时，标记完成状态

规则：
- 每次调用替换整个列表（非增量更新）
- 同一时刻最多一个 in_progress 任务
- completed 任务保留在列表中，不删除

输出格式示例：
- [ ] 待办任务
- [→] 进行中任务 (活动描述)
- [✓] 已完成任务`,
  TodoWriteSchema,
  async ({ todos }): Promise<SenseResult> => {
    if (todos.length === 0) {
      return {
        content: '任务列表已清空',
        hash: hashGenerator('todo', 'empty'),
      }
    }

    const formatted = formatTodos(todos)
    const hash = hashGenerator('todo', JSON.stringify(todos))
    const content = `任务列表已更新 (${todos.length} 项):\n${formatted}`

    return { content, hash }
  },
  SupervisionLevel.auto,
)
