/**
 * 状态管理：单一 store + EventTarget 发布订阅。
 *
 * 数据真理源：blocks（渲染单元）/ approvals（审批 tab）/ log（原始帧）/ connection / 配置。
 * ingestChunk / ingestNotification 按 mode（live | replay）驱动流式状态机。
 *
 * 不碰 ws/rpc（传输由 actions 编排）。每次变更 emit() 通知 view，view 自行 diff patch。
 */

// ========== state ==========
function initialState() {
  return {
    connection: { status: "disconnected", wsUrl: "ws://localhost:8080", error: null },
    brains: [],          // [{name, provider, model, thinking?}]
    senseGroups: [],     // [{name, senses:["read_file","execute_command:auto"]}]
    selection: { brain: null, senseGroups: [] },
    chats: [],           // [{chatId, createdAt, updatedAt, messageCount}]
    currentChatId: null,
    currentChatLoaded: false, // 当前 chat 历史是否已载入（createChat/loadHistory 置 true；selectChat 重置）
    currentChatSent: false,   // 当前 chat 本会话是否已发过消息（修正 NEW 复用判定：messageCount 客户端不随 send 刷新）
    currentChatCanResume: false,
    blocks: [],          // 渲染单元（见 _newAssistant）
    activeStreams: new Map(), // rid → { block }
    approvals: [],       // 审批 tab
    log: [],             // 原始帧日志
    ui: { approvalActiveTab: null },
  };
}

let state = initialState();
const target = new EventTarget();
let replayAssistant = null; // replay 模式当前待填的 assistant block
// replay 时 content_end(role:sense) 可能先于 sense_end 到达，缓存 id→result 兜底乱序
const pendingSenseResults = new Map();
// replay 当前 cycle thinking 快照：thinking_end 置位，sense_end/content_end 消费；多 sense 复用同一值
let replayCycleThink = "";

function emit() { target.dispatchEvent(new CustomEvent("change")); }

// ========== block 工厂 ==========
function _newAssistant(rid) {
  return {
    id: crypto.randomUUID(), kind: "assistant", rid,
    thinking: { text: "", done: false },
    content: { text: "", done: false },
    senseCalls: [],
    finished: false, revoked: false,
  };
}
function _newBlock(kind, rid, extra = {}) {
  return { id: crypto.randomUUID(), kind, rid, finished: true, revoked: false, ...extra };
}

// ========== live 流 ==========
function getOrCreateLiveStream(rid) {
  let stream = state.activeStreams.get(rid);
  if (!stream) {
    const block = _newAssistant(rid);
    state.blocks.push(block);
    // pendingThink：当前 cycle thinking 缓冲，由 thinking_end 置位，sense_end/content_end 消费
    // 区分 sense 样式（thinking_end 后接 sense_end → 进 sense block）vs content 样式（接 content_end → 顶部 THINK）
    stream = { block, streamingByIndex: new Map(), pendingThink: "" };
    state.activeStreams.set(rid, stream);
  }
  return stream;
}

function applyStreamDelta(block, data, streamingByIndex) {
  if (data.thinking) {
    block.thinking.text += data.thinking;
    block.thinking.done = false; // 新 cycle 流式 → 重开顶部 THINK（sense_end 清空后下一轮重显）
  }
  if (data.content) block.content.text += data.content;
  if (Array.isArray(data.senseCall)) {
    for (const d of data.senseCall) {
      const idx = d.index ?? 0;
      if (d.name) {
        // 带 name = 新 call 起始（OpenAI 首 fragment 带 id+name / Ollama 完整 call）：
        // 靠 callId 跨周期唯一匹配并追加（不覆盖）；登记为本周期 idx 活跃 sc，供无 name 的 args fragment 累积。
        // 废弃原按 d.index 下标定位：跨 loop 周期 LLM 的 index 从 0 重置，会覆盖前周期已完成 sc 的 name/args。
        const callId = d.id;
        let sc = callId ? block.senseCalls.find((s) => s.callId === callId) : null;
        if (!sc) {
          sc = { name: "", arguments: "", status: "streaming" };
          block.senseCalls.push(sc);
        }
        sc.name = d.name;
        if (callId) sc.callId = callId;
        if (d.arguments) sc.arguments += d.arguments;
        streamingByIndex.set(idx, sc);
      } else if (d.arguments) {
        // 无 name 的 args 增量片段（OpenAI 后续 fragment）：累积到本周期 idx 活跃 sc
        const sc = streamingByIndex.get(idx);
        if (sc) sc.arguments += d.arguments;
      }
    }
  }
}

