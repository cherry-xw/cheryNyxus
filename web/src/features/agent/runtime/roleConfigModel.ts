/**
 * 角色编制配置模型：brain / 感官组选择的只读查询与变更 helper（纯逻辑，无副作用）。
 *
 * 由 AgentDialog（useAgentDialogOptions，数据源是 ref）与 RoleConfigPopover
 * （数据源是 props）共用；两侧以访问器闭包注入数据源后解构，
 * 调用点保持 `brainConfig(name)` 等原有形态不变。
 */
import type {
  BrainInfo,
  ConfigDto,
  RuntimeSelection,
  SenseGroupOption,
  SenseToolInfo,
  ThinkingLevel,
} from '@/services/agentApi'

/** 角色配置数据源访问器（ref / props 均以 getter 注入，保持响应式读取）。 */
export interface RoleConfigSource {
  brains: () => readonly BrainInfo[]
  config: () => ConfigDto | null
  senseGroups: () => readonly SenseGroupOption[]
  senseTools: () => readonly SenseToolInfo[]
}

/**
 * 思考档位 → 中文标签（RoleConfigPopover 与工作台用量条共用同一表）。
 * 档位值来自 `.chery/model-catalog.yaml` 的 wire.thinking[].display，是开放字符串。
 */
export const THINKING_LABEL: Record<ThinkingLevel, string> = {
  off: '关闭',
  on: '开',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  // 目录 wire 自定义档位（如 DeepSeek 的 max），与常见档位合并全映射
  max: '最高',
  min: '最低',
  none: '无',
  auto: '自动',
  adaptive: '自适应',
  balanced: '均衡',
  standard: '标准',
  moderate: '适中',
  minimal: '极少',
  deep: '深度',
  extreme: '极限',
  ultra: '极致',
  turbo: '极速',
  full: '全力',
  always: '始终',
  verbose: '详细',
}

export function createRoleConfigModel(source: RoleConfigSource) {
  function brainInfo(name: string): BrainInfo | undefined {
    return source.brains().find((brain) => brain.name === name)
  }

  function brainConfig(name: string) {
    return source.config()?.llm.brain[name]
  }

  function supportsTools(brainName: string): boolean {
    return brainConfig(brainName)?.capabilities?.toolCall !== false
  }

  /** 切换大脑：目标大脑不支持工具时清空感官组与 MCP；否则感官组为空时兜底默认组。 */
  function selectBrain(selection: RuntimeSelection, brain: string): void {
    selection.brain = brain
    if (!supportsTools(brain)) {
      selection.senseGroup = ''
      selection.mcpServers = []
    } else if (!selection.senseGroup) {
      selection.senseGroup =
        source.senseGroups().find((g) => g.default)?.name ?? source.senseGroups()[0]?.name ?? ''
    }
  }

  function senseEntries(group: string): string[] {
    return source.config()?.sense_groups?.[group] ?? []
  }

  function senseName(entry: string): string {
    return entry.split(':')[0] ?? entry
  }

  function senseTool(entry: string): SenseToolInfo | undefined {
    return source.senseTools().find((tool) => tool.name === senseName(entry))
  }

  return { brainInfo, brainConfig, supportsTools, selectBrain, senseEntries, senseName, senseTool }
}
