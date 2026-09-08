import type { ConfigApplyState, ConfigImpact, ConfigPreview } from '@chery/protocol'

const ROOT_LABELS: Record<string, string> = {
  assets: '资源文件',
  global: '全局设置',
  hooks: 'Hooks',
  llm: '大脑',
  mcp_servers: 'MCP 服务',
  media: '媒体服务',
  memory: '记忆设置',
  presets: '预设',
  roles: '角色',
  sense_groups: '感官组',
  server: '服务设置',
}

export function impactLabel(impact: ConfigImpact): string {
  try {
    const [root, ...parts] = JSON.parse(impact.resource) as string[]
    return [ROOT_LABELS[root ?? ''] ?? root, ...parts].filter(Boolean).join(' / ')
  } catch {
    return impact.resource
  }
}

export function impactNextStep(impact: ConfigImpact): string {
  if (impact.status === 'applied') return '无需操作'
  if (impact.status === 'failed') return '修正相关设置后再次保存；当前任务继续使用最后可用设置'
  if (impact.boundary === 'run') return '新任务会使用新设置，正在运行的任务结束前保持原设置'
  if (impact.boundary === 'tree') return '等待受影响任务到达可安全切换的位置'
  if (impact.boundary === 'resource') return '等待相关资源完成切换'
  if (impact.boundary === 'restart') return '等待任务和后台程序结束后自动重启'
  return '此项不能自动生效，请按原因处理'
}

export function destructiveTargetLabel(target: string): string {
  const [root, name] = target.split('/', 2)
  return `${ROOT_LABELS[root ?? ''] ?? root}${name ? ` / ${name}` : ''}`
}

export function previewRequiresConfirmation(preview: ConfigPreview): boolean {
  return (
    preview.destructiveTargets.length > 0 ||
    preview.impacts.some(
      (impact) =>
        impact.paths.some((path) => path.includes('/permissions')) ||
        !!impact.affectedRootChatIds?.length,
    )
  )
}

export function previewConfirmationMessage(preview: ConfigPreview): string {
  return [
    preview.destructiveTargets.length
      ? '删除生效后，相关任务不能再使用已删除的角色或预设。'
      : '当前任务暂时保留已有设置和能力，到达安全切换位置后采用新设置。',
    ...preview.destructiveTargets.map((target) => `删除：${destructiveTargetLabel(target)}`),
    ...preview.impacts.map((impact) =>
      [
        `${impactLabel(impact)}：${impact.reason || impactNextStep(impact)}`,
        impact.affectedRootChatIds?.length
          ? `受影响会话：${impact.affectedRootChatIds.join('、')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    '确认后直接保存，不会终止当前任务。',
  ].join('\n\n')
}

export function applyHeadline(state: ConfigApplyState): string {
  if (state.status === 'failed') return '设置已保存，部分内容生效失败'
  if (state.status === 'pending') return '设置已保存，正在等待生效'
  return state.impacts.length ? '设置已保存并生效' : '当前设置已全部生效'
}
