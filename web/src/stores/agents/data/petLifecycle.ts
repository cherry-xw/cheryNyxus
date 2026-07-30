import type { Ref } from 'vue'
import { agentApi, type RuntimeSelection } from '@/services/agentApi'
import { applyRoleAvatar, generatePet, GHOST_FACES } from '@/features/pets/types/petPresets'
import { findSpawnPosition } from '@/features/pets/motion/petMovement'
import { createPetInstance } from '@/features/pets/petFactory'
import type { PetInstance, PetMood } from '@/features/pets/types/types'
import type { ChatSummary } from '@/services/agentApi'
import type { StreamState } from '../types'
import { defaultBounds } from './streamAccumulator'
import { collectDescendantChatIds } from './historyMerge'

export const CHERY_NYXUS_PRESET = 'cheryNyxus'

/**
 * 按 tribe（同主）内创建序号顺序取灵魂 emoji：第 N 个 ghost = GHOST_FACES[N % 池长]。
 * N = 本 tribe 已存在 ghost 数（排除 self，避 done 实时分支自指：pet 已在 pets 且 isGhost=true）。
 * 非随机、不跨实例去重--「每个主 pet 后面按顺序排列」：同主 ghost 固定序列 0,1,2...，
 * 不同主可同 emoji（空间分离可辨）。face 序号 = 队列序号（ghostCreatedAt 顺序），face 与队列位一一对应。
 * done 实时 + buildMasterAndChildren 重建两处共用。
 */
export function pickGhostFace(
  tribe: string,
  pets: readonly PetInstance[],
  selfId?: string,
): string {
  const count = pets.filter((p) => p.isGhost && p.tribe === tribe && p.instanceId !== selfId).length
  return GHOST_FACES[count % GHOST_FACES.length] ?? '👻'
}

/** 把已交付终态的子 pet 收尾为 ghost；实时 done/role_reply/startSpawn response 共用。 */
export function turnChildIntoGhost(
  pet: PetInstance | undefined,
  pets: readonly PetInstance[],
  facePicker: typeof pickGhostFace = pickGhostFace,
): void {
  if (!pet || pet.isMaster || pet.isGhost) return
  pet.isGhost = true
  pet.canResume = false
  pet.ghostFace = facePicker(pet.tribe, pets, pet.instanceId)
  pet.ghostCreatedAt = performance.now()
  pet.action = 'walk'
  pet.interactionUntil = 0
  pet.moodUntil = 0
  pet.bubbleRepelExtra = 0
  // ghost = 已交付终态，不再工作。child_abandoned/role_reply 路径未调 setWorking(false)
  // 会导致 pet.isWorking 残留 true → HistoryDrawer workingScopePets 仍含此子 pet →
  // agent-loading 持续显「正在输入…」。done 路径已先 setWorking(false)，此处幂等。
  pet.isWorking = false
}

/**
 * 子 chat 历史角色重映射：assistant→role / user→master，附 subPetChatId + callerSubPetChatId。
 * 合并主视图子 chat + ghost 自身抽屉（子 chat 自身载入）共用——使主 agent 发的 spawn prompt
 * （DB 存 role:user）显为 master 而非 user。已为 role/master 的项原样透传。
 * callerSubPetChatId = 父 chat（主 chat 或上层 sub chat）— 用于 MessageBubble 徽章区分 caller。
 */
export function remapChildHistory(
  items: readonly import('../types').HistoryItem[],
  childChatId: string,
  parentChatId: string,
): import('../types').HistoryItem[] {
  return items.map((item) => {
    if (item.role === 'assistant')
      return {
        ...item,
        role: 'role' as const,
        subPetChatId: childChatId,
        callerSubPetChatId: parentChatId,
      }
    if (item.role === 'user')
      return {
        ...item,
        role: 'master' as const,
        subPetChatId: childChatId,
        callerSubPetChatId: parentChatId,
      }
    return item
  })
}

