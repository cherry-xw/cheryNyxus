import { defineStore, storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import {
  agentApi,
  type ChatSummary,
  type ConfigDto,
  type RuntimeSelection,
  type SenseToolInfo,
  type SessionRuntimeSelection,
} from '@/services/agentApi'
import { applyRoleAvatar, generatePet } from '@/domain/pets/presetsFactory'
import { findSpawnPosition } from '@/domain/pets/motion/movement'
import { createPetInstance } from '@/domain/pets/factory'
import type { PetInstance, PetMood } from '@/domain/pets/types'
import type { ChatSession } from '../chats/types'
import {
  resolveCanResume,
  selectActiveMessage,
  selectOwnTimeline,
} from '../chats/read-model/selectors'
import { useChatSessionsStore } from '../chats'
import { defaultBounds } from './data/streamAccumulator'
import { CHERY_NYXUS_PRESET, createPetLifecycle, turnChildIntoGhost } from './data/petLifecycle'
import { useWorkspacePort } from '../workspace'
import { usePetPresentationStore } from '../pets'
import type { StreamState } from './types'

export type {
  SenseCallRecord,
  HistoryItem,
  ApprovalState,
  QuestionBatchState,
  QuestionItemState,
  QuestionDraftAnswer,
  StreamState,
  RunningTool,
} from './types'

/**
 * Compatibility facade for pet presentation and tool metadata.
 *
 * ChatSession is the only owner of catalog, messages, runs and interactions. This store owns no
 * transport subscription and performs no history replay; `streams` and `historyList` are read-only
 * projections retained while visual components migrate to explicit application ports.
 */
export const useAgentsStore = defineStore('agents', () => {
  const chats = useChatSessionsStore()
  const presentation = usePetPresentationStore()
  const { pets } = storeToRefs(presentation)
  const ui = useWorkspacePort()

  const historyList = computed<ChatSummary[]>({
    get: () => chats.catalogSummaries,
    /** Compatibility setter for tests/legacy callers; canonical storage remains ChatSession. */
    set: (summaries) => chats.initCatalog(summaries),
  })
  const allChatsCache = historyList
  const senseTools = ref<SenseToolInfo[]>([])
  const senseGroupsResolved = ref<{ name: string; senses: string[] }[]>([])
  const globalConfig = ref<ConfigDto | null>(null)
  let initialized = false
  let sessionEvictor: (chatIds: readonly string[]) => Promise<void> = (chatIds) =>
    chats.evictSessions(chatIds)

  const streams = computed<Record<string, StreamState>>(() => {
    const projection: Record<string, StreamState> = {}
    for (const session of Object.values(chats.sessionsById)) {
      const active = selectActiveMessage(session)
      const turn = session.activeTurns[session.activeTurns.length - 1]
      projection[session.chatId] = {
        thinking: turn?.thinking ?? active?.thinking ?? '',
        content: turn?.content ?? active?.content ?? '',
        isWorking: session.run.status === 'running',
        activeRunId: session.run.activeRunId,
        history: selectOwnTimeline(session),
        historyLoaded: session.sync.loaded,
        historyDirty: false,
        retainUntil: session.run.retainUntil,
        approval: session.interaction.approval,
        approvalQueue: session.interaction.approvalQueue,
        questionBatches: session.interaction.questionBatches,
        activeQuestionId: session.interaction.activeQuestionId,
        runningTools: session.interaction.runningTools,
        currentTodo: session.interaction.currentTodo,
        error: session.run.error,
      }
    }
    return projection
  })

  function presetKey(presetId?: string, presetName?: string): string | undefined {
    return presetId ? `id:${presetId}` : presetName ? `name:${presetName}` : undefined
  }

  function summaryForChat(chatId: string): ChatSummary | undefined {
    return historyList.value.find((chat) => chat.chatId === chatId)
  }

  function petForChat(chatId: string): PetInstance | undefined {
    const exact = pets.value.find((pet) => pet.chatId === chatId)
    if (exact && !exact.isMaster) return exact
    const summary = summaryForChat(chatId)
    const key = presetKey(summary?.presetId, summary?.preset)
    if (!key) return exact
    return (
      pets.value.find((pet) => pet.isMaster && presetKey(pet.presetId, pet.preset) === key) ?? exact
    )
  }

  function getRuntime(chatId: string): RuntimeSelection | undefined {
    return chats.sessionsById[chatId]?.context.runtime ?? petForChat(chatId)?.runtime
  }

  function activeRootForPet(pet: PetInstance): string {
    if (!pet.isMaster) return pet.chatId
    const key = presetKey(pet.presetId, pet.preset)
    return (key ? ui.activeRootByPreset.value[key] : undefined) ?? pet.chatId
  }

  function rootChatForChat(chatId: string): string {
    let current = chatId
    const seen = new Set<string>()
    while (current && !seen.has(current)) {
      seen.add(current)
      const parent =
        chats.sessionsById[current]?.meta.parentChatId ??
        summaryForChat(current)?.parentChatId ??
        pets.value.find((pet) => pet.chatId === current)?.parentChatId
      if (!parent) break
      current = parent
    }
    return current
  }

  function workbenchConsumesChat(chatId: string): boolean {
    const root = rootChatForChat(chatId)
    return ui.workbenchWindowsList.value.some(
      (window) => !window.minimized && window.chatId === root,
    )
  }

  function setWorking(pet: PetInstance | undefined, working: boolean, freezeUntil?: number): void {
    if (!pet || (working && pet.isGhost)) return
    pet.isWorking = working
    if (working) {
      pet.action = 'chatting'
      pet.mood = 'curious'
      pet.interactionUntil = 0
      pet.moodUntil = 0
      pet.bubbleRepelExtra = 80
    } else if (freezeUntil && freezeUntil > Date.now()) {
      pet.interactionUntil = freezeUntil
    } else {
      pet.action = 'walk'
      pet.interactionUntil = 0
      pet.bubbleRepelExtra = 0
    }
  }

  function setWorkingForChat(chatId: string, working: boolean, freezeUntil?: number): void {
    const pet = petForChat(chatId)
    if (pet?.isMaster && activeRootForPet(pet) !== rootChatForChat(chatId)) return
    setWorking(pet, working, freezeUntil)
  }

  function removePetsOnly(removeIds: string[]): void {
    if (removeIds.length === 0) return
    const removed = new Set(removeIds)
    pets.value = pets.value.filter((pet) => !removed.has(pet.chatId))
    ui.pruneDeletedChats(removeIds)
  }

  async function purgeDeletedChats(removeIds: readonly string[]): Promise<void> {
    removePetsOnly([...removeIds])
    await sessionEvictor(removeIds)
  }

  function bindSessionEvictor(evictor: (chatIds: readonly string[]) => Promise<void>): void {
    sessionEvictor = evictor
  }

  const lifecycle = createPetLifecycle(
    pets,
    historyList,
    {
      replacePreset: chats.replacePresetCatalog,
      upsert: chats.upsertCatalog,
    },
    ui.historyListOpen,
    getRuntime,
    setWorking,
    removePetsOnly,
    purgeDeletedChats,
    ui.activeNyxusChatId,
  )

  function createChildPet(session: ChatSession): PetInstance | undefined {
    const parentId = session.meta.parentChatId
    if (!parentId || !session.meta.agentType) return undefined
    const parent = pets.value.find((pet) => pet.chatId === parentId)
    if (!parent) return undefined
    const bounds = defaultBounds()
    const usedFaces = new Set(pets.value.map((pet) => pet.face))
    const preset = applyRoleAvatar(generatePet('emoji', usedFaces), session.meta.avatar)
    const pet = createPetInstance(preset, bounds, false, parent.instanceId, {
      chatId: session.chatId,
      parentChatId: parentId,
      agentType: session.meta.agentType,
      finished: session.meta.finished,
    })
    pet.canResume = resolveCanResume(session)
    pet.runtime = {
      brain: session.context.runtime?.brain ?? '',
      senseGroup: session.context.runtime?.senseGroup ?? '',
      mcpServers: [...(session.context.runtime?.mcpServers ?? [])],
    }
    const position = findSpawnPosition({ x: parent.x, y: parent.y }, pets.value, bounds)
    pet.x = position.x
    pet.y = position.y
    pet.targetX = position.x
    pet.targetY = position.y
    pets.value.push(pet)
    return pet
  }

  function reconcilePetsFromSessions(sessions: Record<string, ChatSession>): void {
    const ordered = Object.values(sessions).sort((a, b) => {
      if (!a.meta.parentChatId && b.meta.parentChatId) return -1
      if (a.meta.parentChatId && !b.meta.parentChatId) return 1
      return (a.meta.createdAt ?? 0) - (b.meta.createdAt ?? 0)
    })
    for (const session of ordered) {
      let pet = pets.value.find((candidate) => candidate.chatId === session.chatId)
      if (!session.meta.parentChatId) {
        if (pet) {
          setWorking(pet, session.run.status === 'running')
          pet.canResume = resolveCanResume(session)
        }
        continue
      }
      pet ??= createChildPet(session)
      if (!pet) continue
      if (session.meta.finished) {
        turnChildIntoGhost(pet, pets.value, lifecycle.pickGhostFace)
      } else {
        setWorking(pet, session.run.status === 'running')
        pet.canResume = resolveCanResume(session)
      }
    }
  }

  async function loadSenseMeta(): Promise<void> {
    const [tools, groups] = await Promise.all([
      agentApi.listSenseTools(),
      agentApi.listSenseGroups(),
    ])
    senseTools.value = tools
    senseGroupsResolved.value = groups
  }

  function iconForTool(name: string): string {
    return senseTools.value.find((tool) => tool.name === name)?.icon ?? '⚙'
  }

  function senseGroupsHasSense(senseGroup: string | undefined, senseName: string): boolean {
    if (!senseGroup) return false
    return !!senseGroupsResolved.value
      .find((group) => group.name === senseGroup)
      ?.senses.includes(senseName)
  }

  function activatePresetSession(
    presetId: string | undefined,
    chatId: string,
    presetName?: string,
  ): void {
    const summary = summaryForChat(chatId)
    const key = presetKey(presetId ?? summary?.presetId, presetName ?? summary?.preset)
    if (!key) return
    ui.activeRootByPreset.value[key] = chatId
    setWorking(petForChat(chatId), chats.sessionsById[chatId]?.run.status === 'running')
  }

  async function initFromChats(): Promise<void> {
    if (initialized) return
    if (chats.catalogSummaries.length === 0) await chats.refreshCatalog()
    const config = await agentApi.getConfig().catch((cause) => {
      console.warn('[agents] failed to load presentation config:', cause)
      return undefined
    })
    globalConfig.value = config ?? null
    initialized = true
    void loadSenseMeta().catch((cause) =>
      console.warn('[agents] failed to load sense metadata:', cause),
    )

    const summaries = [...chats.catalogSummaries]
    const activePresetIds = config
      ? new Set(
          Object.values(config.presets ?? {})
            .map((preset) => preset.id)
            .filter(Boolean),
        )
      : undefined
    const activePresetNames = config ? new Set(Object.keys(config.presets ?? {})) : undefined
    const roots = summaries.filter(
      (chat) =>
        !chat.parentChatId &&
        chat.preset !== CHERY_NYXUS_PRESET &&
        (!activePresetIds ||
          (chat.presetId
            ? activePresetIds.has(chat.presetId)
            : !!chat.preset && activePresetNames!.has(chat.preset))),
    )
    const grouped = new Map<string, ChatSummary[]>()
    for (const root of roots) {
      const key = root.presetId ?? (root.preset ? `legacy:${root.preset}` : root.chatId)
      grouped.set(key, [...(grouped.get(key) ?? []), root])
    }
    const selected = [...grouped.values()]
      .map((entries) => ({
        root: [...entries].sort(
          (a, b) =>
            (b.lastUserActivityAt ?? b.updatedAt ?? 0) - (a.lastUserActivityAt ?? a.updatedAt ?? 0),
        )[0]!,
        recency: Math.max(
          ...entries.map((entry) => entry.lastUserActivityAt ?? entry.updatedAt ?? 0),
        ),
      }))
      .sort((a, b) => b.recency - a.recency)
      .slice(0, 5)
    const bounds = defaultBounds()
    const usedFaces = new Set<Record<PetMood, string>>()
    for (const { root } of selected) {
      lifecycle.buildMasterAndChildren(root, summaries, bounds, usedFaces)
    }
    reconcilePetsFromSessions(chats.sessionsById)
  }

  async function fetchHistoryList(): Promise<void> {
    await chats.refreshCatalog()
  }

  function latestRootInPreset(presetId?: string, presetName?: string): string | undefined {
    return historyList.value
      .filter(
        (chat) =>
          !chat.parentChatId &&
          (presetId ? chat.presetId === presetId : chat.preset === presetName),
      )
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]?.chatId
  }

  async function setSessionRuntime(
    chatId: string,
    selection: SessionRuntimeSelection,
  ): Promise<{ applied: string[]; deferredRunning: string[] }> {
    const result = await agentApi.setSessionRuntime(chatId, selection)
    const session = chats.sessionsById[chatId]
    if (session) session.context.runtime = { ...selection.primary }
    const pet = petForChat(chatId)
    if (pet) {
      pet.runtime = {
        ...selection.primary,
        mcpServers: [...(selection.primary.mcpServers ?? [])],
      }
    }
    return result
  }

  async function createMasterPet(
    options: Parameters<typeof lifecycle.createMasterPet>[0],
  ): Promise<string> {
    const chatId = await lifecycle.createMasterPet(options)
    await chats.refreshCatalog()
    return chatId
  }

  return {
    pets,
    streams,
    historyList,
    allChatsCache,
    senseTools,
    senseGroupsResolved,
    globalConfig,
    ...ui,
    ...lifecycle,
    createMasterPet,
    initFromChats,
    fetchHistoryList,
    loadSenseMeta,
    iconForTool,
    senseGroupsHasSense,
    latestRootInPreset,
    summaryForChat,
    getRuntime,
    setSessionRuntime,
    activatePresetSession,
    activeRootForPet,
    rootChatForChat,
    workbenchConsumesChat,
    petForChat,
    setWorkingForChat,
    reconcilePetsFromSessions,
    removePetsOnly,
    purgeDeletedChats,
    bindSessionEvictor,
  }
})
