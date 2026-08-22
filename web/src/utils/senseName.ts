/**
 * sense 英文名 → 中文显示名（待确认/审批标题共用；PendingOperationsPanel / WorkspaceSessionBrowser）。
 * 未知工具回退原名；缺失回退「工具调用」。
 */
export const SENSE_NAME_ZH: Record<string, string> = {
  config_manage: '配置管理',
  execute_command: '执行命令',
  bash: '执行命令',
  read_file: '读取文件',
  write_file: '写入文件',
  search_codebase: '搜索代码',
  ask_user_question: '提问',
  spawn_role: '委派角色',
  spawn_subagent: '委派角色',
  destroy_role: '结束角色',
  destroy_subagent: '结束角色',
  history_recall: '历史记忆',
  skill: '执行技能',
  install_skill: '安装技能',
  memory: '记忆管理',
  media: '媒体',
  update_todo: '更新任务',
  todo: '任务清单',
  complete: '完成',
}

/** 取 sense 中文显示名；raw 为空 → 「工具调用」，未收录 → 原名。 */
export function toSenseNameZh(raw: string | undefined): string {
  if (!raw) return '工具调用'
  return SENSE_NAME_ZH[raw] ?? raw
}
