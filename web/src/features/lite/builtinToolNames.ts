/**
 * 精简模式内置工具判定，与 src/agent/sense/index.ts 的 BUILTIN_SENSE_TOOLS 同步。
 * generate_* 是媒体生成器，虽不属于 sense.tools 清单，也在精简模式使用专有展示。
 */
const BUILTIN_TOOL_NAMES = new Set([
  'execute_command',
  'read_file',
  'write_file',
  'skill',
  'search_codebase',
  'history_recall',
  'spawn_role',
  'stop_child',
  'send_to_child',
  'update_todo',
  'memory_manage',
  'ask_user_question',
  'install_skill',
  'config_manage',
  'role_acceptance',
  'select_conversation',
  'generate_image',
  'generate_video',
  'generate_audio',
])

export function isBuiltinToolName(name: string): boolean {
  return BUILTIN_TOOL_NAMES.has(name)
}
