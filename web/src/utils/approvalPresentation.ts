import { parseArgs } from './parseArgs'
import { toSenseNameZh } from './senseName'

export interface ApprovalPresentation {
  senseName: string
  actorLabel: string
  approvalLabel: string
  toolLabel: string
  operationLabel: string
  title: string
  summary: string
  target?: string
}

interface ToolPresentation {
  label: string
  operation: string
  targetKeys?: string[]
}

const TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  execute_command: {
    label: '命令执行',
    operation: '执行命令',
    targetKeys: ['description', 'command'],
  },
  bash: { label: '命令执行', operation: '执行命令', targetKeys: ['description', 'command'] },
  read_file: { label: '文件读取', operation: '读取文件', targetKeys: ['path'] },
  write_file: { label: '文件写入', operation: '写入文件', targetKeys: ['path'] },
  search_codebase: {
    label: '代码搜索',
    operation: '搜索代码',
    targetKeys: ['query', 'pattern', 'path'],
  },
  skill: { label: '技能管理', operation: '加载技能', targetKeys: ['name', 'skill'] },
  history_recall: { label: '会话历史', operation: '检索会话历史', targetKeys: ['query'] },
  spawn_role: {
    label: '角色协作',
    operation: '派发子任务',
    targetKeys: ['role', 'roleName', 'task'],
  },
  spawn_subagent: {
    label: '角色协作',
    operation: '派发子任务',
    targetKeys: ['role', 'roleName', 'task'],
  },
  stop_child: { label: '角色协作', operation: '停止子角色', targetKeys: ['chatId'] },
  destroy_role: { label: '角色协作', operation: '停止子角色', targetKeys: ['chatId'] },
  send_to_child: { label: '角色协作', operation: '追加子任务', targetKeys: ['task'] },
  update_todo: { label: '任务管理', operation: '更新任务计划' },
  generate_image: { label: '媒体生成', operation: '生成图片', targetKeys: ['prompt'] },
  generate_video: { label: '媒体生成', operation: '生成视频', targetKeys: ['prompt'] },
  generate_audio: { label: '媒体生成', operation: '生成音频', targetKeys: ['prompt'] },
  memory_manage: { label: '记忆管理', operation: '管理项目记忆', targetKeys: ['name'] },
  ask_user_question: { label: '用户交互', operation: '向你提问' },
  install_skill: { label: '技能管理', operation: '安装技能', targetKeys: ['url', 'name'] },
  role_acceptance: { label: '角色验收', operation: '验收角色', targetKeys: ['roleName', 'role'] },
  select_conversation: { label: '会话路由', operation: '选择会话', targetKeys: ['chatId'] },
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

export function createApprovalPresentation(
  senseNameInput: unknown,
  argsInput: unknown,
): ApprovalPresentation {
  const senseName =
    typeof senseNameInput === 'string' && senseNameInput.trim() ? senseNameInput.trim() : '未知工具'
  const args = argumentRecord(argsInput)
  const tool = operationFor(senseName, args)
  const target = tool.targetKeys
    ?.map((key) => shortValue(args[key]))
    .find((value): value is string => value !== undefined)
  const targetText = target ? `：${target}` : ''
  return {
    senseName,
    actorLabel: '大模型发起',
    approvalLabel: '由你审批后执行',
    toolLabel: tool.label,
    operationLabel: tool.operation,
    title: `大模型需要${tool.operation}`,
    summary: `大模型请求通过「${tool.label}」${tool.operation}${targetText}。批准后才会执行。`,
    ...(target ? { target } : {}),
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
