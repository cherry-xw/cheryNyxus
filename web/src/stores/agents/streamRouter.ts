import type { Ref } from "vue";
import { generatePet } from "@/features/pets/petPresets";
import { findSpawnPosition } from "@/features/pets/petMovement";
import { createPetInstance } from "@/features/pets/usePetWorld";
import type { PetInstance } from "@/features/pets/types";
import type { ChatSummary, ChatSendAttachment, RuntimeSelection } from "@/services/agentApi";
import type {
  StreamState,
  StreamChunkData,
  StagedChunkData,
  ChunkMessage,
  NotificationMessage,
  ApprovalState,
} from "./types";
import { accumulateStaged } from "./streamAccumulator";
import { defaultBounds } from "./streamAccumulator";

/**
 * 确保 chatId 对应的 StreamState 存在。不存在则创建默认结构。
 * 兼容历史 StreamState（已存在但无 approvalQueue / historyDirty 字段）→ 补初始化。
 */
export function ensureStream(
  streams: Ref<Record<string, StreamState>>,
  chatId: string,
): StreamState {
  let s = streams.value[chatId];
  if (!s) {
    s = {
      thinking: "",
      content: "",
      isWorking: true,
      history: [],
      historyLoaded: false,
      historyDirty: true, // 默认 dirty；首次 loaded notification 或显式预加载后清
      runningTools: [],
      approvalQueue: [],
    };
    streams.value[chatId] = s;
  }
  // 兼容历史 StreamState（已存在但缺新字段）
  if (!s.approvalQueue) s.approvalQueue = [];
  if (s.historyDirty === undefined) s.historyDirty = true;
  return s;
}

/**
 * 注册 requestId→chatId（流式 RPC 调用后立即调用，先于 response/ chunks）。
 * 供 routeChunk/routeNotification 路由用。
 */
export function trackRequest(
  requestMap: Map<string, string>,
  requestId: string,
  chatId: string,
): void {
  if (requestId) requestMap.set(requestId, chatId);
}

