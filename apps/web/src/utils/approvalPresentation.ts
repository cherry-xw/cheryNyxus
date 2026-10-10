import { parseArgs } from './parseArgs'
import { toSenseNameZh } from './senseName'

export interface ApprovalPresentation {
  senseName: string
  toolLabel: string
  operationLabel: string
  title: string
  target?: string
  changes: ToolChangePresentation[]
  /** 该工具类型需要用户重点核对的关键信息，按重要程度排序优先展示。 */
  keyFacts: ToolKeyFact[]
}

interface ToolPresentation {
  label: string
  operation: string
  targetKeys?: string[]
  /** 关键信息定义：kind='tool' 输出工具名称（= label）；kind='arg' 从参数取值，缺值跳过。 */
  keyFacts?: ToolKeyFactDef[]
}

/** 一条关键信息：回答「哪个工具 + 具体目标」的核对要点。 */
export interface ToolKeyFact {
  label: string
  value: string
}

/** 关键信息条目定义（声明式）：tool = 工具名称；arg = 从参数提取并附中文标签。 */
type ToolKeyFactDef = { kind: 'tool' } | { kind: 'arg'; arg: string; label: string }

/** One concrete, user-readable change within a structured tool call. */
export interface ToolChangePresentation {
  label: string
  detail: string
}

/** Shared display model for every tool surface: approval, node tree, cards and Lite. */
export interface ToolRunPresentation {
  toolLabel: string
  operationLabel: string
  target?: string
  changes: ToolChangePresentation[]
  keyFacts: ToolKeyFact[]
}

const TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  execute_command: {
    label: '命令执行',
    operation: '执行命令',
    targetKeys: ['description', 'command'],
    keyFacts: [
      { kind: 'tool' },
      { kind: 'arg', arg: 'command', label: '命令内容' },
      { kind: 'arg', arg: 'description', label: '用途说明' },
    ],
  },
  bash: {
    label: '命令执行',
    operation: '执行命令',
    targetKeys: ['description', 'command'],
    keyFacts: [
      { kind: 'tool' },
      { kind: 'arg', arg: 'command', label: '命令内容' },
      { kind: 'arg', arg: 'description', label: '用途说明' },
    ],
  },
  read_file: {
    label: '文件读取',
    operation: '读取文件',
    targetKeys: ['path'],
    keyFacts: [{ kind: 'tool' }, { kind: 'arg', arg: 'path', label: '文件路径' }],
  },
  write_file: {
    label: '文件写入',
    operation: '写入文件',
    targetKeys: ['path'],
    keyFacts: [{ kind: 'tool' }, { kind: 'arg', arg: 'path', label: '文件路径' }],
  },
  search_codebase: {
    label: '代码搜索',
    operation: '搜索代码',
    targetKeys: ['query', 'pattern', 'path'],
    keyFacts: [
      { kind: 'tool' },
      { kind: 'arg', arg: 'query', label: '搜索关键词' },
      { kind: 'arg', arg: 'pattern', label: '匹配规则' },
    ],
  },
  skill: {
    label: '技能管理',
    operation: '加载技能',
    targetKeys: ['name', 'skill'],
    keyFacts: [
      { kind: 'tool' },
      { kind: 'arg', arg: 'name', label: '技能名称' },
      { kind: 'arg', arg: 'skill', label: '技能名称' },
    ],
  },
  history_recall: {
    label: '会话历史',
    operation: '检索会话历史',
    targetKeys: ['query'],
    keyFacts: [{ kind: 'tool' }, { kind: 'arg', arg: 'query', label: '检索关键词' }],
  },
  spawn_role: {
    label: '角色协作',
    operation: '派发子任务',
    targetKeys: ['role', 'roleName', 'task'],
    keyFacts: [
      { kind: 'tool' },
      { kind: 'arg', arg: 'roleName', label: '角色名称' },
      { kind: 'arg', arg: 'role', label: '角色名称' },
      { kind: 'arg', arg: 'task', label: '任务内容' },
    ],
  },
  spawn_subagent: {
    label: '角色协作',
    operation: '派发子任务',
    targetKeys: ['role', 'roleName', 'task'],
    keyFacts: [
      { kind: 'tool' },
      { kind: 'arg', arg: 'roleName', label: '角色名称' },
      { kind: 'arg', arg: 'role', label: '角色名称' },
      { kind: 'arg', arg: 'task', label: '任务内容' },
    ],
  },
  stop_child: {
    label: '角色协作',
    operation: '停止子角色',
    targetKeys: ['chatId'],
    keyFacts: [{ kind: 'tool' }, { kind: 'arg', arg: 'chatId', label: '会话标识' }],
  },
  destroy_role: {
    label: '角色协作',
    operation: '停止子角色',
    targetKeys: ['chatId'],
    keyFacts: [{ kind: 'tool' }, { kind: 'arg', arg: 'chatId', label: '会话标识' }],
  },
  send_to_child: {
    label: '角色协作',
    operation: '追加子任务',
    targetKeys: ['task'],
    keyFacts: [{ kind: 'tool' }, { kind: 'arg', arg: 'task', label: '任务内容' }],
  },
  update_todo: { label: '任务管理', operation: '更新任务计划', keyFacts: [{ kind: 'tool' }] },
  generate_image: {
    label: '媒体生成',
    operation: '生成图片',
    targetKeys: ['prompt'],
    keyFacts: [{ kind: 'tool' }, { kind: 'arg', arg: 'prompt', label: '生成要求' }],
  },
  generate_video: {
    label: '媒体生成',
    operation: '生成视频',
    targetKeys: ['prompt'],
    keyFacts: [{ kind: 'tool' }, { kind: 'arg', arg: 'prompt', label: '生成要求' }],
  },
  generate_audio: {
    label: '媒体生成',
    operation: '生成音频',
    targetKeys: ['prompt'],
    keyFacts: [{ kind: 'tool' }, { kind: 'arg', arg: 'prompt', label: '生成要求' }],
  },
  memory_manage: {
    label: '记忆管理',
    operation: '管理项目记忆',
    targetKeys: ['name'],
    keyFacts: [{ kind: 'tool' }, { kind: 'arg', arg: 'name', label: '记忆名称' }],
  },
  ask_user_question: { label: '询问用户', operation: '询问用户', keyFacts: [{ kind: 'tool' }] },
  install_skill: {
    label: '技能管理',
    operation: '安装技能',
    targetKeys: ['url', 'name'],
    keyFacts: [
      { kind: 'tool' },
      { kind: 'arg', arg: 'url', label: '来源地址' },
      { kind: 'arg', arg: 'name', label: '技能名称' },
    ],
  },
  role_acceptance: {
    label: '角色验收',
    operation: '验收角色',
    targetKeys: ['roleName', 'role'],
    keyFacts: [
      { kind: 'tool' },
      { kind: 'arg', arg: 'roleName', label: '角色名称' },
      { kind: 'arg', arg: 'role', label: '角色名称' },
    ],
  },
  select_conversation: {
    label: '会话路由',
    operation: '选择会话',
    targetKeys: ['chatId'],
    keyFacts: [{ kind: 'tool' }, { kind: 'arg', arg: 'chatId', label: '会话标识' }],
  },
}

