import { nextTick, ref, watch, type Ref } from 'vue'
import { agentApi } from '@/application/backend/public'
import { useChatSessionsStore } from '@/application/public'
import { toSkillCommands, serializeFileMention, canReferenceFile } from '../composables/commands'
import { instructionQuery } from './instructionQuery'

export interface InputSuggestion {
  label: string
  description: string
  token: string
}
export function useInstructionSuggestions(options: {
  chatId: () => string
  preset?: () => string | undefined
  text: () => string
  input: Ref<HTMLTextAreaElement | null>
  update: (value: string) => void
  resize: () => void
}) {
  const sessions = useChatSessionsStore()
  const suggestions = ref<InputSuggestion[]>([])
  const activeIndex = ref(0)
  const message = ref('')
  const opened = ref(false)
  let commands: InputSuggestion[] = []
  let roles: InputSuggestion[] = []
  let sequence = 0
  let query: ReturnType<typeof instructionQuery> = null
  watch(
    options.chatId,
    async (chatId, _, cleanup) => {
      let cancelled = false
      cleanup(() => {
        cancelled = true
      })
      commands = []
      roles = []
      suggestions.value = []
      opened.value = false
      sequence++
      if (!chatId) return
      const results = await Promise.allSettled([
        agentApi.listCommands(),
        agentApi.listSkills({ page: 1, pageSize: 200, plugin: '*' }),
        agentApi.getConfig(),
      ])
      if (cancelled) return
      commands =
        results[0].status === 'fulfilled'
          ? results[0].value.map((c) => ({
              label: '/' + c.name,
              description: c.description,
              token: '[[command:/' + c.name + ']]',
            }))
          : []
      if (results[1].status === 'fulfilled')
        commands.push(
          ...toSkillCommands(results[1].value.skills).map((c) => ({
            label: c.name,
            description: c.description,
            token: '[[command:' + c.name + ']]',
          })),
        )
      roles = []
      if (results[2].status === 'fulfilled') {
        const config = results[2].value
        const presetName = options.preset?.() ?? sessions.sessionsById[chatId]?.meta.preset
        const preset = presetName ? config.presets?.[presetName] : undefined
        roles = (preset?.roles ?? []).flatMap((name) => {
          const role = config.roles?.[name]
          return role?.mentionable &&
            role.kind !== 'shadow' &&
            name !== preset?.leader &&
            name !== preset?.detailRole
            ? [
                {
                  label: '@' + name,
                  description: role.description || '委派角色',
                  token: '[[role:@' + name + ']]',
                },
              ]
            : []
        })
      }
      if (options.input.value === document.activeElement) void refresh()
    },
    { immediate: true },
  )
  async function refresh(): Promise<void> {
    const version = ++sequence
    query = instructionQuery(
      options.text(),
      options.input.value?.selectionStart ?? options.text().length,
    )
    activeIndex.value = 0
    suggestions.value = []
    message.value = ''
    opened.value = !!query
    if (!query) return
    const needle = query.query.toLowerCase()
    if (query.trigger !== '&') {
      suggestions.value = (query.trigger === '/' ? commands : roles).filter((item) =>
        item.label.toLowerCase().includes(needle),
      )
      if (!suggestions.value.length) message.value = '没有匹配的可用选项'
      return
    }
    message.value = '正在读取工作区…'
    const slash = query.query.lastIndexOf('/')
    const directory = slash >= 0 ? query.query.slice(0, slash) : ''
    const filename = query.query.slice(slash + 1).toLowerCase()
    try {
      const result = await agentApi.listWorkspaceFiles(options.chatId(), directory)
      if (version !== sequence) return
      suggestions.value = result.entries
        .filter(
          (entry) => canReferenceFile(entry.path) && entry.name.toLowerCase().includes(filename),
        )
        .map((entry) => ({
          label: '&' + entry.path + (entry.kind === 'directory' ? '/' : ''),
          description:
            entry.kind === 'directory'
              ? '引用文件夹；输入目录/ 可继续查找'
              : '只引用路径，按需读取正文',
          token: serializeFileMention({ path: entry.path, kind: entry.kind }),
        }))
      message.value = suggestions.value.length
        ? result.nextOffset !== undefined
          ? '更多文件请使用文件列表'
          : ''
        : '没有匹配的文件'
    } catch (error) {
      if (version === sequence)
        message.value = error instanceof Error ? error.message : '无法读取工作区'
    }
  }
  function choose(item: InputSuggestion): void {
    if (!query) return
    const value = options.text()
    const inserted = item.token + ' '
    options.update(value.slice(0, query.start) + inserted + value.slice(query.end))
    const caret = query.start + inserted.length
    opened.value = false
    sequence++
    void nextTick(() => {
      options.input.value?.focus()
      options.input.value?.setSelectionRange(caret, caret)
      options.resize()
    })
  }
  function keydown(event: KeyboardEvent): boolean {
    if (event.isComposing || !opened.value) return false
    if (event.key === 'Escape') {
      opened.value = false
      sequence++
      event.preventDefault()
      event.stopPropagation()
      return true
    }
    const length = suggestions.value.length
    if (length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key) && !event.shiftKey) {
      event.preventDefault()
      if (event.key === 'ArrowDown') activeIndex.value = (activeIndex.value + 1) % length
      else if (event.key === 'ArrowUp')
        activeIndex.value = (activeIndex.value - 1 + length) % length
      else choose(suggestions.value[activeIndex.value]!)
      return true
    }
    return false
  }
  return { suggestions, activeIndex, message, opened, refresh, choose, keydown }
}
