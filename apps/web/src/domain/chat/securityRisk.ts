/**
 * 工具安全判定 → 风险等级（纯函数域层）。
 * 被跨 feature 消费者复用（ApprovalCard / RiskBadge / MessageBubble 渲染 / RunningTools / ExecutionNodePopover /
 * LiteToolCallDetail），只依赖纯类型 → 放 domain/chat 而非 utils（见 web-frontend-architecture §2.2）。
 * 输入为最小结构（findings[].severity），与 ToolAuthorization（projectionTypes）和
 * ToolAuthorizationDto（agentApi wire DTO）双类型结构兼容。
 */
export type SecurityRiskLevel = 'unknown' | 'high' | 'medium' | 'safe'

/** RiskBadge / 渲染器共用的判定最小结构（只取判定与详情所需字段，兼容 ToolAuthorization / DTO）。 */
export interface ToolSecurityFindingShape {
  code?: string
  category?: string
  severity: string
  message?: string
  fragment?: string
  start?: number
  end?: number
}

export interface ToolSecurityShape {
  findings?: ToolSecurityFindingShape[]
}

/** 判定优先级：未知 > 高 > 中 > 安全（与 ApprovalCard 历史逻辑一致）。 */
export function riskLevelOf(auth?: ToolSecurityShape | null): SecurityRiskLevel {
  // 缺少判定只能说明旧数据/协议未提供，不能据此宣称工具安全。
  if (!auth) return 'unknown'
  const findings = auth?.findings ?? []
  if (findings.some((finding) => finding.severity === 'unknown')) return 'unknown'
  if (findings.some((finding) => finding.severity === 'high')) return 'high'
  if (findings.some((finding) => finding.severity === 'medium')) return 'medium'
  return 'safe'
}

export const RISK_LEVEL_LABEL: Record<SecurityRiskLevel, string> = {
  unknown: '未知',
  high: '高风险',
  medium: '中风险',
  safe: '安全',
}
