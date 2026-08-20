import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { UploadFile } from 'element-plus'
import { useAgentsStore, useChatSessionsStore } from '@/stores'
import { wsClient } from '@/services/ws'
import {
  agentApi,
  fetchServerConfig,
  type BrainInfo,
  type ConfigDto,
  type RuntimeSelection,
  type SenseToolInfo,
  type SenseGroupOption,
} from '@/services/agentApi'
import type { PetInstance } from '@/features/pets/types/types'
import { CHERY_NYXUS_PRESET } from '@/stores/agents/data/petLifecycle'
import {
  COMPACT_COMMAND,
  composeCommandPrompt,
  estimateCommandTokens,
  toSkillCommands,
  type MessageCommand,
  type RoleMention,
} from '@/features/agent/composables/commands'

/**
 * AgentDialog 状态 + 逻辑 composable。
 * 15 个 ref + loadOptions + handleSend + media 函数 + watch(chatId)。
 */

// /api/config 未暴露 senseGroups 或拉取失败时的兜底
const SENSE_GROUPS_FALLBACK = [{ name: 'default', default: true }] as const

export type MediaKind = 'image' | 'video' | 'audio'

export interface MediaAttachment {
  assetId: string
  filename: string
  kind: MediaKind
  mimeType: string
  size: number
  previewUrl: string
}

export type CommandTab = 'builtin' | 'skill' | 'combo'

export interface CommandTabOption {
  id: CommandTab
  label: string
  count: number
}

export interface ComboCommandGroup {
  plugin: string
  commands: MessageCommand[]
}

export interface UseAgentDialogOptionsOptions {
  /** 本实例的 chatId 来源。传入时优先使用（Ref 直接复用，函数包成 computed）；未传入回退全局单例 activeDialogChatId。 */
  chatId?: Ref<string | null> | (() => string | null)
}

