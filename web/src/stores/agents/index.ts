import { defineStore } from "pinia";
import { ref } from "vue";
import { agentApi, type ChatSummary, type ChatSendAttachment, type RuntimeSelection, type SenseToolInfo, type SessionRuntimeSelection } from "@/services/agentApi";
import type { PetInstance, PetMood } from "@/features/pets/types";
import type {
  StreamState,
  HistoryItem,
} from "./types";
import { sameRuntime, defaultBounds } from "./streamAccumulator";
import { collectDescendantChatIds } from "./historyMerge";

// 模块 factories
import { createUiState } from "./uiState";
import { createApprovalActions } from "./approvalActions";
import { createPetLifecycle } from "./petLifecycle";
import { createStreamRouter, ensureStream as _ensureStream, trackRequest as _trackRequest } from "./streamRouter";

// re-export 公共契约类型（保 @/stores/agents 导入路径兼容：4 .vue + stores/index.ts 零改动）
export type { SenseCallRecord, HistoryItem, ApprovalState, StreamState, RunningTool } from "./types";

/**
 * agents store：agent/chat 状态层单一数据源。
 *
 * - pets: PetInstance[] —— chat.list + chunk/notification 驱动（CP1 由 initFromChats 重建）
 * - streams: Record<chatId, StreamState> —— chunk 按 requestId→chatId 路由累积
 * - activeDialogChatId / historyDrawerStack —— UI 焦点（CP2+ 弹窗/抽屉用；抽屉栈支持 spawn 多级下钻，逐层返回）
 *
 * routeChunk/routeNotification 由 App.vue 订阅 wsClient 回调注入。
 */
