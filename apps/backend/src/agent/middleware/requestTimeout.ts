import { ClassifiedError } from '@/utils/error.js'

/** A model request deadline is a terminal decision, never a network retry. */
export class ModelRequestTimeoutError extends ClassifiedError {
  constructor(readonly timeoutMs: number) {
    super({
      message: `model request exceeded ${timeoutMs}ms`,
      userMessage: `本次模型请求超过 ${Math.round(timeoutMs / 1000)} 秒，已截断。已收到的内容仅供查看，不会作为完整回复参与后续对话。`,
      category: 'validation',
      source: 'brain',
    })
    this.name = 'ModelRequestTimeoutError'
  }
}
