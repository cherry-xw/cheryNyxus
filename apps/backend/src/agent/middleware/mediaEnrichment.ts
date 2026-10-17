import type { MiddlewareContext } from '@/core/middleware/types.js'
import type { LLMResponse } from '@/core/message/adapter.js'
import { planFileInputs, type FileInputProjection } from './fileInputPlanning.js'

/** 只生成本次模型请求的文件投影，不修改持久历史，不解释正文中的文件标记。 */
export async function enrichMediaInputs(ctx: MiddlewareContext, history: LLMResponse[]): Promise<FileInputProjection> {
  return planFileInputs(ctx, history)
}