function applyLiveStaged(rid, data) {
  const stream = state.activeStreams.get(rid);
  if (data.type === "reverse") { handleReverse(rid, data.messageIds ?? []); return; }
  if (!stream) return;
  const block = stream.block;
  switch (data.type) {
    case "thinking_end":
      block.thinking.done = true;
      // authoritative 替换流式累积（"end 替换前面整个 think"），并缓冲供后续 sense_end/content_end 消费
      block.thinking.text = data.thinking ?? "";
      stream.pendingThink = data.thinking ?? "";
      break;
    case "content_end":
      block.content.done = true;
      if (!block.content.text && data.content) block.content.text = data.content;
      if (data.replace) block.content.replace = data.replace;
      // content 样式：顶部 THINK 保留本 cycle thinking（thinking_end 已置位，此处不改动）
      break;
    case "sense_end": {
      // stream delta 已建占位 sc（callId = LLM call id）；staged sense_end 与其同源 → 复用，不重复 push。
      // 后续 interrupt 置 approvalId、accept 带 result 均命中同一 sc，完成 streaming→pending→accepted 替换。
      const callId = data.id;
      let sc = callId ? block.senseCalls.find((s) => s.callId === callId) : null;
      if (!sc) sc = block.senseCalls.find((s) => s.name === data.senseName && !s.approvalId);
      if (!sc) { sc = { name: "", arguments: "", status: "streaming" }; block.senseCalls.push(sc); }
      if (data.senseName) sc.name = data.senseName;
      if (data.arguments) sc.arguments = data.arguments;
      if (callId) sc.callId = callId;
      // sense 样式：本 cycle thinking 关联进 sense block；清空顶部 transient（dedup：sense thinking 不进顶部）
      sc.thinking = stream.pendingThink;
      block.thinking.text = "";
      break;
    }
  }
}

// ========== replay（chat.get 历史回放）==========
function applyReplayStaged(data) {
  const rid = state.currentChatId;
  const role = data.role;
  switch (data.type) {
    case "thinking_end": {
      const b = _newAssistant(rid);
      b.thinking = { text: data.thinking ?? "", done: true };
      state.blocks.push(b);
      replayAssistant = b;
      replayCycleThink = data.thinking ?? ""; // 快照：sense_end 移走 thinking 时复用（多 sense）
      break;
    }
    case "content_end": {
      // role:sense 的 content 是 sense 执行结果：按 id 回填到对应 sense block
      if (role === "sense") {
        const id = data.id;
        const result = data.content ?? "";
        if (id) {
          const sb = state.blocks.find((b) => b.kind === "sense" && b.senseId === id);
          if (sb) sb.result = result;
          else pendingSenseResults.set(id, result);
        }
        break;
      }
      if (role === "user") {
        state.blocks.push(_newBlock("user", rid, { text: data.content ?? "" }));
        replayAssistant = null;
      } else if (role === "system") {
        state.blocks.push(_newBlock("system", rid, { text: data.content ?? "" }));
        replayAssistant = null;
      } else {
        let b = replayAssistant;
        if (!b || b.content.done) { b = _newAssistant(rid); state.blocks.push(b); }
        b.content = { text: data.content ?? "", done: true, replace: data.replace };
        replayAssistant = b;
      }
      break;
    }
    case "sense_end": {
      // 同一 sense 调用在历史中对应 assistant(senseCalls) + sense(result) 两条 message，
      // 各发一次 sense_end 且 id 相同（= trigger.id = LLM call id）→ 按 id 去重复用同一 sense block
      const id = data.id;
      if (id) {
        const exist = state.blocks.find((b) => b.kind === "sense" && b.senseId === id);
        if (exist) { replayAssistant = null; break; }
      }
      const result = id ? pendingSenseResults.get(id) : undefined;
      if (id && result !== undefined) pendingSenseResults.delete(id);
      // thinking carrier（thinking_end 建的无 content assistant 块）→ 删除空块，
      // thinking 移入 sense block（sense 样式）。replayCycleThink 供同 cycle 多 sense 复用。
      if (replayAssistant && !replayAssistant.content.done) {
        const idx = state.blocks.indexOf(replayAssistant);
        if (idx !== -1) state.blocks.splice(idx, 1);
      }
      state.blocks.push(_newBlock("sense", rid, {
        senseName: data.senseName ?? "",
        arguments: data.arguments ?? "",
        status: "accepted",
        senseId: id,
        result,
        thinking: replayCycleThink,
      }));
      replayAssistant = null;
      break;
    }
  }
}