export function createPetLifecycle(
  pets: Ref<PetInstance[]>,
  streams: Ref<Record<string, StreamState>>,
  historyList: Ref<ChatSummary[]>,
  historyListOpen: Ref<boolean>,
  getRuntime: (chatId: string) => RuntimeSelection | undefined,
  setWorking: (pet: PetInstance | undefined, working: boolean, freezeUntil?: number) => void,
  removePetsOnly: (removeIds: string[]) => void,
  removePetsAndStreams: (removeIds: string[]) => void,
  activeNyxusChatId: Ref<string | null>,
) {
  /**
   * 从 chat 摘要建主 pet + 全部后代子 pet，push 进 pets（CP8 抽出，initFromChats / loadSession 复用）。
   * 主 pet = kaomoji face，子 pet = emoji face 落主附近（findSpawnPosition）。
   * face 去重：usedFaces 跨调用累积，避同批撞脸。
   */
  function buildMasterAndChildren(
    masterSummary: ChatSummary,
    allChats: ChatSummary[],
    bounds: { width: number; height: number },
    usedFaces: Set<Record<PetMood, string>>,
  ): void {
    // nyxus 不再建 PetInstance（独立核心 NyxusCore 渲染，脱离 pets[]）
    if (masterSummary.preset === CHERY_NYXUS_PRESET) return
    const preset = generatePet('kaomoji', usedFaces, masterSummary.chatId)
    usedFaces.add(preset.face)
    const master = createPetInstance(preset, bounds, true, undefined, {
      chatId: masterSummary.chatId,
    })
    master.preset = masterSummary.preset
    master.canResume = masterSummary.canResume
    if (masterSummary.workspace) {
      master.workspace = masterSummary.workspace
      master.workspaceValid = masterSummary.workspaceValid
    }
    pets.value.push(master)

    const visited = new Set<string>([masterSummary.chatId])
    const addChildren = (parentSummary: ChatSummary, parentPet: PetInstance): void => {
      const children = allChats
        .filter((c) => c.parentChatId === parentSummary.chatId)
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      for (const child of children) {
        if (visited.has(child.chatId)) {
          console.warn('[agents] 跳过循环 parentChatId', {
            chatId: child.chatId,
            parentChatId: child.parentChatId,
          })
          continue
        }
        visited.add(child.chatId)
        const sub = applyRoleAvatar(generatePet('emoji', usedFaces), child.avatar)
        usedFaces.add(sub.face)
        const pet = createPetInstance(sub, bounds, false, master.instanceId, {
          chatId: child.chatId,
          parentChatId: parentSummary.chatId,
          agentType: child.agentType,
          finished: child.finished,
        })
        pet.canResume = child.canResume
        if (child.workspace) {
          pet.workspace = child.workspace
          pet.workspaceValid = child.workspaceValid
        }
        if (child.finished) {
          pet.ghostFace = pickGhostFace(master.instanceId, pets.value, pet.instanceId)
          pet.ghostCreatedAt = performance.now()
        }
        const pos = findSpawnPosition({ x: parentPet.x, y: parentPet.y }, pets.value, bounds)
        pet.x = pos.x
        pet.y = pos.y
        pet.targetX = pos.x
        pet.targetY = pos.y
        pets.value.push(pet)
        addChildren(child, pet)
      }
    }
    addChildren(masterSummary, master)
  }

  /**
   * 创建主 agent（FAB 点击触发，CP2 接 AgentFab）。
   * 调 chat.create → 主 pet 入 pets。返回新 chatId。
   * opts 必填（brain/senseGroups 来自 config.default，CP2 由调用方读取）。
   */
  async function createMasterPet(opts: {
    /** 预设名（T6）：给出则后端从预设解析编制，brain/senseGroup 可省 */
    preset?: string
    brain?: string
    senseGroup?: string
    mcpServers?: string[]
    chatId?: string
  }): Promise<string> {
    const result = await agentApi.createAgent(opts)
    const chatId = result.chatId
    const bounds = defaultBounds()
    const usedFaces = new Set(pets.value.map((p) => p.face))
    const preset = generatePet('kaomoji', usedFaces, chatId)
    const pet = createPetInstance(preset, bounds, true, undefined, { chatId })
    // 记录初始 runtime（后端响应回填：预设路径编制由后端解析；显式路径 = 传入值）+ 预设名。
    // AgentDialog 首次发送对比 = 相同（无需 runtime.set）；preset pet 切 brain-only。
    pet.preset = opts.preset
    pet.runtime = {
      brain: result.brain,
      senseGroup: result.senseGroup,
      mcpServers: [...result.mcpServers],
    }
    if (result.workspace) {
      pet.workspace = result.workspace
      pet.workspaceValid = result.workspaceValid
    }
    pets.value.push(pet)
    return chatId
  }

  /**
   * 取「活跃」Nexus 会话 chatId（chat-only，不建 PetInstance）：activeNyxusChatId 命中则直返；
   * 否则取最近一条 root + preset=cheryNyxus；全无则新建并设活跃。
   * 多会话模型：打破历史单例，允许多个 Nexus 会话以规避单会话上下文上限（compact 遗忘）。
   * 调用方（NyxusCore）负责 chatSessions.hydrateTree 灌入投影。
   */
  async function getActiveNyxus(): Promise<string> {
    if (activeNyxusChatId.value) return activeNyxusChatId.value
    const chats = await agentApi.listChats(true)
    historyList.value = chats
    const recent = chats
      .filter((c) => !c.parentChatId && c.preset === CHERY_NYXUS_PRESET)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
    if (recent) {
      activeNyxusChatId.value = recent.chatId
      return recent.chatId
    }
    return createNyxusSession()
  }

  /** 始终新建一条 Nexus 会话并设为活跃（AgentDialog 索引签「+新建」、Nexus 历史面板新建入口调用）。 */
  async function createNyxusSession(): Promise<string> {
    const result = await agentApi.createAgent({ preset: CHERY_NYXUS_PRESET })
    activeNyxusChatId.value = result.chatId
    return result.chatId
  }

  /**
   * 隐藏 stage pet（CP8：仅前端移除，**不删 DB**）。主 pet 隐藏 → 自身及全部后代子 pet 移除。
   * runtime 随 pet 移除丢失（loadSession 重建后退 default 预选）；清 streams/active 焦点。
   * 调用方须保证非 isWorking（PetToolbar destroy 按钮 disabled 守卫：pet.isWorking || hasWorkingChild）。
   */
  function hide(chatId: string): void {
    const removeIds = [chatId, ...collectDescendantChatIds(pets.value, chatId)]
    // 统一暂停语义：hide 仅移除 pet 视觉，保留 streams（提问/审批/error 暂停态供重显恢复）
    removePetsOnly(removeIds)
  }

  /**
   * 删除会话（CP8：会话列表 ✕ 调用）。后端 chat.delete 级联全部后代 chat，
   * 前端同步移除 historyList + pets（若在 stage）+ active 焦点。
   */
  async function deleteSession(chatId: string): Promise<void> {
    await agentApi.destroyAgent(chatId)
    const childIds = collectDescendantChatIds(historyList.value, chatId)
    const removeIds = [chatId, ...childIds]
    historyList.value = historyList.value.filter((c) => !removeIds.includes(c.chatId))
    removePetsAndStreams(removeIds)
  }

  /**
   * 从历史列表加载会话到 stage（CP8）。建主+子 pet 入 pets（允许 >5，不挤）。
   * 已在 stage 则仅关抽屉；historyList 缺该会话则 warn（fail loud）。
   */
  function loadSession(chatId: string): void {
    if (pets.value.some((p) => p.chatId === chatId)) {
      historyListOpen.value = false
      return
    }
    const masterSummary = historyList.value.find((c) => c.chatId === chatId)
    if (!masterSummary) {
      console.warn('[agents] loadSession: 会话不在 historyList', chatId)
      return
    }
    const bounds = defaultBounds()
    const usedFaces = new Set(pets.value.map((p) => p.face))
    buildMasterAndChildren(masterSummary, historyList.value, bounds, usedFaces)
    historyListOpen.value = false
  }

  return {
    buildMasterAndChildren,
    createMasterPet,
    getActiveNyxus,
    createNyxusSession,
    hide,
    deleteSession,
    loadSession,
    pickGhostFace,
    remapChildHistory,
  }
}
