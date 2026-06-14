/**
 * 底输入条：双行布局（均在 input-bar 内）。
 *   上行 .input-actions：resume-hint + LOAD + RESUME（空时整行隐藏，避免空白）
 *   下行 .input-main   ：msg-input + SEND
 *
 * 按钮显隐（上行）：
 *   - 需载入（选中 chat 有历史且未 loaded）→ LOAD
 *   - 就绪且 canResume → RESUME（点击后清 canResume，下次 load 再现）
 * Enter = 主动作（需载入则 LOAD，否则 SEND）。
 */
import { h, el } from "@web/lib/dom.js";
import { store } from "@web/core/store.js";
import { actions } from "@web/core/actions.js";

export function mountInputBar(container) {
  container.classList.add("input-bar");
  container.append(
    h("div", { class: "input-row input-actions", id: "actionsRow" },
      h("span", { class: "resume-hint", id: "resumeHint" }),
      h("button", { class: "btn btn-load", id: "btnLoad", on: { click: doLoad } }, "LOAD ▸"),
      h("button", { class: "btn", id: "btnResume", on: { click: doResume } }, "RESUME ⟳")
    ),
    h("div", { class: "input-row input-main" },
      h("input", {
        class: "msg-input", id: "msgInput",
        attrs: { placeholder: "▸ transmit message... (Enter to send)", autocomplete: "off" },
        on: {
          input: () => update(store.get()),
          keydown: (e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); primaryAction(); }
          },
        },
      }),
      h("button", { class: "btn btn-send", id: "btnSend", on: { click: doSend } }, "SEND ▸")
    )
  );

  function doLoad() {
    const id = store.get().currentChatId;
    if (id) actions.loadHistory(id);
  }
  function doResume() { actions.resume(); }
  function doSend() {
    const input = el("#msgInput");
    const text = input.value;
    if (!text.trim()) return;
    input.value = "";
    update(store.get());
    actions.sendMessage(text);
  }
  // Enter 主动作：需载入 → LOAD；否则 SEND
  function primaryAction() {
    if (needsLoad(store.get())) { doLoad(); return; }
    doSend();
  }

  store.subscribe(update);
  update(store.get());

  // 需载入：选中 chat 有历史且未 loaded
  function needsLoad(s) {
    const cur = s.chats.find((c) => c.chatId === s.currentChatId);
    return !!s.currentChatId && !s.currentChatLoaded && (cur?.messageCount ?? 0) > 0;
  }

  function update(s) {
    const connected = s.connection.status === "connected";
    const load = connected && needsLoad(s);
    const showResume = !load && s.currentChatCanResume;

    el("#msgInput").disabled = !connected;
    // 上行：LOAD（需载入）/ RESUME（canResume），整行无内容则隐藏避免空白
    el("#btnLoad").style.display = load ? "" : "none";
    el("#btnResume").style.display = showResume ? "" : "none";
    el("#actionsRow").style.display = (load || showResume) ? "" : "none";
    el("#resumeHint").textContent = showResume
      ? "⟳ pending cycle — RESUME or send to revoke+rerun"
      : "";
    // 下行：SEND 始终可见，需载入 / 无 chat / 无输入时禁用（不隐藏）
    el("#btnSend").disabled = !connected || !s.currentChatId || load || !el("#msgInput").value.trim();
  }
}