export const useAgentsStore = defineStore("agents", () => {
  // ── 核心数据状态 ──
  const pets = ref<PetInstance[]>([]);
  const streams = ref<Record<string, StreamState>>({});
  // 完整 chat 列表缓存（initFromChats 时拉取，getHistory 用它找子 chat，避免仅依赖 pets 的 top-5 限制）
  const allChatsCache = ref<ChatSummary[]>([]);
  // CP8 会话列表：historyList 缓存 chat.list(includePreview) 全量会话
  const historyList = ref<ChatSummary[]>([]);
  // 内置工具元信息（sense.tools，name→icon/label）+ sense 组解析（sense.list，group→senses）。
  // initFromChats 载入；供 RunningTools icon 查询 + 能力判定（pet senseGroups 含某工具，如 update_todo）。
  const senseTools = ref<SenseToolInfo[]>([]);
  const senseGroupsResolved = ref<{ name: string; senses: string[] }[]>([]);

  // requestId → chatId 映射（流式 RPC 调用前由 trackRequest 注册，chunk/notification 路由用）
  const requestMap = new Map<string, string>();
  let initialized = false;

  // ── UI 状态（独立模块） ──
  const ui = createUiState();

  // ── 基础函数 ──

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
   * 移除 pets + streams + active 焦点（hide/deleteSession 共用，CP8）。
   * runtime 挂 pet → pet splice 后 runtime 随之消失（不再单独保留；loadSession 重建 pet 时 AgentDialog 退 default 预选）。
   */
  function removePetsByIds(removeIds: string[]): void {
    for (const id of removeIds) {
      const idx = pets.value.findIndex((p) => p.chatId === id);
      if (idx >= 0) pets.value.splice(idx, 1);
      delete streams.value[id];
    }
    if (ui.activeDialogChatId.value && removeIds.includes(ui.activeDialogChatId.value)) {
      ui.activeDialogChatId.value = null;
    }
    // 抽屉栈：移除所有被删 chat（深层下钻中被删 chat 的层一并清理）
    ui.pruneHistoryStack(removeIds);
  }

  // ── 模块初始化（按依赖顺序） ──

  const approval = createApprovalActions(streams, pets);

  const lifecycle = createPetLifecycle(
    pets, streams, historyList, ui.historyListOpen,
    getRuntime, setWorking, removePetsByIds,
  );

  // ── 流式 RPC 编排（sendMessage/resumeAgent 用 standalone ensureStream/trackRequest） ──

  /**
   * 发消息（AgentDialog 调用）。runtime diff 决策：
   *   - runtime 提供 + 与当前不同 → agentApi.setRuntime 再 sendMessage
   *   - runtime 与当前同 / 未提供 → 直接 sendMessage
   *   - 首次（chat 刚由 FAB 创建）→ runtime 已是 default，直接 sendMessage
   * 发送后重置 stream 累积 + pet 进 isWorking（chatting action）。
   * 错误显式抛出（规则 12），调用方 try/catch 显示错误态。
   * 参数顺序：attachments 前置（与 agentApi.sendMessage 对齐，常用参数先），runtime 后置（差异场景才用）。
   */
  async function sendMessage(
    chatId: string,
    text: string,
    attachments?: ChatSendAttachment[],
    runtime?: RuntimeSelection,
  ): Promise<void> {
    if (runtime) {
      const pet = pets.value.find((p) => p.chatId === chatId);
      const cur = pet?.runtime;
      if (!cur || !sameRuntime(cur, runtime)) {
        await agentApi.setRuntime(chatId, runtime);
        if (pet) {
          pet.runtime = {
            brain: runtime.brain,
            senseGroup: runtime.senseGroup,
            mcpServers: [...(runtime.mcpServers ?? [])],
          };
        }
      }
    }
    const { requestId, done } = agentApi.sendMessage(chatId, text, attachments);
    _trackRequest(requestMap, requestId, chatId);
    const pet = pets.value.find((p) => p.chatId === chatId);
    setWorking(pet, true);
    const stream = _ensureStream(streams, chatId);
    // 新一轮发送：重置实时累积。当前 pending 审批不丢失 → 移到 queue 保留（用户可从 PetIcons 重新唤起）。
    // history 不动——历史由 getHistory 显式载入；实时消息完成不自动入 history（后端 chat.get 才是历史源）。
    stream.thinking = "";
    stream.content = "";
    stream.isWorking = true;
    if (stream.approval) {
      stream.approvalQueue.push(stream.approval);
      stream.approval = undefined;
    }
    stream.retainUntil = undefined;
    // P3：清旧 error（新轮起，错误状态不残留）
    stream.error = undefined;
    // P3：捕获 final Response 终态。success:false（后端 P2 修复产 failureResponse）→ stream.error。
    // done Promise 在流结束时 resolve；catch 仅网络中断（ws 断）才触发。
    done.then((res) => {
      if (!res.success) {
        stream.error = res.error?.message ?? "未知错误";
        console.error("[agents] sendMessage response failed:", res.error);
      }
    }).catch((e) => {
      stream.error = `连接中断: ${(e as Error).message}`;
      console.error("[agents] sendMessage done rejected:", e);
    });
  }

  /**
   * 续跑 chat（chat.resume，无 prompt）。T9 wait=true 唤醒轮：后端注入角色回复 + 推 role_reply
   * → 本方法 resume 主处理注入消息（loop 见末条 role:role 或旧 subagent → LLM 响应）。也用于重连续跑 interrupted wait-子。
   * 复用 sendMessage 的 trackRequest/setWorking/ensureStream 机制（run("") 起流）。
   */
  async function resumeAgent(chatId: string): Promise<void> {
    const { requestId, done } = agentApi.resumeChat(chatId);
    _trackRequest(requestMap, requestId, chatId);
    const pet = pets.value.find((p) => p.chatId === chatId);
    setWorking(pet, true);
    const stream = _ensureStream(streams, chatId);
    stream.thinking = "";
    stream.content = "";
    stream.isWorking = true;
    // resume 同 sendMessage：当前审批不丢失 → 移到 queue 保留
    if (stream.approval) {
      stream.approvalQueue.push(stream.approval);
      stream.approval = undefined;
    }
    stream.retainUntil = undefined;
    // P3：清旧 error + 捕获 resume 终态（与 sendMessage 同步）
    stream.error = undefined;
    done.then((res) => {
      if (!res.success) {
        stream.error = res.error?.message ?? "未知错误";
        console.error("[agents] resumeChat response failed:", res.error);
      }
    }).catch((e) => {
      stream.error = `连接中断: ${(e as Error).message}`;
      console.error("[agents] resumeChat done rejected:", e);
    });
  }

  const router = createStreamRouter(
    streams, pets, requestMap, setWorking, approval.dismissApproval,
    sendMessage, resumeAgent, lifecycle.pickGhostFace, allChatsCache,
  );

  // ── 剩余编排函数 ──

  /**
   * 载入内置工具元信息（sense.tools）+ sense 组解析（sense.list）。
   * initFromChats 调一次；供 RunningTools icon 查询 + 能力判定（pet senseGroups 含某工具）。
   * 失败不阻塞（容错降级 → icon fallback ⚙ / 能力判定 false，规则12 warn）。
   */
  async function loadSenseMeta(): Promise<void> {
    const [tools, groups] = await Promise.all([
      agentApi.listSenseTools(),
      agentApi.listSenseGroups(),
    ]);
    senseTools.value = tools;
    senseGroupsResolved.value = groups;
  }

  /** 工具名→icon（senseTools 缓存）；未命中 fallback ⚙。RunningTools 渲染用。 */
  function iconForTool(name: string): string {
    return senseTools.value.find((t) => t.name === name)?.icon ?? "⚙";
  }

  /**
   * 能力判定：senseGroup（组名）经 sense.list 解析为 sense 名集合后，是否含 senseName（如 "update_todo"）。
   * 组未解析到（loadSenseMeta 未完成/失败）→ false（降级，不显侧栏）。
   */
  function senseGroupsHasSense(senseGroup: string | undefined, senseName: string): boolean {
    if (!senseGroup) return false;
    const senses = senseGroupsResolved.value.find((r) => r.name === senseGroup)?.senses;
    return !!senses?.includes(senseName);
  }

  /** 连接成功后拉 chat.list → 重建 pet 树。幂等（initialized 守卫），失败可重试。 */
  async function initFromChats(): Promise<void> {
    if (initialized) return;
    // listChats 失败 → initialized 不置位，下次 status=connected 时可重试
    const chats = await agentApi.listChats();
    initialized = true;

    // 载入工具元信息 + 组解析（icon 查询 + 能力判定用）；失败不阻塞（容错降级）
    loadSenseMeta().catch((e) => console.warn("[agents] loadSenseMeta 失败:", e));

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
      lifecycle.buildMasterAndChildren(m, chats, bounds, usedFaces);
    }

    // 重连后重建 wait 唤醒态 + 检测主卡死（容错机制，见 docs/agent-pet.md §5.8）
    await rebuildSpawnWaits(chats);

    // 初始载入 contextUsage（ContextBar 渲染用）。
    // initFromChats 仅用 chat.list（不含 contextUsage），需单独拉；done/chat.get 是后续实时路径。
    // 拉全部主 chat（非仅 top 5），确保所有可见 pet 的 ContextBar 初始渲染正确。
    // 失败不阻塞初始化（静默降级：bar 留 0 等下次 done 刷新）。
    Promise.all(
      mains.map((m) =>
        agentApi.contextUsage(m.chatId).then(
          (res) => {
            const pet = pets.value.find((p) => p.chatId === m.chatId);
            if (pet) {
              if (typeof res.contextUsage === "number") pet.contextUsage = res.contextUsage;
              if (typeof res.contextUsed === "number") pet.contextUsed = res.contextUsed;
              if (typeof res.contextTotal === "number") pet.contextTotal = res.contextTotal;
            }
          },
          (e) => console.warn(`[agents] contextUsage(${m.chatId}) 失败:`, e),
        ),
      ),
    ).catch(() => {});
  }

  /**
   * 重连后重建 wait=true 唤醒态 + 检测主卡死（T9.10 重构）。
   *
   * 扫描 chat.list（需 wait 字段）：
   * - wait-子（parentChatId 非空 + wait=true）：
   *   - !finished（interrupted，turn 被 restart 中断）→ resumeAgent(child) 续跑；完成 → 后端 child_done → wakeParent → role_reply → resumeAgent(parent)
   *   - finished（子已完成，后端 rebuildWaitedChildren 已注入回复；前端离线则 role_reply 丢）→ resumeAgent(parent) 处理注入回复
   * - 主 chat running=true 且 finished=false 但前端无跟踪流 → 判卡死，abort 清死锁
   *
   * 后端 rebuildWaitedChildren（service 启动期）已重建 waitedChildren 内存链 + 补唤 finished 子；
   * 本函数负责前端侧续跑 interrupted 子 + resume 含未处理 role-reply 的主。
   * 由 initFromChats（F5）或 App.vue onStatus（瞬断重连）调用。
   */
  async function rebuildSpawnWaits(chats?: ChatSummary[]): Promise<void> {
    const allChats = chats ?? (await agentApi.listChats());
    const resumedParents = new Set<string>();

    // 主 chat resumePending / canResume：由 buildMasterAndChildren 同步到 pet.canResume，
    // PetToolbar "继续"按钮让用户确认，本处不自动 resume（避免未确认即执行）。

    for (const chat of allChats) {
      // wait-子恢复（T9.10）— 基础设施级：子被中断需续跑以完成唤主链，非用户决策
      if (chat.parentChatId && chat.wait) {
        if (!chat.finished) {
          // interrupted：续跑子（完成唤主由后端链 + role_reply 驱动）
          resumeAgent(chat.chatId).catch((e) =>
            console.warn(`[agents] rebuildSpawnWaits: 续跑 wait-子失败 ${chat.chatId}`, e),
          );
          console.log(`[agents] rebuildSpawnWaits: 续跑 interrupted wait-子 ${chat.chatId}`);
        } else if (!resumedParents.has(chat.parentChatId)) {
          // finished：主含未处理 role-reply → resume 主跑唤醒轮（子完成但主离线时注入的回复待消费）
          // 注：此为 wait-子完成链式唤主，非用户决策场景（用户未主动中断主）
          resumeAgent(chat.parentChatId).catch((e) =>
            console.warn(`[agents] rebuildSpawnWaits: resume 主失败 ${chat.parentChatId}`, e),
          );
          console.log(`[agents] rebuildSpawnWaits: resume 主 ${chat.parentChatId}（子 ${chat.chatId} 已完成）`);
        }
        continue;
      }

      // 主 chat 卡死检测（running=true && !finished 但前端无跟踪流）
      if (!chat.parentChatId && chat.running && !chat.finished) {
        if (ui.activeDialogChatId.value !== chat.chatId) {
          console.warn(`[agents] rebuildSpawnWaits: 主 chat 可能卡死 ${chat.chatId}, abort`);
          agentApi.abortAgent(chat.chatId).catch((err) =>
            console.warn(`[agents] rebuildSpawnWaits: abort 失败 ${chat.chatId}`, err),
          );
        }
      }

      // 主 chat idle 但可恢复（末条 role/user/sense/subagent）：canResume 已由 buildMasterAndChildren 同步到 pet，
      // 由 PetToolbar "继续"按钮让用户确认。本处不自动 resume（避免未确认即执行）。
    }
  }

  /**
   * 载入历史（HistoryDrawer 打开时调）。staged chunks 经 routeChunk 累积到 stream.history；
   * loaded notification 标 historyLoaded=true。不 setWorking（历史载入非工作态）。
   * 主 chat 载入全部后代历史并按时间合流；子 chat 自身抽屉只显示本 chat 的 direct 历史。
   */
  async function getHistory(chatId: string): Promise<void> {
    // 先刷新 allChatsCache（确保包含最新创建的后代 agent，避免子 spawn 孙后主 cache 缺孙的信息）
    try {
      const chats = await agentApi.listChats();
      allChatsCache.value = chats;
    } catch (e) {
      console.warn("[agents] getHistory: 刷新 allChatsCache 失败，使用缓存", e);
    }

    const { requestId, done } = agentApi.getHistory(chatId);
    router.trackRequest(requestId, chatId);
    // ensureStream 已就绪累积；reset history 防止重复载入累积两份
    const stream = router.ensureStream(chatId);
    stream.history = [];
    stream.historyLoaded = false;
    // CP7: chat.get response 携带 contextUsage → 更新 pet.contextUsage（历史载入一次性同步，ContextBar 消费）
    done
      .then((res) => {
        const d = res.data as { contextUsage?: number; contextUsed?: number; contextTotal?: number } | undefined;
        const pet = pets.value.find((p) => p.chatId === chatId);
        if (pet && d) {
          if (typeof d.contextUsage === "number") pet.contextUsage = d.contextUsage;
          if (typeof d.contextUsed === "number") pet.contextUsed = d.contextUsed;
          if (typeof d.contextTotal === "number") pet.contextTotal = d.contextTotal;
        }
      })
      .catch((e) => console.error("[agents] getHistory response 失败:", e));

    // 主 chat 同时获取全部后代历史并合并（群聊样式）。子 chat direct 视图不混入后代。
    try {
      const openedSummary = allChatsCache.value.find((c) => c.chatId === chatId);
      const openedIsSubChat = !!openedSummary?.parentChatId;
      const descendantIds = openedIsSubChat
        ? []
        : collectDescendantChatIds(allChatsCache.value, chatId);
      const childChatSummaries = descendantIds
        .map((id) => allChatsCache.value.find((c) => c.chatId === id))
        .filter((chat): chat is ChatSummary => !!chat);

      // 并行获取所有子 chat 的历史
      const childHistoryPromises = childChatSummaries.map(async (childSummary) => {
        const childChatId = childSummary.chatId;

        console.log("[agents] getHistory: 加载子 chat 历史", { childChatId });

        const { requestId: childRequestId, done: childDone } = agentApi.getHistory(childChatId);
        router.trackRequest(childRequestId, childChatId);  // 注册 requestId 供 routeChunk 路由
        const childStream = router.ensureStream(childChatId);
        childStream.history = [];

        // 等待子 chat 历史加载完成
        await childDone;

        // 子 chat 历史角色重映射 + 关联子 pet chatId（remapChildHistory：
        //   assistant → role（子 pet 回复）；user → master（主 pet 发给子 pet 的 prompt 注入））
        // 多级 spawn 使用实际父 chatId，供头像徽章定位。
        return lifecycle.remapChildHistory(
          childStream.history,
          childChatId,
          childSummary.parentChatId ?? chatId,
        );
      });

      // 等待主 chat 和所有子 chat 历史加载完成
      await done;
      const childHistories = await Promise.all(childHistoryPromises);

      // 重置 historyLoaded（loaded notification 可能已设 true，但子 chat 还没合并）
      stream.historyLoaded = false;

      // opened chat 自身为子 chat（ghost 自身抽屉）→ 自身历史也走 remapChildHistory
      // （使首条 spawn prompt 显为 master 而非 user；主 chat 自身历史保持 user/assistant）
      // multi-level：opened 是某个上层 sub 的子 → parentChatId 来自 allChatsCache，否则 fallback 当前 chatId。
      const openedParentChatId = openedSummary?.parentChatId ?? chatId;
      const ownHistory = openedIsSubChat ? lifecycle.remapChildHistory(stream.history, chatId, openedParentChatId) : stream.history;

      // 合并所有历史（主 chat + 子 chat）
      const allHistory = [
        ...ownHistory,
        ...childHistories.flat(),
      ];

      // 按 msgId 去重；旧历史无 msgId 时不能将所有 undefined 当成同一消息。
      const seenMsgIds = new Set<string>();
      const deduped: HistoryItem[] = [];
      for (const item of allHistory) {
        if (item.msgId) {
          if (seenMsgIds.has(item.msgId)) continue;
          seenMsgIds.add(item.msgId);
        }
        deduped.push(item);
      }

      // 按 createdAt 排序（实现群聊样式的时间线）
      deduped.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      allHistory.length = 0;
      allHistory.push(...deduped);

      // 通过 streams.value[chatId] 赋值（而非 stream 变量），确保 Vue 响应式系统检测到变化
      streams.value[chatId] = {
        ...stream,
        history: allHistory,
        historyLoaded: true,
      };
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

  /** 应用当前会话临时角色编制。只更新内存/服务端运行时，绝不调用持久化 runtime.set。 */
  async function setSessionRuntime(chatId: string, selection: SessionRuntimeSelection): Promise<void> {
    await agentApi.setSessionRuntime(chatId, selection);
    const pet = pets.value.find((p) => p.chatId === chatId);
    if (pet) pet.runtime = { ...selection.primary, mcpServers: [...(selection.primary.mcpServers ?? [])] };
  }

  /** 拉取全量会话列表（includePreview=true）缓存到 historyList。CP8：会话列表打开时调。 */
  async function fetchHistoryList(): Promise<void> {
    historyList.value = await agentApi.listChats(true);
  }

  return {
    pets,
    ...ui,
    streams,
    historyList,
    senseTools,
    senseGroupsResolved,
    loadSenseMeta,
    iconForTool,
    senseGroupsHasSense,
    initFromChats,
    rebuildSpawnWaits,
    ...lifecycle,
    sendMessage,
    resumeAgent,
    getHistory,
    abort,
    ...approval,
    fetchHistoryList,
    getRuntime,
    setSessionRuntime,
    ...router,
  };
});