const CONFIG_ACTIONS: Record<string, string> = {
  get: '获取配置参数',
  patch: '修改配置参数',
  save: '保存配置参数（旧操作）',
  rollback: '恢复配置备份',
  asset_get: '获取角色资产',
  asset_save: '保存角色资产',
  asset_archive: '归档角色资产',
}

const ACTION_LABELS: Record<string, string> = {
  ...CONFIG_ACTIONS,
  add: '新增',
  remove: '移除',
  update: '更新',
  list: '查看列表',
  history: '查看历史',
  stage: '准备候选项',
  commit: '确认安装',
  accept: '批准',
  reject: '拒绝',
}

const ARGUMENT_LABELS: Record<string, string> = {
  action: '操作行为',
  path: '文件路径',
  root: '工作目录',
  cwd: '工作目录',
  command: '命令内容',
  description: '用途说明',
  content: '内容',
  offset: '起始位置',
  limit: '数量限制',
  query: '搜索关键词',
  pattern: '匹配规则',
  mode: '执行模式',
  timeout: '超时时间',
  timeoutMs: '超时时间',
  baseRevision: '配置版本',
  operations: '配置变更',
  backup: '备份文件',
  assetPath: '资产路径',
  resource: '资源类型',
  id: '资源标识',
  value: '新值',
  role: '角色',
  roleName: '角色名称',
  task: '任务内容',
  chatId: '会话标识',
  prompt: '生成要求',
  name: '名称',
  url: '来源地址',
  scope: '作用范围',
  recursive: '包含子项',
  wait: '等待完成',
}

function argumentRecord(args: unknown): Record<string, unknown> {
  const parsed = parseArgs(args).parsed
  if (!parsed) return {}
  return Object.fromEntries(parsed.entries.map((entry) => [entry.key, entry.value]))
}

function shortValue(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).trim().replace(/\s+/g, ' ')
  if (!text) return undefined
  return text.length > 72 ? `${text.slice(0, 69)}…` : text
}

function operationFor(senseName: string, args: Record<string, unknown>): ToolPresentation {
  if (senseName === 'config_manage') {
    const action = typeof args.action === 'string' ? args.action : ''
    return {
      label: '配置管理',
      operation: CONFIG_ACTIONS[action] ?? '执行配置操作',
      targetKeys: action.startsWith('asset_') ? ['assetPath'] : ['backup'],
    }
  }
  if (senseName === 'memory_manage' && typeof args.action === 'string') {
    const action = ACTION_LABELS[args.action]
    if (action) return { ...TOOL_PRESENTATIONS.memory_manage!, operation: `${action}项目记忆` }
  }
  return (
    TOOL_PRESENTATIONS[senseName] ?? {
      label: toSenseNameZh(senseName),
      operation: `执行「${toSenseNameZh(senseName)}」操作`,
    }
  )
}

