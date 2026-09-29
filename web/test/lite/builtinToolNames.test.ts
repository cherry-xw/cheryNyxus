import { describe, expect, it } from 'vitest'
import { isBuiltinToolName } from '../../src/features/lite/builtinToolNames'

describe('isBuiltinToolName', () => {
  it('recognizes every built-in sense and Lite media tool', () => {
    const names = [
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
    ]

    for (const name of names) expect(isBuiltinToolName(name), name).toBe(true)
  })

  it('keeps external and MCP tools on the generic display path', () => {
    expect(isBuiltinToolName('web_search')).toBe(false)
    expect(isBuiltinToolName('mcp__filesystem__read_file')).toBe(false)
    expect(isBuiltinToolName('custom_report_tool')).toBe(false)
  })
})
