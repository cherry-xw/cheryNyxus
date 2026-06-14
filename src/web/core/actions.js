/**
 * 业务动作（编排层）：唯一调 rpc + 写 store 的入口。
 *
 * 维护 conn/rpc 模块级引用；views 只读 store + 调 actions，不直接碰传输。
 */

import { createConnection } from "@web/core/ws.js";
import { createRpc } from "@web/core/rpc.js";
import { store } from "@web/core/store.js";

let conn = null;
let rpc = null;

export const actions = {
  // —— 连接 ——
  connect(url) {
    if (conn) conn.close();
    store.setConnection({ status: "connecting", wsUrl: url, error: null });
    conn = createConnection(url);
    rpc = createRpc(conn, {
      onSend: (msg) => store.appendLog("send", msg),
      onRecv: (msg) => store.appendLog("recv", msg),
      onChunk: (chunk) => store.ingestChunk(chunk),
      onNotification: (notif) => store.ingestNotification(notif),
    });
    conn.on("open", () => {
      store.setConnection({ status: "connected" });
      actions.loadLists();
    });
    conn.on("close", () => {
      rpc?.clear();
      store.setConnection({ status: "disconnected" });
      store.clearPendingApprovals();
      conn = null; rpc = null;
    });
    conn.on("error", () => store.setConnection({ error: "WebSocket error" }));
  },

  disconnect() { conn?.close(); },

  // —— 列表 ——
  async loadLists() {
    if (!rpc) return;
    try {
      const [br, se] = await Promise.all([
        rpc.request("brain.list", {}),
        rpc.request("sense.list", {}),
      ]);
      if (br.success) store.applyBrains(br.data.brains || []);
      if (se.success) store.applySenses(se.data.senseGroups || []);
    } catch (e) { store.pushError(e.message); }
  },

  // —— 选择（改 selection 后若有 chat 则自动 runtime.set 同步）——
  // setBrain 额外链式 listChats：选 brain 后立即拉 chat 列表填充下拉
  async setBrain(name) {
    store.setSelection({ brain: name });
    await this.applyRuntime();
    await this.listChats();
  },
  async setSenseGroups(groups) { store.setSelection({ senseGroups: groups }); await this.applyRuntime(); },

  // chat 下拉选中：仅切 currentChatId，不载入历史（由 LOAD 显式触发）。
  // loaded 留 false：若该 chat 有历史（messageCount>0），输入栏显示 LOAD；空 chat 因 messageCount=0 直接可 SEND
  selectChat(chatId) {
    if (!chatId) return;
    store.setCurrentChat(chatId);
  },

  async applyRuntime() {
    if (!rpc) return;
    const { selection, currentChatId } = store.get();
    if (!currentChatId || !selection.brain || selection.senseGroups.length === 0) return;
    try {
      const r = await rpc.request("runtime.set", {
        chatId: currentChatId, brain: selection.brain, senseGroups: selection.senseGroups,
      });
      if (!r.success) store.pushError(r.error?.message || "runtime.set failed");
    } catch (e) { store.pushError(e.message); }
  },

  // —— chat 管理 ——
  // NEW：chat[0]（addChat unshift → 最新在前）为空 → 复用并选中；否则创建新 chat。
  // 避免 NEW 后留多条空 chat。
  // 空判定：messageCount===0 且（非当前 chat 或当前未发消息）—— 因 send 不刷新客户端 messageCount，
  // 需 currentChatSent 兜底：当前 chat 已发消息则视为非空，新建而非复用。
  async newChat() {
    if (!rpc) return;
    const { selection, chats, currentChatId, currentChatSent } = store.get();
    if (!selection.brain || selection.senseGroups.length === 0) {
      store.pushError("Select brain + senseGroups first");
      return;
    }
    const latest = chats[0];
    const latestEmpty = latest
      && (latest.messageCount ?? 0) === 0
      && !(latest.chatId === currentChatId && currentChatSent);
    if (latestEmpty) {
      // 复用空 chat：loaded=false 但 messageCount=0 → 输入栏直接 SEND
      store.setCurrentChat(latest.chatId);
      store.resetReplay();
      await this.applyRuntime();
      return;
    }
    this.createChat();
  },

  async createChat(chatId) {
    if (!rpc) return;
    const { selection } = store.get();
    if (!selection.brain || selection.senseGroups.length === 0) {
      store.pushError("Select brain + senseGroups first");
      return;
    }
    const params = { brain: selection.brain, senseGroups: selection.senseGroups };
    if (chatId) params.chatId = chatId;
    try {
      const r = await rpc.request("chat.create", params);
      if (r.success) {
        store.setCurrentChat(r.data.chatId);
        store.resetReplay();
        store.addChat(r.data.chatId);
        store.setChatLoaded(true); // 新建空 chat 即就绪，可直接 SEND
      } else store.pushError(r.error?.message || "create failed");
    } catch (e) { store.pushError(e.message); }
  },

  async listChats() {
    if (!rpc) return;
    try {
      const r = await rpc.request("chat.list", {});
      if (r.success) store.setChats(r.data.chats || []);
    } catch (e) { store.pushError(e.message); }
  },

  async loadHistory(chatId) {
    if (!rpc) return;
    store.setCurrentChat(chatId);
    store.resetReplay();
    try {
      // chat.get 流式：chunk 经 onChunk → ingest(replay mode)；response 最后带 canResume
      const r = await rpc.request("chat.get", { chatId });
      if (r.success) {
        store.setCanResume(!!r.data?.canResume);
        store.setChatLoaded(true);
        // load 后自动 runtime.set 一次：用当前 selection 同步 runtime（selection 未就绪则 applyRuntime 内部跳过）
        await this.applyRuntime();
      } else store.pushError(r.error?.message || "chat.get failed");
    } catch (e) { store.pushError(e.message); }
  },

  async deleteChat() {
    if (!rpc) return;
    const { currentChatId } = store.get();
    if (!currentChatId) return;
    try {
      const r = await rpc.request("chat.delete", { chatId: currentChatId });
      if (r.success) {
        store.removeChat(currentChatId);
        store.setCurrentChat(null);
        store.resetReplay();
      } else store.pushError(r.error?.message || "delete failed");
    } catch (e) { store.pushError(e.message); }
  },

  // —— 发送 / 续接（流式，不 await response，靠 notification 驱动）——
  sendMessage(text) {
    if (!rpc) { store.pushError("Not connected"); return; }
    const { currentChatId } = store.get();
    if (!currentChatId) { store.pushError("Create a chat first"); return; }
    if (!text.trim()) return;
    store.pushUserBlock(text);
    store.markSent();
    rpc.stream("chat.send", { chatId: currentChatId, prompt: text });
  },

  resume() {
    if (!rpc) { store.pushError("Not connected"); return; }
    const { currentChatId } = store.get();
    if (!currentChatId) return;
    rpc.stream("chat.resume", { chatId: currentChatId });
    // 点击即隐藏 RESUME，直至下次 load（chat.get canResume 响应）再显
    store.setCanResume(false);
  },

  // —— 审批 ——
  async approve(approvalId, action, reason) {
    if (!rpc) return;
    try {
      const r = await rpc.request("sense.approval", {
        approvalId, action, reason: reason || undefined,
      });
      if (!r.success) store.pushError(r.error?.message || "approval failed");
      // tab 状态由后续 accept/rejected notification 更新（不乐观）
    } catch (e) { store.pushError(e.message); }
  },

  closeApproval(approvalId) { store.removeApproval(approvalId); },
  dismissResolved() { store.dismissResolved(); },
  selectApprovalTab(approvalId) { store.selectApprovalTab(approvalId); },

  // —— 撤回折叠 ——
  toggleReverse(blockId) { store.toggleReverse(blockId); },

  // —— 日志 ——
  clearLog() { store.clearLog(); },
};