export function useAgentDialogOptions(options?: UseAgentDialogOptionsOptions) {
  const agents = useAgentsStore()
  const chatSessions = useChatSessionsStore()

  const chatId: Ref<string | null> =
    typeof options?.chatId === 'function'
      ? computed(options.chatId)
      : options?.chatId ?? computed<string | null>(() => agents.activeDialogChatId)
  const pet = computed<PetInstance | undefined>(() =>
    chatId.value ? agents.petForChat(chatId.value) : undefined,
  )
  // Cherry Nyxus 会话不建 PetInstance；琴键切到尚未水合的会话时，historyList 先提供 preset，
  // 避免上方树在 hydrate 期间被误判为非 Nyxus 而卸载。
  const presetName = computed<string | undefined>(() => {
    const fromPet = pet.value?.preset
    if (fromPet) return fromPet
    const s = chatId.value ? chatSessions.sessionsById[chatId.value] : undefined
    if (s?.meta.preset) return s.meta.preset
    return chatId.value ? agents.historyList.find((item) => item.chatId === chatId.value)?.preset : undefined
  })

  const brains = ref<BrainInfo[]>([])
  const senseGroups = ref<readonly SenseGroupOption[]>(SENSE_GROUPS_FALLBACK)
  const config = ref<ConfigDto | null>(null)
  const senseTools = ref<SenseToolInfo[]>([])
  const roleSelections = ref<Record<string, RuntimeSelection>>({})
  const primaryRole = ref('主角色')
  const text = ref('')
  /** 光标前内容序列化串；指令/角色菜单据此触发（支持句中输入 / 或 @）。 */
  const caretPrefix = ref('')
  const builtinCommands = ref<MessageCommand[]>([COMPACT_COMMAND])
  const skillCommands = ref<MessageCommand[]>([])
  const editorRef = ref<HTMLElement | null>(null)
  const uploading = ref(false)
  const mediaHint = ref('')
  const uploadQueue = ref<import('element-plus').UploadUserFile[]>([])
  const mediaAttachments = ref<MediaAttachment[]>([])
  const sending = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)
  /** 全局选项已加载时对应的预设；同预设内切历史会话据此跳过重载。 */
  const loadedPreset = ref<string | null>(null)

  /** 由已加载的 config + 当前 chat 的 runtime 重建角色编制。切同预设会话仅调用此重建，不重拉全局选项。 */
  function rebuildRoleSelections(): void {
    const loadedConfig = config.value
    if (!loadedConfig) return
    const preset = presetName.value ? loadedConfig.presets?.[presetName.value] : undefined
    const roleNames = preset?.roles?.length
      ? preset.roles
      : Object.entries(loadedConfig.roles ?? {})
          .filter(([, role]) => role.kind !== 'shadow')
          .map(([name]) => name)
    primaryRole.value = preset?.leader ?? '主角色'
    const fallback: RuntimeSelection = {
      brain: brains.value.find((b) => b.default)?.name ?? brains.value[0]?.name ?? '',
      senseGroup: senseGroups.value.find((g) => g.default)?.name ?? senseGroups.value[0]?.name ?? '',
      mcpServers: [],
    }
    const selections: Record<string, RuntimeSelection> = {}
    for (const role of roleNames) {
      const configured = loadedConfig.roles?.[role]
      selections[role] = configured
        ? {
            brain: configured.brain,
            senseGroup: configured.senseGroup,
            mcpServers: configured.mcpServers ?? [],
          }
        : { ...fallback }
    }
    const cur = chatId.value ? agents.getRuntime(chatId.value) : undefined
    selections[primaryRole.value] = cur
      ? { ...cur, mcpServers: [...(cur.mcpServers ?? [])] }
      : (selections[primaryRole.value] ?? fallback)
    roleSelections.value = selections
    for (const [k, v] of Object.entries(selections)) {
      if (!v.brain) console.warn(`[AgentDialog] 角色 ${k} brain 为空:`, v)
    }
  }

  async function loadOptions(): Promise<void> {
    if (loaded.value || !chatId.value) return
    loading.value = true
    error.value = null
    try {
      const data = await agentApi.listBrains()
      brains.value = data.brains
      let serverCfg: Awaited<ReturnType<typeof fetchServerConfig>> | null = null
      try {
        serverCfg = await fetchServerConfig()
      } catch (e) {
        console.warn('[AgentDialog] /api/config 拉取失败，senseGroups 回退默认:', e)
      }
      if (serverCfg?.senseGroups && serverCfg.senseGroups.length > 0) {
        senseGroups.value = serverCfg.senseGroups
      } else {
        senseGroups.value = SENSE_GROUPS_FALLBACK
        console.warn('[AgentDialog] /api/config 未暴露 senseGroups，回退默认', serverCfg)
      }
      const loadedConfig = await agentApi.getConfig()
      config.value = loadedConfig
      try {
        senseTools.value = await agentApi.listSenseTools()
      } catch (e) {
        senseTools.value = []
        console.warn('[AgentDialog] sense.tools 拉取失败，能力详情仅显示原始名称:', e)
      }
      try {
        const skillPage = await agentApi.listSkills({ page: 1, pageSize: 200, plugin: '*' })
        skillCommands.value = toSkillCommands(skillPage.skills)
      } catch (e) {
        skillCommands.value = []
        console.warn('[AgentDialog] skills.list 拉取失败，命令菜单仅保留内置命令:', e)
      }
      try {
        const commands = await agentApi.listCommands()
        builtinCommands.value = commands.map((command) => ({
          id: `builtin:${command.name}`,
          name: `/${command.name}`,
          label: command.name,
          description: command.description || '执行此内置指令。',
          kind: 'builtin',
        }))
      } catch (e) {
        builtinCommands.value = [COMPACT_COMMAND]
        console.warn('[AgentDialog] command.list 拉取失败，命令菜单回退 compact:', e)
      }
      rebuildRoleSelections()
      loaded.value = true
      loadedPreset.value = presetName.value ?? null
    } catch (e) {
      error.value = (e as Error).message
      console.error('[AgentDialog] loadOptions failed:', e)
    } finally {
      loading.value = false
    }
  }

  // 单次触发：connected 后 resume（首拉通常在 setup 时被「还没连上服务器」reject，不再自动重试）。
  // 订阅在 connect 时主动 resume 并解绑；未连上时保持待命，一方建连即执行，避免重复订阅。
  let connectRetryUnsub: (() => void) | null = null
  let connectResumed = false
  function armRetryOnConnect(): void {
    if (connectResumed) return
    if (wsClient.getStatus() === 'connected') {
      connectResumed = true
      void refreshForChat()
      return
    }
    connectRetryUnsub?.()
    connectRetryUnsub = wsClient.onStatus((status) => {
      if (status === 'connected') {
        connectRetryUnsub?.()
        connectRetryUnsub = null
        connectResumed = true
        void refreshForChat()
      }
    })
  }
  onBeforeUnmount(() => {
    connectRetryUnsub?.()
    connectRetryUnsub = null
  })

  // immediate watcher 只能在重连守卫完成初始化后注册。真实 chatId 会在注册时同步执行回调；
  // 若它位于上方，armRetryOnConnect 会读取仍处于 TDZ 的 connectResumed，导致整个原生窗首屏渲染中断。
  watch(
    chatId,
    (v) => {
      // chatId 有值但全局选项未加载 → 可能 WS 尚未建连（composer 原生窗 onMounted 才 conn.init，
      // 远晚于 setup 的 immediate watch），RPC 首拉全失败。订阅连接状态，connected 后再补拉。
      if (v && !loaded.value) {
        armRetryOnConnect()
      }
      if (v) {
        resetEditor()
        resetMedia()
        error.value = null
        void refreshForChat()
      }
    },
    { immediate: true },
  )

  /** 切会话：同预设已加载时仅重建角色编制（读 chat runtime），不重拉全局选项、不置 loading。 */
  async function refreshForChat(): Promise<void> {
    if (!chatId.value) return
    if (loaded.value && loadedPreset.value === presetName.value) {
      rebuildRoleSelections()
      return
    }
    loaded.value = false
    await loadOptions()
  }

  const primarySelection = computed(() => roleSelections.value[primaryRole.value])

  const allCommands = computed<MessageCommand[]>(() => [
    ...builtinCommands.value,
    ...skillCommands.value,
  ])
  /** 光标前最近一个 / 起的 token；null 表示当前不应展示指令菜单。 */
  const slashQuery = computed<string | null>(() => {
    const match = caretPrefix.value.match(/\/([^\s/@]*)$/)
    return match ? match[1]!.toLowerCase() : null
  })
  const matchingCommands = computed(() => {
    if (slashQuery.value === null) return []
    const selected = new Set(
      [...text.value.matchAll(/\[\[command:(\/[^\]\s]+)\]\]/g)].map((match) => match[1]!),
    )
    // 搜索 key = 命令完整名（含 plugin 前缀拼接），子串匹配，命中：
    //   - /<skillName>：独立技能
    //   - /<plugin:skill>：插件技能（中间字符也算，含 plugin 名 / skill 名 / 中间片段）
    const q = slashQuery.value
    return allCommands.value.filter((command) => {
      if (selected.has(command.name)) return false
      // 搜索 key = 命令完整名（含 plugin 前缀拼接）
      const searchable = command.plugin
        ? `${command.plugin}:${command.label}`.toLowerCase()
        : command.label.toLowerCase()
      return searchable.includes(q) || command.name.slice(1).toLowerCase().includes(q)
    })
  })
  const activeCommandTab = ref<CommandTab>('builtin')
  const commandOptionsByTab = computed<Record<CommandTab, MessageCommand[]>>(() => {
    const result: Record<CommandTab, MessageCommand[]> = { builtin: [], skill: [], combo: [] }
    for (const command of matchingCommands.value) {
      result[command.kind === 'builtin' ? 'builtin' : command.plugin ? 'combo' : 'skill'].push(
        command,
      )
    }
    return result
  })
  const commandTabs = computed<CommandTabOption[]>(() => [
    { id: 'builtin', label: '指令', count: commandOptionsByTab.value.builtin.length },
    { id: 'skill', label: '技能', count: commandOptionsByTab.value.skill.length },
    { id: 'combo', label: '组合技', count: commandOptionsByTab.value.combo.length },
  ])
  const commandOptions = computed(() => commandOptionsByTab.value[activeCommandTab.value])
  const comboCommandGroups = computed<ComboCommandGroup[]>(() => {
    const groups = new Map<string, MessageCommand[]>()
    for (const command of commandOptionsByTab.value.combo) {
      const plugin = command.plugin ?? '未分组'
      const group = groups.get(plugin)
      if (group) group.push(command)
      else groups.set(plugin, [command])
    }
    return [...groups].map(([plugin, commands]) => ({ plugin, commands }))
  })
  const showCommandMenu = computed(
    () => slashQuery.value !== null && commandTabs.value.some((tab) => tab.count > 0),
  )

  /** 当前高亮的命令项下标；菜单呼出/过滤变化时默认指向第一项。 */
  const activeCommandIndex = ref(0)
  const commandMenuRef = ref<HTMLElement | null>(null)
  const roleMenuRef = ref<HTMLElement | null>(null)
  let instructionPopover: HTMLElement | null = null

  /** 仅展示当前预设编制中、显式标记 mentionable 的非主角色。 */
  const roleMentions = computed<RoleMention[]>(() => {
    const loadedConfig = config.value
    const preset = presetName.value ? loadedConfig?.presets?.[presetName.value] : undefined
    if (!loadedConfig?.roles || !preset?.roles) return []
    return preset.roles.flatMap((name) => {
      const role = loadedConfig.roles?.[name]
      if (
        !role ||
        role.kind === 'shadow' ||
        name === primaryRole.value ||
        name === preset.detailRole ||
        !role.mentionable
      )
        return []
      return [{ name, description: role.description || `委派 ${name} 角色处理任务。` }]
    })
  })
  const roleQuery = computed<string | null>(() => {
    const match = caretPrefix.value.match(/@([^\s/@]*)$/)
    return match ? match[1]!.toLowerCase() : null
  })
  const matchingRoleMentions = computed(() => {
    if (roleQuery.value === null) return []
    const selected = new Set(
      [...text.value.matchAll(/\[\[role:@([^\]\s]+)\]\]/g)].map((match) => match[1]!),
    )
    return roleMentions.value.filter(
      (role) =>
        !selected.has(role.name) &&
        `${role.name} ${role.description}`.toLowerCase().includes(roleQuery.value!),
    )
  })
  const showRoleMenu = computed(
    () => roleQuery.value !== null && matchingRoleMentions.value.length > 0,
  )
  const activeRoleIndex = ref(0)
  watch(matchingRoleMentions, () => {
    activeRoleIndex.value = 0
  })
  watch(
    activeRoleIndex,
    () => {
      roleMenuRef.value
        ?.querySelector<HTMLElement>('.command-option.is-active')
        ?.scrollIntoView({ block: 'nearest' })
    },
    { flush: 'post' },
  )

  /** 切换 Tab 或更新过滤条件时，确保停留在一个有候选项的 Tab。 */
  function selectCommandTab(tab: CommandTab): void {
    if (commandOptionsByTab.value[tab].length === 0) return
    activeCommandTab.value = tab
    activeCommandIndex.value = 0
  }

  function moveCommandTab(direction: 1 | -1): void {
    const tabs = commandTabs.value.filter((tab) => tab.count > 0)
    if (tabs.length === 0) return
    const current = tabs.findIndex((tab) => tab.id === activeCommandTab.value)
    const next = tabs[(current + direction + tabs.length) % tabs.length]
    if (next) selectCommandTab(next.id)
  }

  // 过滤结果变化（含菜单首次呼出）→ 切到首个可用 Tab 并高亮第一项。
  watch(matchingCommands, () => {
    if (commandOptionsByTab.value[activeCommandTab.value].length === 0) {
      const first = commandTabs.value.find((tab) => tab.count > 0)
      if (first) activeCommandTab.value = first.id
    }
    activeCommandIndex.value = 0
  })
  // 键盘切换后将高亮项滚动进视口；flush:post 等 DOM 更新后再查节点。
  watch(
    activeCommandIndex,
    () => {
      commandMenuRef.value
        ?.querySelector<HTMLElement>('.command-option.is-active')
        ?.scrollIntoView({ block: 'nearest' })
    },
    { flush: 'post' },
  )

  function selectCommand(command: MessageCommand): void {
    const editor = editorRef.value
    if (!editor) return
    removeTrailingSlashQuery()
    insertInstructionToken(editor, command)
    syncEditorText()
  }

  function selectRoleMention(role: RoleMention): void {
    const editor = editorRef.value
    if (!editor) return
    removeTrailingRoleQuery()
    insertRoleMentionToken(editor, role)
    syncEditorText()
  }

  function close(): void {
    resetMedia()
    agents.activeDialogChatId = null
  }

  // brain 选择即时生效：监听 roleSelections（主+子角色）变化，debounce 后立即调 setSessionRuntime，
  // 不等 handleSend 提交。这样点击 plan 角色名片的 brain radio → 后端立即回灌已派发的同 type 子
  // （含 running 子，下一轮 loop 自动取新 brain）。initialized 前不触发（避免误推空编制）。
  let propagateTimer: ReturnType<typeof setTimeout> | undefined
  watch(
    () => ({
      primary: primarySelection.value,
      roles: roleSelections.value,
      ready: loaded.value && !!chatId.value,
    }),
    ({ primary, roles, ready }) => {
      if (!ready || !primary?.brain) return
      const safeRoles: Record<string, RuntimeSelection> = {}
      for (const [k, v] of Object.entries(roles)) {
        if (v.brain) safeRoles[k] = v
      }
      if (propagateTimer) clearTimeout(propagateTimer)
      propagateTimer = setTimeout(() => {
        if (!chatId.value) return
        agents
          .setSessionRuntime(chatId.value, { primary, roles: safeRoles })
          .then(({ applied, deferredRunning }) => {
            if (deferredRunning.length > 0)
              console.info(
                `[AgentDialog] brain 切换即时生效：${applied.length} 子已更新，${deferredRunning.length} 运行中子将在下一轮 loop 自动取新 brain`,
              )
            else if (applied.length > 0)
              console.info(`[AgentDialog] brain 切换即时生效：${applied.length} 个已派发的子已更新`)
          })
          .catch((e) => console.warn('[AgentDialog] 即时 brain 同步失败：', e))
      }, 150)
    },
    { deep: true, flush: 'post' },
  )

  // 全局 ESC 关闭弹窗（仅在 dialog 打开且为栈顶 overlay 时生效；topOverlay 守卫避免与 HistoryDrawer 等同开时双重关闭）。
  function onGlobalKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && chatId.value && agents.topOverlay === 'agentDialog') {
      e.preventDefault()
      close()
    }
  }
  window.addEventListener('keydown', onGlobalKeydown)
  window.addEventListener('scroll', hideInstructionPopover, true)
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onGlobalKeydown)
    window.removeEventListener('scroll', hideInstructionPopover, true)
    hideInstructionPopover()
  })

  async function handleSend(
    targetOverride?: string,
    options: { keepOpen?: boolean } = {},
  ): Promise<boolean> {
    const targetChatId = targetOverride ?? chatId.value
    if (!targetChatId || !text.value.trim() || sending.value) return false
    sending.value = true
    error.value = null
    let preparedInput: ReturnType<typeof chatSessions.prepareInput> | undefined
    try {
      if (!primarySelection.value) throw new Error('主角色编制未加载完成')
      const safeRoles: Record<string, RuntimeSelection> = {}
      for (const [k, v] of Object.entries(roleSelections.value)) {
        if (!v.brain) {
          console.warn(`[AgentDialog] 发送时跳过空 brain 角色: ${k}`, v)
          continue
        }
        safeRoles[k] = v
      }
      if (!primarySelection.value.brain) {
        throw new Error(
          `主角色 brain 为空（${primaryRole.value}），roleSelections=${JSON.stringify(roleSelections.value)}`,
        )
      }
      const prompt = composeCommandPrompt(text.value)
      if (presetName.value === CHERY_NYXUS_PRESET) {
        preparedInput = chatSessions.prepareInput(targetChatId, prompt)
      }
      // session.runtime.set 返回 applied/deferredRunning：回灌已存在子 chat 的反馈。
      // - applied：所有子（含 running）已即时切换 ctx.runtime + 持久化 metadata.runtime。
      // - deferredRunning：applied 中本次正在运行的子，下一轮 LLM loop 自动取新 brain；流未打断。
      const { applied, deferredRunning } = await agents.setSessionRuntime(targetChatId, {
        primary: primarySelection.value,
        roles: safeRoles,
      })
      const propagationHint =
        deferredRunning.length > 0
          ? `（${deferredRunning.length} 个运行中子将在下一轮 loop 自动切到新 brain）`
          : applied.length > 0
            ? `（已应用到 ${applied.length} 个已派发的子）`
            : ''
      if (propagationHint) console.info('[AgentDialog] session.runtime.set 回灌:', propagationHint)
      const attachments = mediaAttachments.value.map((m) => ({
        assetId: m.assetId,
        kind: m.kind,
        mimeType: m.mimeType,
      }))
      // V2 command plane: ACK the input independently from the agent run. Opening
      // the session first guarantees the subsequent input.updated/turn events are
      // observed by the authoritative ChatSession reducer. Nyxus additionally
      // depends on the root tree subscription for its node/CRT projection, so its
      // first command must not race that subscription's initial tree snapshot.
      if (presetName.value === CHERY_NYXUS_PRESET) {
        await chatSessions.acquireRootTimeline(targetChatId, 'agent-dialog-submit', 'tree')
      } else {
        await chatSessions.openSession(targetChatId)
      }
      await chatSessions.submitInput(targetChatId, prompt, attachments, preparedInput)
      if (presetName.value === CHERY_NYXUS_PRESET) {
        await chatSessions.releaseRootTimeline(targetChatId, 'agent-dialog-submit')
      }
      preparedInput = undefined
      resetEditor()
      // Nyxus 是持续会话工作台：提交后保留输入窗口，等待下一轮指令；其他预设维持原关闭行为。
      if (presetName.value !== CHERY_NYXUS_PRESET && !options.keepOpen) close()
      return true
    } catch (e) {
      if (targetChatId && presetName.value === CHERY_NYXUS_PRESET) {
        void chatSessions.releaseRootTimeline(targetChatId, 'agent-dialog-submit')
      }
      if (preparedInput) chatSessions.rollbackPreparedInput(preparedInput, e)
      error.value = (e as Error).message
      console.error('[AgentDialog] submit input failed:', e)
      return false
    } finally {
      sending.value = false
    }
  }

  function onEditorKeydown(e: KeyboardEvent, send?: () => void): void {
    if (showCommandMenu.value) {
      const opts = commandOptions.value
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        moveCommandTab(1)
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        moveCommandTab(-1)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (opts.length) activeCommandIndex.value = (activeCommandIndex.value + 1) % opts.length
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (opts.length)
          activeCommandIndex.value = (activeCommandIndex.value - 1 + opts.length) % opts.length
        return
      }
      // 纯 Enter 选中高亮项；isComposing 放行中文输入法的候选词确认，shift/alt 仍走换行。
      if (
        e.key === 'Enter' &&
        !e.isComposing &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const cmd = opts[activeCommandIndex.value]
        if (cmd) selectCommand(cmd)
        return
      }
    }
    if (showRoleMenu.value) {
      const roles = matchingRoleMentions.value
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        activeRoleIndex.value = (activeRoleIndex.value + 1) % roles.length
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        activeRoleIndex.value = (activeRoleIndex.value - 1 + roles.length) % roles.length
        return
      }
      if (
        e.key === 'Enter' &&
        !e.isComposing &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const role = roles[activeRoleIndex.value]
        if (role) selectRoleMention(role)
        return
      }
    }
    if (e.key === 'Enter' && !e.isComposing && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (send) send()
      else void handleSend()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  function onEditorInput(): void {
    syncEditorText()
  }

  /** 光标移动（点击/方向键）后刷新触发检测：句中把光标挪到 /foo 或 @bar 尾部亦应弹菜单。 */
  function onEditorSelectionChange(): void {
    updateCaretPrefix()
  }

  function onEditorPaste(e: ClipboardEvent): void {
    e.preventDefault()
    const pasted = e.clipboardData?.getData('text/plain')
    if (pasted) {
      document.execCommand('insertText', false, pasted)
      syncEditorText()
    }
  }

  function resetEditor(): void {
    text.value = ''
    if (editorRef.value) editorRef.value.replaceChildren()
  }

  function syncEditorText(): void {
    text.value = editorRef.value ? serializeEditor(editorRef.value) : ''
    updateCaretPrefix()
  }

  /** token / 块级换行语义与 serializeEditor 一致的单节点序列化（供整体与光标前片段复用）。 */
  function serializeNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const element = node as HTMLElement
    if (element.dataset.commandName) return `[[command:${element.dataset.commandName}]]`
    if (element.dataset.roleName) return `[[role:@${element.dataset.roleName}]]`
    if (element.tagName === 'BR') return '\n'
    const content = [...element.childNodes].map(serializeNode).join('')
    return element.tagName === 'DIV' || element.tagName === 'P' ? `${content}\n` : content
  }

  function serializeEditor(editor: HTMLElement): string {
    return [...editor.childNodes]
      .map(serializeNode)
      .join('')
      .replace(/\n{3,}/g, '\n\n')
  }

  /**
   * 光标前内容的序列化串（token/换行语义同 serializeEditor）。指令/角色菜单据此判断是否触发，
   * 从而支持句中（光标非行尾）输入 `/` 或 `@`。无有效光标时回退整串 text.value。
   */
  function updateCaretPrefix(): void {
    const editor = editorRef.value
    const selection = window.getSelection()
    if (!editor || !selection || selection.rangeCount === 0) {
      caretPrefix.value = text.value
      return
    }
    const caret = selection.getRangeAt(0)
    if (!editor.contains(caret.startContainer)) {
      caretPrefix.value = text.value
      return
    }
    const prefixRange = document.createRange()
    prefixRange.selectNodeContents(editor)
    prefixRange.setEnd(caret.startContainer, caret.startOffset)
    const fragment = prefixRange.cloneContents()
    caretPrefix.value = [...fragment.childNodes]
      .map(serializeNode)
      .join('')
      .replace(/\n{3,}/g, '\n\n')
  }

  function removeTrailingSlashQuery(): void {
    removeQueryBeforeCaret(/\/[^\s/@]*$/)
  }

  function removeTrailingRoleQuery(): void {
    removeQueryBeforeCaret(/@[^\s/@]*$/)
  }

  /**
   * 删除光标前紧邻的 query（/foo 或 @bar），并把光标停在删除起点，供 token 原地插入。
   * 基于光标所在文本节点，支持句中（非行尾）选中。
   */
  function removeQueryBeforeCaret(pattern: RegExp): void {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
    const caret = selection.getRangeAt(0)
    const node = caret.startContainer
    if (node.nodeType !== Node.TEXT_NODE) return
    const offset = caret.startOffset
    const before = (node as Text).data.slice(0, offset)
    const queryStart = before.search(pattern)
    if (queryStart < 0) return
    const seg = before.slice(queryStart)
    const start = queryStart + Math.max(seg.lastIndexOf('/'), seg.lastIndexOf('@'))
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, offset)
    range.deleteContents()
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  function insertInstructionToken(editor: HTMLElement, command: MessageCommand): void {
    const token = document.createElement('span')
    token.className = 'instruction-token'
    token.dataset.commandName = command.name
    token.contentEditable = 'false'
    token.setAttribute('role', 'note')
    token.setAttribute('aria-label', `指令 ${command.name}：${command.description}`)

    const name = document.createElement('span')
    name.className = 'instruction-token-name'
    name.textContent = command.label
    token.append(name)
    token.addEventListener('pointerenter', () => showInstructionPopover(token, command))
    token.addEventListener('pointerleave', hideInstructionPopover)

    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : document.createRange()
    if (!editor.contains(range.commonAncestorContainer)) {
      range.selectNodeContents(editor)
      range.collapse(false)
    }
    range.collapse(true)
    range.insertNode(token)
    const spacer = document.createTextNode(' ')
    range.setStartAfter(token)
    range.insertNode(spacer)
    range.setStartAfter(spacer)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    editor.focus()
  }

  function insertRoleMentionToken(editor: HTMLElement, role: RoleMention): void {
    const token = document.createElement('span')
    token.className = 'instruction-token role-mention-token'
    token.dataset.roleName = role.name
    token.contentEditable = 'false'
    token.setAttribute('role', 'note')
    token.setAttribute('aria-label', `角色 @${role.name}：${role.description}`)
    token.textContent = `@${role.name}`
    token.addEventListener('pointerenter', () => showRoleMentionPopover(token, role))
    token.addEventListener('pointerleave', hideInstructionPopover)

    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : document.createRange()
    if (!editor.contains(range.commonAncestorContainer)) {
      range.selectNodeContents(editor)
      range.collapse(false)
    }
    range.collapse(true)
    range.insertNode(token)
    const spacer = document.createTextNode(' ')
    range.setStartAfter(token)
    range.insertNode(spacer)
    range.setStartAfter(spacer)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    editor.focus()
  }

  function showInstructionPopover(anchor: HTMLElement, command: MessageCommand): void {
    hideInstructionPopover()
    const popover = document.createElement('div')
    popover.className = 'instruction-token-floating-popover'
    popover.setAttribute('role', 'tooltip')

    const title = document.createElement('div')
    title.className = 'instruction-token-floating-title'
    title.textContent = command.label
    const description = document.createElement('div')
    description.className = 'instruction-token-floating-description'
    description.textContent = command.description
    const meta = document.createElement('div')
    meta.className = 'instruction-token-floating-meta'
    const metaLabel = document.createElement('span')
    metaLabel.textContent = 'Token 消耗量'
    const metaValue = document.createElement('strong')
    metaValue.textContent = `≈ ${estimateCommandTokens(command)} tokens`
    meta.append(metaLabel, metaValue)
    popover.append(title, description, meta)
    popover.style.visibility = 'hidden'
    document.body.append(popover)

    const anchorRect = anchor.getBoundingClientRect()
    const popoverRect = popover.getBoundingClientRect()
    const horizontalPadding = 8
    const top =
      anchorRect.top - popoverRect.height - 8 >= horizontalPadding
        ? anchorRect.top - popoverRect.height - 8
        : Math.min(
            window.innerHeight - popoverRect.height - horizontalPadding,
            anchorRect.bottom + 8,
          )
    const left = Math.min(
      Math.max(horizontalPadding, anchorRect.left),
      window.innerWidth - popoverRect.width - horizontalPadding,
    )
    popover.style.top = `${top}px`
    popover.style.left = `${left}px`
    popover.style.visibility = 'visible'
    instructionPopover = popover
  }

  function showRoleMentionPopover(anchor: HTMLElement, role: RoleMention): void {
    hideInstructionPopover()
    const popover = document.createElement('div')
    popover.className = 'instruction-token-floating-popover'
    popover.setAttribute('role', 'tooltip')
    const title = document.createElement('div')
    title.className = 'instruction-token-floating-title'
    title.textContent = `@${role.name}`
    const description = document.createElement('div')
    description.className = 'instruction-token-floating-description'
    description.textContent = role.description
    popover.append(title, description)
    popover.style.visibility = 'hidden'
    document.body.append(popover)
    positionInstructionPopover(popover, anchor)
  }

  function positionInstructionPopover(popover: HTMLElement, anchor: HTMLElement): void {
    const anchorRect = anchor.getBoundingClientRect()
    const popoverRect = popover.getBoundingClientRect()
    const horizontalPadding = 8
    const top =
      anchorRect.top - popoverRect.height - 8 >= horizontalPadding
        ? anchorRect.top - popoverRect.height - 8
        : Math.min(
            window.innerHeight - popoverRect.height - horizontalPadding,
            anchorRect.bottom + 8,
          )
    const left = Math.min(
      Math.max(horizontalPadding, anchorRect.left),
      window.innerWidth - popoverRect.width - horizontalPadding,
    )
    popover.style.top = `${top}px`
    popover.style.left = `${left}px`
    popover.style.visibility = 'visible'
    instructionPopover = popover
  }

  function hideInstructionPopover(): void {
    instructionPopover?.remove()
    instructionPopover = null
  }

  // === media functions ===
  function mediaKind(file: File): MediaKind | undefined {
    if (file.type.startsWith('image/')) return 'image'
    if (file.type.startsWith('video/')) return 'video'
    if (file.type.startsWith('audio/')) return 'audio'
    return undefined
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  function resetMedia(): void {
    for (const attachment of mediaAttachments.value) URL.revokeObjectURL(attachment.previewUrl)
    mediaAttachments.value = []
    uploadQueue.value = []
    mediaHint.value = ''
  }

  function removeMedia(attachment: MediaAttachment): void {
    URL.revokeObjectURL(attachment.previewUrl)
    mediaAttachments.value = mediaAttachments.value.filter((item) => item !== attachment)
    mediaHint.value = mediaAttachments.value.length
      ? `已附加 ${mediaAttachments.value.length} 个媒体文件`
      : ''
  }

  async function onMediaSelected(uploadFile: UploadFile): Promise<void> {
    const file = uploadFile.raw
    uploadQueue.value = []
    if (!file || !primarySelection.value) return
    const category = mediaKind(file)
    if (!category) return
    // 检查媒体服务 OR brain 原生能力，任一满足即可上传
    const hasMediaService = config.value?.media
      ? Object.values(config.value.media).some(
          (svc) => svc.type === category && svc.enabled && svc.url,
        )
      : false
    const hasBrainCapability =
      brainConfig(primarySelection.value.brain)?.capabilities?.input?.[category] === true
    if (!hasMediaService && !hasBrainCapability) {
      const typeLabel = category === 'image' ? '图片' : category === 'video' ? '视频' : '音频'
      mediaHint.value = `未配置${typeLabel}服务，且小组无支持模型`
      return
    }
    uploading.value = true
    mediaHint.value = '上传媒体中…'
    try {
      const asset = await agentApi.uploadMedia(file)
      mediaAttachments.value.push({
        assetId: asset.id,
        filename: asset.filename,
        kind: asset.kind,
        mimeType: asset.mimeType,
        size: asset.size,
        previewUrl: URL.createObjectURL(file),
      })
      mediaHint.value = `${file.name} 已附加`
    } catch (err) {
      mediaHint.value = (err as Error).message
    } finally {
      uploading.value = false
    }
  }

  // === role config helpers ===
  function brainInfo(name: string): BrainInfo | undefined {
    return brains.value.find((brain) => brain.name === name)
  }

  function brainConfig(name: string) {
    return config.value?.llm.brain[name]
  }

  function supportsTools(brainName: string): boolean {
    return brainConfig(brainName)?.capabilities?.toolCall !== false
  }

  function selectBrain(selection: RuntimeSelection, brain: string): void {
    selection.brain = brain
    if (!supportsTools(brain)) {
      selection.senseGroup = ''
      selection.mcpServers = []
    } else if (!selection.senseGroup) {
      selection.senseGroup =
        senseGroups.value.find((g) => g.default)?.name ?? senseGroups.value[0]?.name ?? ''
    }
  }

  function senseEntries(group: string): string[] {
    return config.value?.sense_groups?.[group] ?? []
  }

  function senseName(entry: string): string {
    return entry.split(':')[0] ?? entry
  }

  function senseTool(entry: string): SenseToolInfo | undefined {
    return senseTools.value.find((tool) => tool.name === senseName(entry))
  }

  const orderedRoleSelections = computed(() => {
    const entries = Object.entries(roleSelections.value)
    return entries.sort(([left], [right]) => {
      if (left === primaryRole.value) return -1
      if (right === primaryRole.value) return 1
      return 0
    })
  })

  /** 各媒体类型对应的已启用服务名（AgentDialog 媒体菜单显示用）。 */
  const mediaServicesByType = computed<Record<MediaKind, string | null>>(() => {
    const result: Record<string, string | null> = { image: null, video: null, audio: null }
    if (!config.value?.media) return result as Record<MediaKind, string | null>
    for (const [name, svc] of Object.entries(config.value.media)) {
      if (svc.enabled && svc.url && !result[svc.type]) {
        result[svc.type] = name
      }
    }
    return result as Record<MediaKind, string | null>
  })

  return {
    chatId,
    pet,
    presetName,
    brains,
    senseGroups,
    config,
    senseTools,
    roleSelections,
    primaryRole,
    text,
    editorRef,
    commandOptions,
    commandTabs,
    activeCommandTab,
    comboCommandGroups,
    showCommandMenu,
    activeCommandIndex,
    commandMenuRef,
    roleMenuRef,
    roleMentions,
    matchingRoleMentions,
    showRoleMenu,
    activeRoleIndex,
    uploading,
    mediaHint,
    uploadQueue,
    mediaAttachments,
    sending,
    loading,
    error,
    loaded,
    primarySelection,
    orderedRoleSelections,
    mediaServicesByType,
    close,
    handleSend,
    onEditorKeydown,
    onEditorInput,
    onEditorSelectionChange,
    onEditorPaste,
    selectCommand,
    selectRoleMention,
    selectCommandTab,
    mediaKind,
    formatFileSize,
    resetMedia,
    resetEditor,
    removeMedia,
    onMediaSelected,
    brainInfo,
    brainConfig,
    supportsTools,
    selectBrain,
    senseEntries,
    senseName,
    senseTool,
  }
}