export function createStreamRouter(
  streams: Ref<Record<string, StreamState>>,
  pets: Ref<PetInstance[]>,
  requestMap: Map<string, string>,
  setWorking: (pet: PetInstance | undefined, working: boolean, freezeUntil?: number) => void,
  dismissApproval: (chatId: string) => void,
  // 跨模块依赖（打破循环：sendMessage/resumeAgent 在 index.ts 定义，用 standalone ensureStream/trackRequest）
  sendMessage: (chatId: string, text: string, attachments?: ChatSendAttachment[], runtime?: RuntimeSelection) => Promise<void>,
  resumeAgent: (chatId: string) => Promise<void>,
  pickGhostFace: (tribe: string, pets: readonly PetInstance[], selfId?: string) => string,
  allChatsCache: Ref<ChatSummary[]>,
) {
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

    const stream = ensureStream(streams, chatId);

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
   * role_created/destroyed：子 pet 生命周期（CP3）。
   */
  function routeNotification(notif: unknown): void {
    const n = notif as NotificationMessage | null;
    if (!n || !n.type) return;
    const requestId = n.requestId;
    const chatId = requestId ? requestMap.get(requestId) : undefined;
    const type = n.type;

    if (type === "done" || type === "error") {
      if (chatId) {
        // T9：wait=true 唤醒由后端注入（role_reply）+ 前端 chat.resume 续跑；wait=false 纯 fire-and-forget。
        // 子 done 不再触发前端回传/注入（spawnWaits 已废）。仅清工作态（下方）。
        const stream = streams.value[chatId];
        if (stream) {
          stream.isWorking = false;
          // loop 结束：清运行中工具（防残留；正常应由 accept 逐个移除，兜底全清）
          stream.runningTools = [];
          // done 后 content/thinking 气泡保留 20s（下一条消息前）；error 不保留（即时隐藏）
          if (type === "done") stream.retainUntil = Date.now() + 20000;
          // 本轮末条 assistant 权威回复 → 实时追加进 history（按 msgId 去重），
          // 使 PetIcons 圆点气泡即时显最新内容，不再等 chat.get 重载。
          if (type === "done") {
            const fm = (n.data as { finalMessage?: { msgId: string; role: "assistant"; content: string; thinking?: string; createdAt: number; agentChatId?: string } } | undefined)?.finalMessage;
            if (fm && !stream.history.some((h) => h.msgId && h.msgId === fm.msgId)) {
              stream.history.push({
                role: fm.role,
                content: fm.content,
                ...(fm.thinking ? { thinking: fm.thinking } : {}),
                createdAt: fm.createdAt,
                msgId: fm.msgId,
                // 反向溯源：该消息由当前 chat 生成（agentChatId = chatId）
                agentChatId: fm.agentChatId ?? chatId,
              });
            }
          }
        }
        const pet = pets.value.find((p) => p.chatId === chatId);
        // Req 7: done 后保留期内 pet 冻结不移动（freezeUntil=retainUntil）；error 立即恢复
        setWorking(pet, false, type === "done" ? stream?.retainUntil : undefined);
        // CP7: done notification 携带 contextUsage（token/brain.contextLimit）→ 更新 pet.contextUsage（ContextBar 消费）
        // 子 agent done（finished=true）→ 转 ghost（灵魂态保留），pick 灵魂 emoji 按 tribe 序号取（selfId 排除已置 isGhost 的自身）
        if (type === "done" && pet) {
          const d = (n.data ?? {}) as { contextUsage?: number; used?: number; total?: number; finished?: boolean };
          if (typeof d.contextUsage === "number") pet.contextUsage = d.contextUsage;
          if (typeof d.used === "number") pet.contextUsed = d.used;
          if (typeof d.total === "number") pet.contextTotal = d.total;
          // done 表示 loop 正常结束 → 末条为 assistant → canResume 失效
          pet.canResume = false;
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
      // CP2 → P3：错误时填 stream.error（UI 显 error-bubble），保留 console.error 供调试
      if (type === "error" && chatId) {
        const stream = streams.value[chatId];
        const errMsg = (n.data as { message?: string } | undefined)?.message ?? `流式错误 (requestId=${requestId})`;
        if (stream) {
          stream.error = errMsg;
          // error 不保留气泡（即时隐藏 content/thinking）；30s 后清 stream.error（error-bubble 自动消失）
          stream.retainUntil = Date.now() + 30000;
        }
        console.error("[agents] stream error:", errMsg);
      }
      return;
    }

    if (type === "loaded") {
      // chat.get staged 全部 emit 完 → 标记历史载入完成（HistoryDrawer 据此显骨架→内容）
      // dirty 清：缓存可用，下次 drawer 打开零 RPC
      if (chatId) {
        const stream = streams.value[chatId];
        if (stream) {
          stream.historyLoaded = true;
          stream.historyDirty = false;
        }
      }
      if (requestId) requestMap.delete(requestId);
      return;
    }

    if (type === "interrupt") {
      // 感官审批请求（streamMapper sense_end → interrupt，仅 confirm/manual 推送；auto sense 不推）。
      // 后端 InterruptNotificationData: {approvalId, senseName, arguments, supervisionLevel, needsApproval, waitTime, createdAt}
      // 多审批堆叠：当前 approval 已存在 → 新审批入队（不覆盖，用户可依次处理）
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
        const stream = ensureStream(streams, chatId);
        const newApproval: ApprovalState = {
          approvalId: d.approvalId,
          senseName: d.senseName,
          args: d.arguments,
          waitTime: d.waitTime ?? 0,
          createdAt: d.createdAt ?? Date.now(),
        };
        if (stream.approval) {
          stream.approvalQueue.push(newApproval);
          console.log("[agents] interrupt: 当前 approval 已在气泡展示，新审批入队", {
            chatId,
            queued: newApproval.approvalId,
            queueLen: stream.approvalQueue.length,
          });
        } else {
          stream.approval = newApproval;
        }
      }
      return;
    }

    if (type === "sense_started") {
      // auto 工具开始执行（streamMapper sense_end auto 分支）。维护「运行中工具」列表，pet bar 显 icon。
      // id=sense 调用 id，accept（approvalId=id）到达时移除。
      const d = (n.data ?? {}) as { id?: string; senseName?: string };
      if (!d.id || !d.senseName) {
        console.warn("[agents] sense_started: 字段残缺", d);
        return;
      }
      if (chatId) {
        const stream = ensureStream(streams, chatId);
        if (!stream.runningTools.some((t) => t.id === d.id)) {
          stream.runningTools.push({ id: d.id, name: d.senseName });
        }
      }
      return;
    }

    if (type === "accept" || type === "rejected") {
      // 审批已处理（用户 accept/reject 或超时/断连触发）→ 从 approval 或 approvalQueue 按 id 移除；当前 approval 清空时自动从 queue head pop 下一个。
      // accept（approvalId=sense id）→ 移除运行中工具同 id 项；rejected 同（confirm/manual 工具未入 running 栈，filter 幂等）。
      // accept 的 result / rejected 的 reason 暂不累积进 history（实时流后续 content 会覆盖）。
      if (chatId) {
        const stream = streams.value[chatId];
        if (stream) {
          const approvalId = (n.data ?? {}) as { approvalId?: string };
          const id = approvalId.approvalId;
          // 1) 从当前 approval 移除（若匹配）
          if (stream.approval && id && stream.approval.approvalId === id) {
            stream.approval = undefined;
            // 同步移除 runningTools 同 id 项
            stream.runningTools = stream.runningTools.filter((t) => t.id !== id);
          } else if (stream.approval && !id) {
            // 没有 id 字段（旧协议兼容）→ 仍按当前 approval 处理
            stream.approval = undefined;
          } else if (id) {
            // 当前 approval 不匹配 → 仅清理 runningTools（避免 accept 残留）
            stream.runningTools = stream.runningTools.filter((t) => t.id !== id);
          }
          // 2) 从 queue 中移除匹配项（任意匹配都清，防止残留）
          if (id) {
            stream.approvalQueue = stream.approvalQueue.filter((a) => a.approvalId !== id);
          }
          // 3) 若当前 approval 清空且 queue 非空 → 自动 pop 下一个进 approval
          if (!stream.approval && stream.approvalQueue.length > 0) {
            const next = stream.approvalQueue.shift();
            if (next) stream.approval = next;
          }
        }
      }
      return;
    }

    if (type === "role_created") {
      const d = (n.data ?? {}) as {
        chatId?: string;
        parentChatId?: string;
        type?: string;
        prompt?: string;
        wait?: boolean;
        brain?: string;
        senseGroup?: string;
      };
      if (!d.chatId || !d.parentChatId || !d.type || !d.prompt) {
        console.warn("[agents] role_created: notification 字段残缺", d);
        return;
      }
      const master = pets.value.find((p) => p.chatId === d.parentChatId);
      if (!master) {
        console.warn("[agents] role_created: 主 pet 未找到", d.parentChatId);
        return;
      }
      // 造子 pet（emoji face，落主附近）。后端已预创建 chat + runtime（brain/senseGroups 来自 config.roles）
      // → 前端直接 chat.send 跑子 agent，不 chat.create（避 PRIMARY KEY 冲突）、不 runtime.set
      const bounds = defaultBounds();
      const usedFaces = new Set(pets.value.map((p) => p.face));
      const preset = generatePet("emoji", usedFaces);
      const pet = createPetInstance(preset, bounds, false, master.instanceId, {
        chatId: d.chatId,
        parentChatId: d.parentChatId,
        agentType: d.type,
      });
      // 登记 runtime 到子 pet（brain/senseGroup 来自 role_created notification）
      pet.runtime = {
        brain: d.brain ?? "",
        senseGroup: d.senseGroup ?? "",
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
      // 主动预加载新子 chat 的历史（drawer 打开零 RPC 命中缓存；rebuild spawn 期间用户点子 drawer 也即时显）
      // 子 chat 默认 dirty=true，预加载完 loaded notification 清 dirty
      getHistory(d.chatId).catch((e) =>
        console.warn(`[agents] role_created 预加载子 chat 失败 ${d.chatId}:`, e),
      );
      // T9：wait 唤醒由后端管（role_reply）；前端两态均 chat.send 跑子
      sendMessage(d.chatId, d.prompt).catch((e) =>
        console.error("[agents] 子 agent chat.send 失败:", e),
      );
      return;
    }

    if (type === "role_destroyed") {
      const d = (n.data ?? {}) as { chatId?: string };
      if (!d.chatId) {
        console.warn("[agents] role_destroyed: 缺 chatId", d);
        return;
      }
      const idx = pets.value.findIndex((p) => p.chatId === d.chatId);
      if (idx >= 0) pets.value.splice(idx, 1);
      delete streams.value[d.chatId];
      return;
    }

    if (type === "role_reply") {
      // T9 wait=true 唤醒：后端已注入角色回复到主 chat DB + 推本通知 → 前端即时展示 + resume 主跑唤醒轮
      const d = (n.data ?? {}) as { parentChatId: string; childChatId: string; type: string; content: string; spawnSenseCallId?: string; msgId: string };
      if (!d.parentChatId) {
        console.warn("[agents] role_reply: 缺 parentChatId", d);
        return;
      }
      // 即时展示子回复（权威内容已注入主 chat DB，getHistory 也可见；live 气泡先显子回复再显主响应）
      const stream = ensureStream(streams, d.parentChatId);
      // 子 agent 注入主 chat 的 role:role 行 → 主 chat dirty（下次 drawer 打开需 reload 走完整合流）
      stream.historyDirty = true;
      // 实时 push 前先按 msgId 去重（避免 role_reply 与重载后的同 msgId 重复）
      if (!stream.history.some((h) => h.msgId && h.msgId === d.msgId)) {
        stream.history.push({
          role: "role",
          content: d.content ?? "",
          petName: d.type,
          createdAt: Date.now(),
          spawnSenseCallId: d.spawnSenseCallId,
          // 实时阶段尚未重新拉取子 chat 历史；通知已有的 childChatId 仅用于定位头像，
          // 直接按"子→父"展示，历史重载后再由纯前端合并规则重建。
          subPetChatId: d.childChatId,
          callerSubPetChatId: d.parentChatId,
          mergedView: "child-to-master",
          msgId: d.msgId,
          // 反向溯源：该消息由子 chat 生成（agentChatId = childChatId）
          agentChatId: d.childChatId,
        });
      }
      resumeAgent(d.parentChatId).catch((e) =>
        console.error("[agents] role_reply resume 主失败:", e),
      );
      return;
    }

    // consumed / replaced / 其他：CP1 不处理
  }

  return {
    ensureStream: (chatId: string) => ensureStream(streams, chatId),
    routeChunk,
    routeNotification,
    trackRequest: (requestId: string, chatId: string) => trackRequest(requestMap, requestId, chatId),
  };
}
