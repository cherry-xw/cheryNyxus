const mapping: Record<string, string[]> = {
  qq_read_file: ['qq_file_read.personal'], qq_group_read_file: ['qq_file_read.group'],
  qq_write_file: ['qq_file_write.personal'], qq_group_write_file: ['qq_file_write.group'],
  qq_lookup: ['qq_information.members','qq_information.voices'],
  qq_quote_reply: ['qq_interact.quote'], qq_mention: ['qq_interact.mention'], qq_react: ['qq_interact.reaction'], qq_poke: ['qq_interact.poke'], qq_voice_reply: ['qq_interact.voice'],
  qq_reminder_create: ['qq_reminder.create'], qq_reminder_list: ['qq_reminder.list'], qq_reminder_cancel: ['qq_reminder.cancel'],
  qq_group_memory_search: ['qq_memory_search'], qq_group_memory_manage: ['qq_memory_manage.local'], qq_memory_manage: ['qq_memory_manage.local'],
  qq_information: ['qq_history', ...['profile','group','members','member','notices','files','file_url','file_space','essence','albums','album_media','honor'].map(kind => `qq_information.${kind}`)],
}
export function convertQQToolGroups(groups: Record<string, string[]>) {
  const rank: Record<string, number> = { auto: 0, smart: 1, manual: 2 }
  const result: Record<string, string[]> = {}, changes: string[] = []
  for (const [group, entries] of Object.entries(groups)) {
    const levels = new Map<string, string>()
    for (const entry of entries) {
      const [name, level] = entry.split(':').map(value => value.trim())
      if (!name || level && !(level in rank)) throw new Error('INVALID_TOOL_SELECTION')
      const targets = mapping[name] ?? [name]
      if (mapping[name]) changes.push(`${group}: ${name} → ${targets.join(', ')}`)
      for (const target of targets) {
        const old = levels.get(target)
        if (!levels.has(target) || rank[level || 'smart']! > rank[old || 'smart']!) levels.set(target, level || '')
      }
    }
    result[group] = [...levels].map(([name, level]) => level ? `${name}:${level}` : name)
  }
  changes.push('旧版自动补入但工具组未选择的业务能力不再开放；须由管理员在工具组明确选择')
  return { groups: result, changes }
}
