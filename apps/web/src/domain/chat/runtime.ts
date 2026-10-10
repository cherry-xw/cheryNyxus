import type { ThinkingLevel } from '@/application/backend/public'

/** 每轮可切换的 runtime selection。 */
export interface RuntimeSelection {
  brain: string
  senseGroup: string
  mcpServers?: string[]
  /** 思考等级临时覆盖（可选）：不设置时用大脑配置默认档位；设置后本次会话按此档位发送。 */
  thinking?: ThinkingLevel
}

export interface RuntimeProvenance extends RuntimeSelection {
  brainModel?: string
  brainProvider?: string
}

export interface SessionRuntimeSelection {
  primary: RuntimeSelection
  roles: Record<string, RuntimeSelection>
}