// ========== notification ==========
function applyInterrupt(rid, data) {
  const stream = state.activeStreams.get(rid);
  if (stream) {
    let sc = stream.block.senseCalls.find((s) => s.callId === data.approvalId);
    if (!sc) { sc = { name: data.senseName, arguments: data.arguments ?? "", status: "streaming", callId: data.approvalId }; stream.block.senseCalls.push(sc); }
    sc.status = "pending"; sc.approvalId = data.approvalId; sc.level = data.supervisionLevel;
  }
  if (data.needsApproval && !state.approvals.some((a) => a.approvalId === data.approvalId)) {
    state.approvals.push({
      approvalId: data.approvalId, senseName: data.senseName, arguments: data.arguments ?? "",
      level: data.supervisionLevel, needsApproval: true, requestId: rid,
      status: "pending", reason: null, result: null, ts: Date.now(),
    });
    if (!state.ui.approvalActiveTab) state.ui.approvalActiveTab = data.approvalId;
  }
}

function applyAccept(rid, data) {
  const stream = state.activeStreams.get(rid);
  if (stream) {
    const sc = stream.block.senseCalls.find((s) => s.approvalId === data.approvalId);
    if (sc) { sc.status = "accepted"; sc.result = data.result; }
  }
  const ap = state.approvals.find((a) => a.approvalId === data.approvalId);
  if (ap) { ap.status = "accepted"; ap.result = data.result; }
}

function applyRejected(rid, data) {
  const stream = state.activeStreams.get(rid);
  if (stream) {
    const sc = stream.block.senseCalls.find((s) => s.approvalId === data.approvalId);
    if (sc) { sc.status = "rejected"; sc.reason = data.reason; }
  }
  const ap = state.approvals.find((a) => a.approvalId === data.approvalId);
  if (ap) { ap.status = "rejected"; ap.reason = data.reason; }
}

function finishStream(rid) {
  const stream = state.activeStreams.get(rid);
  if (stream) stream.block.finished = true;
  state.activeStreams.delete(rid);
}

// ========== 撤回折叠（按周期回滚）==========
function handleReverse(rid, messageIds) {
  const blocks = state.blocks;
  let i = blocks.length - 1;
  while (i >= 0 && blocks[i].revoked) i--; // 跳过已撤回
  const revoked = [];
  while (i >= 0) {
    const b = blocks[i];
    if (b.kind === "user" || b.kind === "system" || b.kind === "reverse-fold") break;
    if (b.revoked) break;
    revoked.unshift(b); i--;
  }
  if (revoked.length === 0) return;
  for (const b of revoked) b.revoked = true;
  const insertAt = blocks.indexOf(revoked[0]);
  blocks.splice(insertAt, 0, {
    id: crypto.randomUUID(), kind: "reverse-fold", rid,
    revokedMessageIds: messageIds, count: revoked.length,
    revokedBlocks: revoked.map((b) => b.id), expanded: false,
  });
  state.activeStreams.delete(rid);
}

