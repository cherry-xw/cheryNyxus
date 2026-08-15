import { z } from 'zod'
import { SupervisionLevel } from '@/core/config'
import { sense, type SenseResult } from '@/core/sense'
import { recordConversationSelection } from '@/agent/shadow/conversationSelectionRegistry.js'

const SelectConversationSchema = z.object({
  chatId: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .describe('历史候选的 chatId；选择新对话时必须为 null'),
  confidence: z.number().min(0).max(1).describe('对选择结果的置信度，范围 0 到 1'),
  reason: z.string().trim().min(1).max(500).describe('选择该目标的简短理由'),
})

export default sense(
  'select_conversation',
  '结束当前会话路由流程。必须且只能调用一次；chatId 为 null 表示新建会话。',
  SelectConversationSchema,
  async (input, _shared, ctx): Promise<SenseResult> => {
    if (!ctx?.chatId) throw new Error('select_conversation 缺少 Shadow run id')
    // Sense middleware 的运行时条目擦除了 zod 泛型，不能依赖模型严格遵守工具 schema；
    // 在终止边界再次 parse，确保 trace/result 永远是规范化参数。
    const selection = SelectConversationSchema.parse(input)
    recordConversationSelection(ctx.chatId, selection)
    ctx.yieldTurn?.()
    return {
      content: selection.chatId ? `已选择历史会话 ${selection.chatId}。` : '已选择新建会话。',
    }
  },
  SupervisionLevel.auto,
)
