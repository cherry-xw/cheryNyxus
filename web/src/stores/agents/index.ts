import { defineStore } from "pinia";
import { ref } from "vue";
import { agentApi, type ChatSummary, type RuntimeSelection } from "@/services/agentApi";
import { generatePet, GHOST_FACES } from "@/features/pets/petPresets";
import { findSpawnPosition } from "@/features/pets/petMovement";
import { createPetInstance } from "@/features/pets/usePetWorld";
import type { PetInstance, PetMood } from "@/features/pets/types";
import type {
  StreamState,
  StreamChunkData,
  StagedChunkData,
  ChunkMessage,
  NotificationMessage,
  HistoryItem,
} from "./types";
import { accumulateStaged, sameRuntime, defaultBounds } from "./streamAccumulator";

// re-export 公共契约类型（保 @/stores/agents 导入路径兼容：4 .vue + stores/index.ts 零改动）
export type { SenseCallRecord, HistoryItem, ApprovalState, StreamState } from "./types";

/**
 * 按 tribe（同主）内创建序号顺序取灵魂 emoji：第 N 个 ghost = GHOST_FACES[N % 池长]。
 * N = 本 tribe 已存在 ghost 数（排除 self，避 done 实时分支自指：pet 已在 pets 且 isGhost=true）。
 * 非随机、不跨实例去重--「每个主 pet 后面按顺序排列」：同主 ghost 固定序列 0,1,2...，
 * 不同主可同 emoji（空间分离可辨）。face 序号 = 队列序号（ghostCreatedAt 顺序），face 与队列位一一对应。
 * done 实时 + buildMasterAndChildren 重建两处共用。
 */
function pickGhostFace(tribe: string, pets: readonly PetInstance[], selfId?: string): string {
  const count = pets.filter((p) => p.isGhost && p.tribe === tribe && p.instanceId !== selfId).length;
  return GHOST_FACES[count % GHOST_FACES.length] ?? "👻";
}

/**
 * 子 chat 历史角色重映射：assistant→subagent / user→master，附 subPetChatId。
 * 合并主视图子 chat + ghost 自身抽屉（子 chat 自身载入）共用——使主 agent 发的 spawn prompt
 * （DB 存 role:user）显为 master 而非 user。已为 subagent/master 的项原样透传。
 */
function remapChildHistory(items: readonly HistoryItem[], childChatId: string): HistoryItem[] {
  return items.map((item) => {
    if (item.role === "assistant") return { ...item, role: "subagent" as const, subPetChatId: childChatId };
    if (item.role === "user") return { ...item, role: "master" as const, subPetChatId: childChatId };
    return item;
  });
}

/**
 * agents store：agent/chat 状态层单一数据源。
 *
 * - pets: PetInstance[] —— chat.list + chunk/notification 驱动（CP1 由 initFromChats 重建）
 * - streams: Record<chatId, StreamState> —— chunk 按 requestId→chatId 路由累积
 * - activeDialogChatId / activeHistoryChatId —— UI 焦点（CP2+ 弹窗/抽屉用）
 *
 * routeChunk/routeNotification 由 App.vue 订阅 wsClient 回调注入。
 */