// ========== 公共 API ==========
export const store = {
  get: () => state,
  subscribe(cb) {
    const h = () => cb(state);
    target.addEventListener("change", h);
    return () => target.removeEventListener("change", h);
  },

  // —— 连接 ——
  setConnection(patch) { Object.assign(state.connection, patch); emit(); },

  // —— 配置 ——
  applyBrains(brains) {
    state.brains = brains;
    emit();
  },
  applySenses(groups) {
    state.senseGroups = groups;
    emit();
  },
  setSelection(patch) { Object.assign(state.selection, patch); emit(); },

  // —— chat 管理 ——
  setChats(chats) { state.chats = chats; emit(); },
  addChat(chatId) {
    if (!state.chats.some((c) => c.chatId === chatId)) {
      state.chats.unshift({ chatId, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 });
    }
    emit();
  },
  removeChat(chatId) {
    state.chats = state.chats.filter((c) => c.chatId !== chatId);
    emit();
  },
  setCurrentChat(chatId) {
    state.currentChatId = chatId;
    state.currentChatLoaded = false;
    state.currentChatSent = false;
    state.currentChatCanResume = false;
    pendingSenseResults.clear();
    replayCycleThink = "";
    emit();
  },
  setChatLoaded(v) { state.currentChatLoaded = !!v; emit(); },
  markSent() { state.currentChatSent = true; emit(); },
  setCanResume(v) { state.currentChatCanResume = !!v; emit(); },

  // —— 流 ingest ——
  ingestChunk(chunk) {
    const rid = chunk.requestId;
    const isReplay = rid != null && rid === state.currentChatId;
    if (chunk.type === "stream") {
      if (isReplay) return; // 回放不发 stream chunk
      const stream = getOrCreateLiveStream(rid);
      applyStreamDelta(stream.block, chunk.data, stream.streamingByIndex);
    } else { // staged
      if (isReplay) applyReplayStaged(chunk.data);
      else applyLiveStaged(rid, chunk.data);
    }
    emit();
  },

  ingestNotification(notif) {
    const rid = notif.requestId;
    switch (notif.type) {
      case "interrupt": applyInterrupt(rid, notif.data); break;
      case "accept": applyAccept(rid, notif.data); break;
      case "rejected": applyRejected(rid, notif.data); break;
      case "loaded":
        state.blocks.push(_newBlock("system", rid, { text: "▚ HISTORY LOADED" }));
        break;
      case "done": finishStream(rid); break;
      case "error":
        state.blocks.push(_newBlock("error", rid, { text: notif.data?.message ?? "ERROR" }));
        break;
      case "consumed": break;
    }
    emit();
  },

  // —— 消息/错误 ——
  pushUserBlock(text) {
    state.blocks.push(_newBlock("user", state.currentChatId, { text }));
    emit();
  },
  pushError(msg) {
    state.blocks.push(_newBlock("error", state.currentChatId, { text: msg }));
    emit();
  },

  // —— replay 重置 ——
  resetReplay() {
    state.blocks = [];
    state.activeStreams = new Map();
    replayAssistant = null;
    replayCycleThink = "";
    pendingSenseResults.clear();
    emit();
  },

  // —— 审批 tab ——
  selectApprovalTab(approvalId) { state.ui.approvalActiveTab = approvalId; emit(); },
  removeApproval(approvalId) {
    state.approvals = state.approvals.filter((a) => a.approvalId !== approvalId);
    if (state.ui.approvalActiveTab === approvalId) {
      state.ui.approvalActiveTab = state.approvals.find((a) => a.status === "pending")?.approvalId
        ?? state.approvals[0]?.approvalId ?? null;
    }
    emit();
  },
  // 批量清退所有已决审批（accepted/rejected），保留 pending（服务端仍待 accept/reject，不可丢）
  dismissResolved() {
    state.approvals = state.approvals.filter((a) => a.status === "pending");
    if (!state.approvals.some((a) => a.approvalId === state.ui.approvalActiveTab)) {
      state.ui.approvalActiveTab = state.approvals[0]?.approvalId ?? null;
    }
    emit();
  },
  clearPendingApprovals() {
    state.approvals = state.approvals.filter((a) => a.status !== "pending");
    if (!state.approvals.some((a) => a.approvalId === state.ui.approvalActiveTab)) {
      state.ui.approvalActiveTab = state.approvals[0]?.approvalId ?? null;
    }
    emit();
  },

  // —— 撤回折叠展开 ——
  toggleReverse(blockId) {
    const b = state.blocks.find((x) => x.id === blockId);
    if (b && b.kind === "reverse-fold") { b.expanded = !b.expanded; emit(); }
  },

  // —— 日志 ——
  appendLog(dir, msg) {
    state.log.push({
      dir, kind: msg.kind,
      summary: _summarize(msg),
      raw: msg, ts: Date.now(), expanded: false,
    });
    emit();
  },
  clearLog() { state.log = []; emit(); },
};

function _summarize(msg) {
  if (msg.kind === "request") return msg.method;
  if (msg.kind === "response") return msg.success ? "OK" : `ERR ${msg.error?.code ?? ""}`;
  if (msg.kind === "chunk") return `chunk:${msg.type}${msg.seq != null ? "#" + msg.seq : ""}`;
  if (msg.kind === "notification") return `notify:${msg.type}`;
  return "?";
}
