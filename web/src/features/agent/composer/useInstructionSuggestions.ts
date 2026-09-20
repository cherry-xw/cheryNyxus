import { nextTick, ref, watch, type Ref } from 'vue'
import { agentApi } from '@/application/backend/public'
import { useChatSessionsStore } from '@/application/public'
import {
  toSkillCommands,
  serializeFileMention,
  serializeCommandToken,
  canReferenceFile,
  type MessageCommand,
} from '../composables/commands'
import { instructionQuery } from './instructionQuery'

export interface InputSuggestion {
  label: string
  description: string
  token: string
}

/** 与树页面 command-tab 同源的三档指令类型（内置指令 / 独立技能 / 插件组合技）。 */
export type InstructionTabId = 'builtin' | 'skill' | 'combo'

export interface InstructionTabOption {
  id: InstructionTabId
  label: string
  count: number
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
  const tabs = ref<InstructionTabOption[]>([])
  const activeTab = ref<InstructionTabId>('builtin')
  let builtinCommands: MessageCommand[] = []
  let skillCommands: MessageCommand[] = []
  let comboCommands: MessageCommand[] = []
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
      builtinCommands = []
      skillCommands = []
      comboCommands = []
      roles = []
      suggestions.value = []
      tabs.value = []
      opened.value = false
      sequence++
      if (!chatId) return
      const results = await Promise.allSettled([
        agentApi.listCommands(),
        agentApi.listSkills({ page: 1, pageSize: 200, plugin: '*' }),
        agentApi.getConfig(),
      ])
      if (cancelled) return
      builtinCommands =
        results[0].status === 'fulfilled'
          ? results[0].value.map((c) => ({
              id: `builtin:${c.name}`,
              name: `/${c.name}`,
              label: c.name,
              description: c.description || '执行此内置指令。',
              kind: 'builtin' as const,
            }))
          : []
      if (results[1].status === 'fulfilled') {
        const skills = toSkillCommands(results[1].value.skills)
        skillCommands = skills.filter((s) => !s.plugin)
        comboCommands = skills.filter((s) => !!s.plugin)
      }
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
  /** 按当前 tab 过滤指令候选：分组逻辑与树页面 useAgentDialogOptions 完全一致。 */
  function applyCommandFilter(needle: string): void {
    const byTab: Record<InstructionTabId, MessageCommand[]> = {
      builtin: [],
      skill: [],
      combo: [],
    }
    for (const command of [...builtinCommands, ...skillCommands, ...comboCommands]) {
      const searchable = command.plugin
        ? `${command.plugin}:${command.label}`.toLowerCase()
        : command.label.toLowerCase()
      if (
        searchable.includes(needle) ||
        command.name.slice(1).toLowerCase().includes(needle)
      )
        byTab[command.kind === 'builtin' ? 'builtin' : command.plugin ? 'combo' : 'skill'].push(
          command,
        )
    }
    tabs.value = [
      { id: 'builtin', label: '指令', count: byTab.builtin.length },
      { id: 'skill', label: '技能', count: byTab.skill.length },
      { id: 'combo', label: '组合技', count: byTab.combo.length },
    ]
    // 当前 tab 无候选时切到首个有候选的 tab（无候选则留在原地显示空态）。
    if (byTab[activeTab.value].length === 0) {
      const first = tabs.value.find((tab) => tab.count > 0)
      if (first) activeTab.value = first.id
    }
    suggestions.value = byTab[activeTab.value].map((command) => ({
      // 组合技带插件前缀以区分同名技能（与树页面 combo 分组标题同源）。
      label:
        command.plugin && command.kind === 'skill'
          ? `${command.plugin}:${command.label}`
          : command.label,
      description: command.description,
      token: serializeCommandToken(command),
    }))
    if (!suggestions.value.length) message.value = '没有匹配的可用选项'
  }
  async function refresh(): Promise<void> {
    const version = ++sequence
    query = instructionQuery(
      options.text(),
      options.input.value?.selectionStart ?? options.text().length,
    )
    activeIndex.value = 0
    suggestions.value = []
    tabs.value = []
    message.value = ''
    opened.value = !!query
    if (!query) return
    const needle = query.query.toLowerCase()
    if (query.trigger === '/') {
      applyCommandFilter(needle)
      return
    }
    if (query.trigger !== '&') {
      suggestions.value = roles.filter((item) => item.label.toLowerCase().includes(needle))
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
    tabs.value = []
    sequence++
    void nextTick(() => {
      options.input.value?.focus()
      options.input.value?.setSelectionRange(caret, caret)
      options.resize()
    })
  }
  /** 切换到指定 tab（点击 tab 栏）。无候选的 tab 不可切换。 */
  function selectTab(tab: InstructionTabId): void {
    if (tab === activeTab.value) return
    if (!tabs.value.some((item) => item.id === tab && item.count > 0)) return
    activeTab.value = tab
    activeIndex.value = 0
    if (query && query.trigger === '/') applyCommandFilter(query.query.toLowerCase())
  }
  /** 左右方向键在可用 tab 间循环切换（与树页面 command-tab 键盘行为一致）。 */
  function moveTab(direction: 1 | -1): void {
    const available = tabs.value.filter((item) => item.count > 0)
    if (available.length < 2) return
    const current = available.findIndex((item) => item.id === activeTab.value)
    const next = available[(current + direction + available.length) % available.length]
    if (next) selectTab(next.id)
  }
  function keydown(event: KeyboardEvent): boolean {
    if (event.isComposing || !opened.value) return false
    if (event.key === 'Escape') {
      opened.value = false
      tabs.value = []
      sequence++
      event.preventDefault()
      event.stopPropagation()
      return true
    }
    // 斜杠指令菜单：左右键切 tab（指令/技能/组合技）。
    if (query?.trigger === '/' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      moveTab(event.key === 'ArrowRight' ? 1 : -1)
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
  return {
    suggestions,
    activeIndex,
    message,
    opened,
    tabs,
    activeTab,
    refresh,
    choose,
    selectTab,
    keydown,
  }
}