export const useAgentsStore = defineStore("agents", () => {
  const pets = ref<PetInstance[]>([]);
  const activeDialogChatId = ref<string | null>(null);
  const activeHistoryChatId = ref<string | null>(null);
  const streams = ref<Record<string, StreamState>>({});
  // CP8 会话列表：historyListOpen 驱动 SessionList 抽屉；historyList 缓存 chat.list(includePreview) 全量会话
  const historyListOpen = ref(false);
  const historyList = ref<ChatSummary[]>([]);
  // 设置面板：settingsOpen 驱动 SettingsDialog（AgentFab ⚙️ 入口）
  const settingsOpen = ref(false);

  // requestId → chatId 映射（流式 RPC 调用前由 trackRequest 注册，chunk/notification 路由用）
  const requestMap = new Map<string, string>();
  // 子 chatId → spawn 等待状态（subagent_created 登记；done 时按 wait 决策回传 subagent.result / 注入主 chat）
  const spawnWaits = new Map<string, { parentChatId: string; type: string; wait: boolean }>();
  // 完整 chat 列表缓存（initFromChats 时拉取，getHistory 用它找子 chat，避免仅依赖 pets 的 top-5 限制）
  const allChatsCache = ref<ChatSummary[]>([]);
  let initialized = false;

  /**
   * 从 chat 摘要建主 pet + 其子 pet，push 进 pets（CP8 抽出，initFromChats / loadSession 复用）。
   * 主 pet = kaomoji face，子 pet = emoji face 落主附近（findSpawnPosition）。
   * face 去重：usedFaces 跨调用累积，避同批撞脸。
   */
  function buildMasterAndChildren(
    masterSummary: ChatSummary,
    allChats: ChatSummary[],
    bounds: { width: number; height: number },
    usedFaces: Set<Record<PetMood, string>>,
  ): void {
    const preset = generatePet("kaomoji", usedFaces);
    usedFaces.add(preset.face);
    const master = createPetInstance(preset, bounds, true, undefined, { chatId: masterSummary.chatId });
    pets.value.push(master);

    const children = allChats
      .filter((c) => c.parentChatId === masterSummary.chatId)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)); // createdAt ASC -> 历史 ghost 按 spawn 序赋 performance.now()（避 listChats updated_at DESC 序错排队列）
    for (const c of children) {
      const sub = generatePet("emoji", usedFaces);
      usedFaces.add(sub.face);
      const pet = createPetInstance(sub, bounds, false, master.instanceId, {
        chatId: c.chatId,
        parentChatId: masterSummary.chatId,
        finished: c.finished,
      });
      // finished 子 pet（历史 ghost）按 tribe 序号取灵魂 emoji（N=本主已建 ghost 数，含迭代顺序=队列位）
      if (c.finished) {
        pet.ghostFace = pickGhostFace(master.instanceId, pets.value, pet.instanceId);
        pet.ghostCreatedAt = performance.now(); // 历史 ghost 按 createdAt ASC 序赋值（= spawn 先后，上方 children 已排序）
      }
      const pos = findSpawnPosition({ x: master.x, y: master.y }, pets.value, bounds);
      pet.x = pos.x;
      pet.y = pos.y;
      pet.targetX = pos.x;
      pet.targetY = pos.y;
      pets.value.push(pet);
    }
  }

  /** 连接成功后拉 chat.list → 重建 pet 树。幂等（initialized 守卫），失败可重试。 */
  async function initFromChats(): Promise<void> {
    if (initialized) return;
    // listChats 失败 → initialized 不置位，下次 status=connected 时可重试
    const chats = await agentApi.listChats();
    initialized = true;

    // 缓存完整 chat 列表（getHistory 用它找子 chat，避免仅依赖 pets 的 top-5 限制）
    allChatsCache.value = chats;
    console.log("[agents] initFromChats: allChatsCache 已初始化", {
      totalChats: chats.length,
      mainChats: chats.filter(c => !c.parentChatId).length,
      childChats: chats.filter(c => c.parentChatId).length,
    });

    const bounds = defaultBounds();
    const usedFaces = new Set<Record<PetMood, string>>();
    const mains = chats.filter((c) => !c.parentChatId);

    // CP8：stage 默认显最近 5 个会话。sessionRecency = max(master.updatedAt, 其子 updatedAt)
    //   （子 agent done 会回传/注入主 chat → 主 updatedAt 被刷新，但子运行中窗口期取 max 更准）
    const topMasters = mains
      .map((m) => {
        const children = chats.filter((c) => c.parentChatId === m.chatId);
        const recency = Math.max(m.updatedAt ?? 0, ...children.map((c) => c.updatedAt ?? 0));
        return { m, recency };
      })
      .sort((a, b) => b.recency - a.recency)
      .slice(0, 5)
      .map((x) => x.m);

    for (const m of topMasters) {
      buildMasterAndChildren(m, chats, bounds, usedFaces);
    }

    // 重连后重建 spawnWaits + 检测主卡死(容错机制,见 docs/agent-pet.md §5.1)
    await rebuildSpawnWaits(chats);
  }

  /**
   * 重连后重建 spawnWaits + 检测主卡死(容错机制)。
   *
   * 扫描所有 chat:
   * - 子 chat running=true 且 finished=false: 重建 spawnWaits.set(childChatId, ...)
   * - 子 chat finished=true 且 running=false: 子已完成,读子结果,调 subagentResult 补传(幂等)
   * - 主 chat running=true 且 finished=false 但前端无跟踪流: 判定卡死,abort+重发
   *
   * 由 initFromChats 调用(F5 刷新),或由 App.vue onStatus 瞬断重连时直接调用。
   */
  async function rebuildSpawnWaits(chats?: ChatSummary[]): Promise<void> {
    const allChats = chats ?? (await agentApi.listChats());

    for (const chat of allChats) {
      // 子 chat 处理
      if (chat.parentChatId) {
        const parentPet = pets.value.find((p) => p.chatId === chat.parentChatId);
        if (!parentPet) continue; // 主 pet 不存在,跳过

        if (chat.running && !chat.finished) {
          // 子还在跑:重建 spawnWaits,继续跟踪
          const subagentType = parentPet.runtime?.senseGroups?.[0] ?? "unknown";
          spawnWaits.set(chat.chatId, {
            parentChatId: chat.parentChatId,
            type: subagentType,
            wait: true, // 默认 wait=true(主在等)
          });
          console.log(`[agents] rebuildSpawnWaits: 重建子 chat 等待 ${chat.chatId}`);
        } else if (chat.finished && !chat.running) {
          // 子已完成:读子结果,补传给主(幂等)
          try {
            const { requestId, done } = agentApi.getHistory(chat.chatId);
            trackRequest(requestId, chat.chatId);  // 注册 requestId 供 routeChunk 路由
            const childStream = ensureStream(chat.chatId);
            childStream.history = [];

            // 等待历史加载完成
            await done;

            // 从 history 中读取最后一条 assistant 消息作为结果
            const lastAssistant = childStream.history
              .filter(item => item.role === "assistant")
              .pop();
            const result = lastAssistant?.content ?? "";

            await agentApi.subagentResult(chat.chatId, result);
            console.log(`[agents] rebuildSpawnWaits: 补传子结果 ${chat.chatId}`, { resultLen: result.length });
          } catch (err) {
            console.warn(`[agents] rebuildSpawnWaits: 补传子结果失败 ${chat.chatId}`, err);
          }
        }
      }

      // 主 chat 卡死检测
      if (!chat.parentChatId && chat.running && !chat.finished) {
        // 主还在跑,但前端是否有跟踪流?
        // requestMap 是闭包变量,无法直接访问。简化:假设主 running=true 但前端无 activeDialogChatId 匹配 → 卡死
        // 实际应检查 requestMap 里是否有该主 chat 的 requestId
        // 此处简化:直接 abort(保守策略,避免误判)
        // TODO: 精确检测 requestMap
        if (activeDialogChatId.value !== chat.chatId) {
          // 主不在前台,且 running=true → 可能卡死
          console.warn(`[agents] rebuildSpawnWaits: 检测到主 chat 可能卡死 ${chat.chatId},abort`);
          try {
            await agentApi.abortAgent(chat.chatId);
            console.log(`[agents] rebuildSpawnWaits: 已 abort 卡死主 chat ${chat.chatId}`);
            // TODO: 是否自动重发?需用户手动重发,避免自动重发导致重复执行
          } catch (err) {
            console.warn(`[agents] rebuildSpawnWaits: abort 失败 ${chat.chatId}`, err);
          }
        }
      }
    }
  }

  /**
   * 创建主 agent（FAB 点击触发，CP2 接 AgentFab）。
   * 调 chat.create → 主 pet 入 pets。返回新 chatId。
   * opts 必填（brain/senseGroups 来自 config.default，CP2 由调用方读取）。
   */
  async function createMasterPet(opts: {
    brain: string;
    senseGroups: string[];
    mcpServers?: string[];
    chatId?: string;
  }): Promise<string> {
    const chatId = await agentApi.createAgent(opts);
    const bounds = defaultBounds();
    const usedFaces = new Set(pets.value.map((p) => p.face));
    const preset = generatePet("kaomoji", usedFaces);
    const pet = createPetInstance(preset, bounds, true, undefined, { chatId });
    // 记录初始 runtime 到 pet（AgentDialog 首次发送时对比 = 相同，无需 runtime.set）
    pet.runtime = {
      brain: opts.brain,
      senseGroups: [...opts.senseGroups],
      mcpServers: [...(opts.mcpServers ?? [])],
    };
    pets.value.push(pet);
    return chatId;
  }

  /** 读 chat 当前 runtime（首次 = createMasterPet 时的 default）。AgentDialog 初始化复选框用。
   * runtime 挂 pet（pet.runtime）；hide 移除 pet / 刷新 initFromChats 不恢复 → undefined，AgentDialog 退 default 预选。 */
  function getRuntime(chatId: string): RuntimeSelection | undefined {
    return pets.value.find((p) => p.chatId === chatId)?.runtime;
  }

  /**
   * 切 pet 工作态视觉：action=chatting（复用现有 chatting motion，不新增 action——plan §10 决策）。
   * interactionUntil=0 → usePetWorld tickPet chatting 分支不回收（agent 工作态无超时，由 done/error 解除）。
   *
   * Req 7: freezeUntil 可选参数。done 后保留期（retainUntil）内 pet 保持 chatting 不移动。
   * - working=true: action=chatting, interactionUntil=0, bubbleRepelExtra=80
   * - working=false + freezeUntil: isWorking=false, interactionUntil=freezeUntil, action 保持 chatting（tickPet 到期切 walk）
   * - working=false 无 freezeUntil: action=walk, bubbleRepelExtra=0（立即恢复移动）
   */
  function setWorking(pet: PetInstance | undefined, working: boolean, freezeUntil?: number): void {
    if (!pet) return;
    pet.isWorking = working;
    if (working) {
      pet.action = "chatting";
      pet.mood = "curious";
      pet.interactionUntil = 0;
      pet.moodUntil = 0;
      pet.bubbleRepelExtra = 80;
    } else if (freezeUntil && freezeUntil > Date.now()) {
      // 保留期冻结：action 保持 chatting，tickPet 在 interactionUntil 到期时切 walk
      pet.interactionUntil = freezeUntil;
      // bubbleRepelExtra 保持，tickPet 到期清零
    } else {
      // 解除：回到 walk，mood 让 tickPet 在 moodUntil 处恢复（清零立即走 restMood）
      pet.action = "walk";
      pet.moodUntil = 0;
      pet.bubbleRepelExtra = 0;
    }
  }

  /**
   * 发消息（AgentDialog 调用）。runtime diff 决策：
   *   - runtime 提供 + 与当前不同 → agentApi.setRuntime 再 sendMessage
   *   - runtime 与当前同 / 未提供 → 直接 sendMessage
   *   - 首次（chat 刚由 FAB 创建）→ runtime 已是 default，直接 sendMessage
   * 发送后重置 stream 累积 + pet 进 isWorking（chatting action）。
   * 错误显式抛出（规则 12），调用方 try/catch 显示错误态。
   */
  async function sendMessage(chatId: string, text: string, runtime?: RuntimeSelection): Promise<void> {
    if (runtime) {
      const pet = pets.value.find((p) => p.chatId === chatId);
      const cur = pet?.runtime;
      if (!cur || !sameRuntime(cur, runtime)) {
        await agentApi.setRuntime(chatId, runtime);
        if (pet) {
          pet.runtime = {
            brain: runtime.brain,
            senseGroups: [...runtime.senseGroups],
            mcpServers: [...(runtime.mcpServers ?? [])],
          };
        }
      }
    }
    const { requestId } = agentApi.sendMessage(chatId, text);
    trackRequest(requestId, chatId);
    const pet = pets.value.find((p) => p.chatId === chatId);
    setWorking(pet, true);
    const stream = ensureStream(chatId);
    // 新一轮发送：重置实时累积 + 清上一轮 pending 审批（若有）。
    // history 不动——历史由 getHistory 显式载入；实时消息完成不自动入 history（后端 chat.get 才是历史源）。
    stream.thinking = "";
    stream.content = "";
    stream.isWorking = true;
    stream.approval = undefined;
    stream.retainUntil = undefined;
  }

  /**
   * 载入历史（HistoryDrawer 打开时调）。staged chunks 经 routeChunk 累积到 stream.history；
   * loaded notification 标 historyLoaded=true。不 setWorking（历史载入非工作态）。
   * 同时载入所有子 chat 历史，合并后按时间排序，实现群聊样式渲染。
   */
  async function getHistory(chatId: string): Promise<void> {
    const { requestId, done } = agentApi.getHistory(chatId);
    trackRequest(requestId, chatId);
    // ensureStream 已就绪累积；reset history 防止重复载入累积两份
    const stream = ensureStream(chatId);
    stream.history = [];
    stream.historyLoaded = false;
    // CP7: chat.get response 携带 contextUsage → 更新 pet.contextUsage（历史载入一次性同步，ContextBar 消费）
    done
      .then((res) => {
        const cu = (res.data as { contextUsage?: number } | undefined)?.contextUsage;
        if (typeof cu === "number") {
          const pet = pets.value.find((p) => p.chatId === chatId);
          if (pet) pet.contextUsage = cu;
        }
      })
      .catch((e) => console.error("[agents] getHistory response 失败:", e));

    // 同时获取子 chat 历史并合并（群聊样式）
    try {
      // 从 allChatsCache 找子 chat（避免仅依赖 pets 的 top-5 限制）
      const childChatSummaries = allChatsCache.value.filter((c) => c.parentChatId === chatId);
      console.log("[agents] getHistory: 查找子 chat", { chatId, cacheSize: allChatsCache.value.length, childCount: childChatSummaries.length });

      // 并行获取所有子 chat 的历史
      const childHistoryPromises = childChatSummaries.map(async (childSummary) => {
        const childChatId = childSummary.chatId;

        console.log("[agents] getHistory: 加载子 chat 历史", { childChatId });

        const { requestId: childRequestId, done: childDone } = agentApi.getHistory(childChatId);
        trackRequest(childRequestId, childChatId);  // 注册 requestId 供 routeChunk 路由
        const childStream = ensureStream(childChatId);
        childStream.history = [];

        // 等待子 chat 历史加载完成
        await childDone;

        // 统计角色分布（调试）
        const roleCounts = childStream.history.reduce((acc, item) => {
          acc[item.role] = (acc[item.role] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        console.log("[agents] getHistory: 子 chat 历史加载完成", {
          childChatId,
          messageCount: childStream.history.length,
          roleCounts,
        });

        // 子 chat 历史角色重映射 + 关联子 pet chatId（remapChildHistory：
        //   assistant → subagent（子 pet 回复）；user → master（主 pet 发给子 pet 的 prompt 注入））
        // UI 按 subPetChatId 从 pets 查真实 face.calm + name（弃 agentType 首字符，避 "子" 字 fallback）
        return remapChildHistory(childStream.history, childChatId);
      });

      // 等待主 chat 和所有子 chat 历史加载完成
      await done;
      const childHistories = await Promise.all(childHistoryPromises);

      // 重置 historyLoaded（loaded notification 可能已设 true，但子 chat 还没合并）
      stream.historyLoaded = false;

      // opened chat 自身为子 chat（ghost 自身抽屉）→ 自身历史也走 remapChildHistory
      // （使首条 spawn prompt 显为 master 而非 user；主 chat 自身历史保持 user/assistant）
      const openedIsSubChat = !!allChatsCache.value.find((c) => c.chatId === chatId)?.parentChatId;
      const ownHistory = openedIsSubChat ? remapChildHistory(stream.history, chatId) : stream.history;

      // 合并所有历史（主 chat + 子 chat）
      const allHistory = [
        ...ownHistory,
        ...childHistories.flat(),
      ];

      // 按 createdAt 排序（实现群聊样式的时间线）
      allHistory.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

      // 调试：输出 allHistory 中每个消息的 role
      const roleDistribution = allHistory.reduce((acc, item) => {
        acc[item.role] = (acc[item.role] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      console.log("[agents] getHistory: 合并完成", {
        totalMessages: allHistory.length,
        subagentCount: allHistory.filter(h => h.role === "subagent").length,
        roleDistribution,
        firstFewItems: allHistory.slice(0, 3).map(item => ({ role: item.role, petName: item.petName, contentLen: item.content?.length ?? 0 })),
      });

      // 通过 streams.value[chatId] 赋值（而非 stream 变量），确保 Vue 响应式系统检测到变化
      streams.value[chatId] = {
        ...stream,
        history: allHistory,
        historyLoaded: true,
      };

      // 调试：确认赋值后 stream.history 的状态
      console.log("[agents] getHistory: stream.history 赋值完成", {
        chatId,
        historyLength: streams.value[chatId].history.length,
        subagentCount: streams.value[chatId].history.filter(h => h.role === "subagent").length,
      });
    } catch (e) {
      console.error("[agents] 合并子 chat 历史失败:", e);
      // 降级：只显示主 chat 历史
      stream.historyLoaded = true;
    }
  }

  /**
   * 中止 chat 当前流（CP6 主/子 pet 工具栏）。后端 chat.abort 清运行时 + 释放连接，
   * 可能不推 done → 手动清工作态（pet isWorking + stream.isWorking）。
   */
  async function abort(chatId: string): Promise<void> {
    await agentApi.abortAgent(chatId);
    const pet = pets.value.find((p) => p.chatId === chatId);
    setWorking(pet, false);
    const stream = streams.value[chatId];
    if (stream) {
      stream.isWorking = false;
      stream.retainUntil = undefined;
    }
  }

  /**
   * 立即清 pending 审批（ApprovalCard submit 后调用，不等 accept/rejected notification 回来）。
   * 后续 accept/rejected notification 仍会清（已 undefined 无害）。
   */
  function dismissApproval(chatId: string): void {
    const stream = streams.value[chatId];
    if (stream) stream.approval = undefined;
  }

  /**
   * 移除 pets + streams + spawnWaits + active 焦点（hide/deleteSession 共用，CP8）。
   * runtime 挂 pet → pet splice 后 runtime 随之消失（不再单独保留；loadSession 重建 pet 时 AgentDialog 退 default 预选）。
   */
  function removePetsByIds(removeIds: string[]): void {
    for (const id of removeIds) {
      const idx = pets.value.findIndex((p) => p.chatId === id);
      if (idx >= 0) pets.value.splice(idx, 1);
      delete streams.value[id];
      spawnWaits.delete(id);
    }
    if (activeDialogChatId.value && removeIds.includes(activeDialogChatId.value)) {
      activeDialogChatId.value = null;
    }
    if (activeHistoryChatId.value && removeIds.includes(activeHistoryChatId.value)) {
      activeHistoryChatId.value = null;
    }
  }

  /**
   * 隐藏 stage pet（CP8：仅前端移除，**不删 DB**）。主 pet 隐藏 → 自身 + 子 pet 移除。
   * runtime 随 pet 移除丢失（loadSession 重建后退 default 预选）；清 streams/spawnWaits/active 焦点。
   * 调用方须保证非 isWorking（PetToolbar destroy 按钮 disabled 守卫：pet.isWorking || hasWorkingChild）。
   */
  function hide(chatId: string): void {
    const removeIds = [
      chatId,
      ...pets.value.filter((p) => p.parentChatId === chatId).map((p) => p.chatId),
    ];
    removePetsByIds(removeIds);
  }

  /**
   * 删除会话（CP8：会话列表 ✕ 调用）。后端 chat.delete 级联子 chat（主 chat），
   * 前端同步移除 historyList + pets（若在 stage）+ active 焦点。
   */
  async function deleteSession(chatId: string): Promise<void> {
    await agentApi.destroyAgent(chatId);
    const childIds = historyList.value
      .filter((c) => c.parentChatId === chatId)
      .map((c) => c.chatId);
    const removeIds = [chatId, ...childIds];
    historyList.value = historyList.value.filter((c) => !removeIds.includes(c.chatId));
    removePetsByIds(removeIds);
  }

  /**
   * 从历史列表加载会话到 stage（CP8）。建主+子 pet 入 pets（允许 >5，不挤）。
   * 已在 stage 则仅关抽屉；historyList 缺该会话则 warn（fail loud）。
   */
  function loadSession(chatId: string): void {
    if (pets.value.some((p) => p.chatId === chatId)) {
      historyListOpen.value = false;
      return;
    }
    const masterSummary = historyList.value.find((c) => c.chatId === chatId);
    if (!masterSummary) {
      console.warn("[agents] loadSession: 会话不在 historyList", chatId);
      return;
    }
    const bounds = defaultBounds();
    const usedFaces = new Set(pets.value.map((p) => p.face));
    buildMasterAndChildren(masterSummary, historyList.value, bounds, usedFaces);
    historyListOpen.value = false;
  }

  /** 拉取全量会话列表（includePreview=true）缓存到 historyList。CP8：会话列表打开时调。 */
  async function fetchHistoryList(): Promise<void> {
    historyList.value = await agentApi.listChats(true);
  }

  /**
   * 注册 requestId→chatId（流式 RPC 调用后立即调用，先于 response/ chunks）。
   * 供未来 sendMessage/getHistory action 复用（CP2 AgentDialog 发消息时记录）。
   */
  function trackRequest(requestId: string, chatId: string): void {
    if (requestId) requestMap.set(requestId, chatId);
  }

  function ensureStream(chatId: string): StreamState {
    let s = streams.value[chatId];
    if (!s) {
      s = { thinking: "", content: "", isWorking: true, history: [], historyLoaded: false };
      streams.value[chatId] = s;
    }
    return s;
  }

  /**
   * 路由 chunk 到对应 pet 的 StreamState（按 requestId→chatId）。
   * - stream chunk：实时增量，累积到 thinking/content（CP1/CP2 双气泡）
   * - staged chunk：历史回放（chat.get），累积到 stream.history（CP4 HistoryDrawer）
   * 后端 chat.get handler 逐消息行 emit：thinking_end → content_end → sense_end×N（顺序固定）。
   * 累积策略：thinking_end 开新 assistant item；content_end 按 role 分流；sense_end 挂当前 assistant item。
   * 未跟踪的 requestId 静默忽略。
   */
  function routeChunk(chunk: unknown): void {
    const c = chunk as ChunkMessage | null;
    if (!c || !c.requestId) return;
    const chatId = requestMap.get(c.requestId);
    if (!chatId) {
      console.log("[agents] routeChunk: requestId 未找到映射", { requestId: c.requestId, type: c.type });
      return;
    }

    const stream = ensureStream(chatId);

    if (c.type === "staged") {
      accumulateStaged(stream, c.data as StagedChunkData | undefined);
      // 历史载入非工作态：不动 isWorking / pet action
      return;
    }

    // stream chunk：实时增量累积
    const data = (c.data as StreamChunkData | undefined) ?? {};
    if (data.thinking) stream.thinking += data.thinking;
    if (data.content) stream.content += data.content;
    stream.isWorking = true;

    const pet = pets.value.find((p) => p.chatId === chatId);
    setWorking(pet, true);
  }

  /**
   * 路由 notification：更新工作状态 / 审批 / 子 agent 生命周期。
   * done/error：工作态解除（+ 子 agent done 回传/注入按 wait 决策）。
   * loaded：chat.get staged 回放完成 → historyLoaded=true。
   * interrupt/accept/rejected：审批状态机（CP5 ApprovalCard 数据源）。
   * subagent_created/destroyed：子 pet 生命周期（CP3）。
   */
  function routeNotification(notif: unknown): void {
    const n = notif as NotificationMessage | null;
    if (!n || !n.type) return;
    const requestId = n.requestId;
    const chatId = requestId ? requestMap.get(requestId) : undefined;
    const type = n.type;

    if (type === "done" || type === "error") {
      if (chatId) {
        // 子 agent done：按 wait 回传主 sense（wait=true）或注入主 chat（wait=false）。
        // error 不回传（fail loud：下面 console.error 已上报），仅清状态。
        const spawnWait = spawnWaits.get(chatId);
        if (spawnWait && type === "done") {
          const childContent = streams.value[chatId]?.content ?? "";
          if (spawnWait.wait) {
            // wait=true：回传主 sense，唤醒挂起的 spawn_subagent
            agentApi
              .subagentResult(chatId, childContent)
              .catch((e) => console.error("[agents] subagentResult 回传失败:", e));
          } else {
            // wait=false：注入主 chat（role=user 前缀），复用 store.sendMessage（trackRequest+setWorking+ensureStream）
            // 主 pet 会收到新一轮 chunk 流式显示
            const inject = `[子agent ${spawnWait.type}] ${childContent}`;
            sendMessage(spawnWait.parentChatId, inject).catch((e) =>
              console.error("[agents] 子结果注入主 chat 失败:", e),
            );
          }
          spawnWaits.delete(chatId);
        }
        const stream = streams.value[chatId];
        if (stream) {
          stream.isWorking = false;
          // done 后 content/thinking 气泡保留 20s（下一条消息前）；error 不保留（即时隐藏）
          if (type === "done") stream.retainUntil = Date.now() + 20000;
        }
        const pet = pets.value.find((p) => p.chatId === chatId);
        // Req 7: done 后保留期内 pet 冻结不移动（freezeUntil=retainUntil）；error 立即恢复
        setWorking(pet, false, type === "done" ? stream?.retainUntil : undefined);
        // CP7: done notification 携带 contextUsage（token/brain.contextLimit）→ 更新 pet.contextUsage（ContextBar 消费）
        // 子 agent done（finished=true）→ 转 ghost（灵魂态保留），pick 灵魂 emoji 按 tribe 序号取（selfId 排除已置 isGhost 的自身）
        if (type === "done" && pet) {
          const d = (n.data ?? {}) as { contextUsage?: number; finished?: boolean };
          if (typeof d.contextUsage === "number") pet.contextUsage = d.contextUsage;
          if (d.finished === true && !pet.isMaster) {
            pet.isGhost = true;
            pet.ghostFace = pickGhostFace(pet.tribe, pets.value, pet.instanceId);
            pet.ghostCreatedAt = performance.now(); // ghost 创建时间戳（队列排序用）
            // 解除 done 保留期冻结（retainUntil 为 content 气泡保留，ghost 无气泡）：灵魂态立即入队跟随。
            // 否则 action=chatting + interactionUntil=retainUntil 冻结 20s 不移动 -> "新生成 ghost 不跟随，刷新才对"
            pet.action = "walk";
            pet.interactionUntil = 0;
            pet.moodUntil = 0;
            pet.bubbleRepelExtra = 0;
          }
        }
      }
      if (requestId) requestMap.delete(requestId);
      // CP2: error 时弹错误提示
      if (type === "error" && n.data) {
        console.error("[agents] stream error:", (n as { data?: { message?: string } }).data?.message ?? n.data);
      }
      return;
    }

    if (type === "loaded") {
      // chat.get staged 全部 emit 完 → 标记历史载入完成（HistoryDrawer 据此显骨架→内容）
      if (chatId) {
        const stream = streams.value[chatId];
        if (stream) stream.historyLoaded = true;
      }
      if (requestId) requestMap.delete(requestId);
      return;
    }

    if (type === "interrupt") {
      // 感官审批请求（streamMapper sense_end → interrupt，仅 confirm/manual 推送；auto sense 不推）。
      // 后端 InterruptNotificationData: {approvalId, senseName, arguments, supervisionLevel, needsApproval, waitTime, createdAt}
      const d = (n.data ?? {}) as {
        approvalId?: string;
        senseName?: string;
        arguments?: string;
        needsApproval?: boolean;
        waitTime?: number;
        createdAt?: number;
      };
      if (!d.approvalId || !d.senseName) {
        console.warn("[agents] interrupt: 字段残缺", d);
        return;
      }
      if (chatId) {
        const stream = ensureStream(chatId);
        stream.approval = {
          approvalId: d.approvalId,
          senseName: d.senseName,
          args: d.arguments,
          waitTime: d.waitTime ?? 0,
          createdAt: d.createdAt ?? Date.now(),
        };
      }
      return;
    }

    if (type === "accept" || type === "rejected") {
      // 审批已处理（用户 accept/reject 或超时/断连触发）→ 清 pending approval。
      // accept 的 result / rejected 的 reason 暂不累积进 history（实时流后续 content 会覆盖）。
      if (chatId) {
        const stream = streams.value[chatId];
        if (stream) stream.approval = undefined;
      }
      return;
    }

    if (type === "subagent_created") {
      const d = (n.data ?? {}) as {
        chatId?: string;
        parentChatId?: string;
        type?: string;
        prompt?: string;
        wait?: boolean;
        brain?: string;
        senseGroups?: string[];
      };
      if (!d.chatId || !d.parentChatId || !d.type || !d.prompt) {
        console.warn("[agents] subagent_created: notification 字段残缺", d);
        return;
      }
      const master = pets.value.find((p) => p.chatId === d.parentChatId);
      if (!master) {
        console.warn("[agents] subagent_created: 主 pet 未找到", d.parentChatId);
        return;
      }
      // 造子 pet（emoji face，落主附近）。后端已预创建 chat + runtime（brain/senseGroups 来自 config.subagents）
      // → 前端直接 chat.send 跑子 agent，不 chat.create（避 PRIMARY KEY 冲突）、不 runtime.set
      const bounds = defaultBounds();
      const usedFaces = new Set(pets.value.map((p) => p.face));
      const preset = generatePet("emoji", usedFaces);
      const pet = createPetInstance(preset, bounds, false, master.instanceId, {
        chatId: d.chatId,
        parentChatId: d.parentChatId,
        agentType: d.type,
      });
      // 登记 runtime 到子 pet（brain/senseGroups 来自 subagent_created notification）
      pet.runtime = {
        brain: d.brain ?? "",
        senseGroups: d.senseGroups ?? [],
        mcpServers: [],
      };
      const pos = findSpawnPosition({ x: master.x, y: master.y }, pets.value, bounds);
      pet.x = pos.x;
      pet.y = pos.y;
      pet.targetX = pos.x;
      pet.targetY = pos.y;
      pets.value.push(pet);
      // 同步到 allChatsCache（getHistory 用它找子 chat）
      allChatsCache.value.push({
        chatId: d.chatId,
        parentChatId: d.parentChatId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      // 登记 wait 状态（done 时按 wait 决策回传/注入）
      spawnWaits.set(d.chatId, { parentChatId: d.parentChatId, type: d.type, wait: !!d.wait });
      sendMessage(d.chatId, d.prompt).catch((e) =>
        console.error("[agents] 子 agent chat.send 失败:", e),
      );
      return;
    }

    if (type === "subagent_destroyed") {
      const d = (n.data ?? {}) as { chatId?: string };
      if (!d.chatId) {
        console.warn("[agents] subagent_destroyed: 缺 chatId", d);
        return;
      }
      const idx = pets.value.findIndex((p) => p.chatId === d.chatId);
      if (idx >= 0) pets.value.splice(idx, 1);
      spawnWaits.delete(d.chatId);
      delete streams.value[d.chatId];
      return;
    }

    // consumed / replaced / 其他：CP1 不处理
  }

  return {
    pets,
    activeDialogChatId,
    activeHistoryChatId,
    streams,
    historyListOpen,
    historyList,
    settingsOpen,
    initFromChats,
    rebuildSpawnWaits,
    createMasterPet,
    sendMessage,
    getHistory,
    abort,
    dismissApproval,
    hide,
    deleteSession,
    loadSession,
    fetchHistoryList,
    getRuntime,
    trackRequest,
    routeChunk,
    routeNotification,
  };
});