function configChanges(args: Record<string, unknown>): ToolChangePresentation[] {
  if (!Array.isArray(args.operations)) return []
  return args.operations.flatMap((raw): ToolChangePresentation[] => {
    if (!raw || typeof raw !== 'object') return []
    const operation = raw as Record<string, unknown>
    const name = shortValue(operation.name) ?? '未命名项'
    switch (operation.op) {
      case 'putBrain':
        return [{ label: '模型配置', detail: `将“${name}”更新为本次提交的模型配置` }]
      case 'removeBrain':
        return [{ label: '模型配置', detail: `删除模型配置“${name}”` }]
      case 'putRole': {
        const role = argumentRecord(operation.role)
        const brain = shortValue(role.brain)
        return [
          {
            label: '角色配置',
            detail: `将角色“${name}”${brain ? `使用模型“${brain}”` : '更新为本次提交的配置'}`,
          },
        ]
      }
      case 'removeRole':
        return [{ label: '角色配置', detail: `删除角色“${name}”` }]
      case 'putPreset':
        return [{ label: '预设配置', detail: `将预设“${name}”更新为本次提交的配置` }]
      case 'removePreset':
        return [{ label: '预设配置', detail: `删除预设“${name}”` }]
      case 'putSenseGroup': {
        const senses = Array.isArray(operation.senses)
          ? operation.senses.filter((item): item is string => typeof item === 'string')
          : []
        return [
          {
            label: '工具组',
            detail: `将工具组“${name}”设置为：${senses.map(toSenseNameZh).join('、') || '空'}`,
          },
        ]
      }
      case 'removeSenseGroup':
        return [{ label: '工具组', detail: `删除工具组“${name}”` }]
      default:
        return [{ label: '配置变更', detail: `执行配置操作“${String(operation.op ?? '未知')}”` }]
    }
  })
}

/** 解析关键信息：按声明顺序取值；同名标签只保留第一条有值的（如 role/roleName 二选一）。
 *  description 被 parseArgs 单独提取（折叠标题用），此处自行补回供「用途说明」类关键信息读取。 */
function resolveKeyFacts(tool: ToolPresentation, argsInput: unknown): ToolKeyFact[] {
  if (!tool.keyFacts?.length) return []
  const args = argumentRecord(argsInput)
  const description = parseArgs(argsInput).parsed?.description
  if (description) args.description = description
  const facts: ToolKeyFact[] = []
  const seen = new Set<string>()
  for (const def of tool.keyFacts) {
    const fact: ToolKeyFact | undefined =
      def.kind === 'tool'
        ? { label: '工具名称', value: tool.label }
        : (() => {
            const value = shortValue(args[def.arg])
            return value ? { label: def.label, value } : undefined
          })()
    if (!fact || seen.has(fact.label)) continue
    seen.add(fact.label)
    facts.push(fact)
  }
  return facts
}

export function createToolRunPresentation(
  senseNameInput: unknown,
  argsInput: unknown,
): ToolRunPresentation {
  const senseName =
    typeof senseNameInput === 'string' && senseNameInput.trim() ? senseNameInput.trim() : '未知工具'
  const args = argumentRecord(argsInput)
  const tool = operationFor(senseName, args)
  const target = tool.targetKeys
    ?.map((key) => shortValue(args[key]))
    .find((value): value is string => value !== undefined)
  const genericTarget =
    target ??
    shortValue(args.path) ??
    shortValue(args.assetPath) ??
    shortValue(args.query) ??
    shortValue(args.command) ??
    shortValue(args.task) ??
    shortValue(args.prompt)
  const changes =
    senseName === 'config_manage' && args.action === 'patch' ? configChanges(args) : []
  return {
    toolLabel: tool.label,
    operationLabel: tool.operation,
    ...(genericTarget ? { target: genericTarget } : {}),
    changes,
    keyFacts: resolveKeyFacts(tool, argsInput),
  }
}

export function createApprovalPresentation(
  senseNameInput: unknown,
  argsInput: unknown,
): ApprovalPresentation {
  const senseName =
    typeof senseNameInput === 'string' && senseNameInput.trim() ? senseNameInput.trim() : '未知工具'
  const tool = createToolRunPresentation(senseName, argsInput)
  const target = tool.target
  return {
    senseName,
    toolLabel: tool.toolLabel,
    operationLabel: tool.operationLabel,
    title: `大模型需要${tool.operationLabel}`,
    ...(target ? { target } : {}),
    changes: tool.changes,
    keyFacts: tool.keyFacts,
  }
}

export function toArgumentKeyLabel(key: string): string {
  return ARGUMENT_LABELS[key] ?? key.replace(/_/g, ' ')
}

export function formatApprovalArgumentScalar(key: string, value: unknown): string {
  if (value === null || value === undefined) return '未设置'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (key === 'action' && typeof value === 'string') {
    const label = ACTION_LABELS[value]
    return label ? `${label}（${value}）` : value
  }
  return String(value)
}
