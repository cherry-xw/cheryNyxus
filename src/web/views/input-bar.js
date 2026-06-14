/**
 * 底输入条：双行布局（均在 input-bar 内）。
 *   上行 .input-actions：resume-hint + RESUME（空时整行隐藏，避免空白）
 *   下行 .input-main   ：msg-input + SEND
 *
 * 按钮显隐（上行）：仅 canResume → RESUME（点击后清 canResume，下次 load 再现）。
 * 历史载入已自动化于 chat 切换（selectChat → loadHistory），不再需 LOAD。
 * Enter = SEND。
 */
import { h, el } from "@web/lib/dom.js";
import { store } from "@web/core/store.js";
import { actions } from "@web/core/actions.js";

export function mountInputBar(container) {
  container.classList.add("input-bar");
  container.append(
    h("div", { class: "input-row input-actions", id: "actionsRow" },
      h("span", { class: "resume-hint", id: "resumeHint" }),
      h("button", { class: "btn", id: "btnResume", on: { click: doResume } }, "RESUME ⟳")
    ),
    h("div", { class: "input-row input-main" },
      h("input", {
        class: "msg-input", id: "msgInput",
        attrs: { placeholder: "▸ transmit message... (Enter to send)", autocomplete: "off" },
        on: {
          input: () => update(store.get()),
          keydown: (e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
          },
        },
      }),
      h("button", { class: "btn btn-send", id: "btnSend", on: { click: doSend } }, "SEND ▸")
    )
  );

  function doResume() { actions.resume(); }
  function doSend() {
    const input = el("#msgInput");
    const text = input.value;
    if (!text.trim()) return;
    input.value = "";
    update(store.get());
    actions.sendMessage(text);
  }

  store.subscribe(update);
  update(store.get());

  function update(s) {
    const connected = s.connection.status === "connected";
    const showResume = s.currentChatCanResume;

    el("#msgInput").disabled = !connected;
    // 上行仅 RESUME（load 已自动化于 chat 切换）：canResume 时显示，否则整行隐藏
    el("#btnResume").style.display = showResume ? "" : "none";
    el("#actionsRow").style.display = showResume ? "" : "none";
    el("#resumeHint").textContent = showResume
      ? "⟳ pending cycle — RESUME or send to revoke+rerun"
      : "";
    // 下行：SEND 始终可见，无 chat / 无输入时禁用（不隐藏）
    el("#btnSend").disabled = !connected || !s.currentChatId || !el("#msgInput").value.trim();
  }
}
