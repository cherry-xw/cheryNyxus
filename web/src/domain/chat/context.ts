/** 上下文用量单段（镜像后端 token projection）。 */
export interface ContextSegment {
  tokens: number
  count?: number
  thinking?: number
}

/** 上下文用量 6 段分解。 */
export interface ContextBreakdown {
  system: ContextSegment
  userSystem: ContextSegment
  memory: ContextSegment
  skills: ContextSegment
  tools: ContextSegment
  conversation: ContextSegment
  total: number
  usage: number
}
