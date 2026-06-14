/**
 * 顶栏：WS 连接 + brain/senseGroups 选择 + chat 操作。
 * 填充 container（main.js 赋予布局）。改 brain/sense 后自动 runtime.set。
 * 定向更新动态 DOM（select/状态点/disabled），避免重建丢焦点。
 * brain/sense hover(info-card) 展示选中项详情（provider/model/thinking · 组工具列表）；NEW/DELETE 按状态门控。
 * load/resume 已移至输入栏（input-bar）。
 */
import { h, el } from "@web/lib/dom.js";
import { store } from "@web/core/store.js";
import { actions } from "@web/core/actions.js";
import { truncate } from "@web/core/format.js";
import { attachHoverInfo } from "@web/lib/tooltip.js";

export function mountTopbar(container) {
  container.classList.add("topbar");
  container.append(
    h("input", { class: "ws-url", id: "wsUrl", attrs: { placeholder: "ws://host:port" } }),
    h("button", { class: "btn btn-accent", id: "btnConn", on: { click: onConnect } }, "CONNECT"),
    h("button", { class: "btn", id: "btnDisc", on: { click: () => actions.disconnect() } }, "DISCONNECT"),
    h("span", { class: "status-dot disconnected", id: "statusDot", title: "link status" }),
    h("span", { class: "label" }, "BRAIN"),
    h("select", { class: "select", id: "brainSel", on: { change: onBrainChange } }),
    h("span", { class: "label" }, "SENSE"),
    h("select", { class: "select", id: "senseSel", on: { change: onSenseChange } }),
    h("span", { class: "label" }, "CHAT"),
    h("select", { class: "select", id: "chatSel", on: { change: onChatChange } }),
    h("button", { class: "btn", id: "btnNew", on: { click: () => actions.newChat() } }, "NEW"),
    h("button", { class: "btn", id: "btnDelete", on: { click: () => actions.deleteChat() } }, "DELETE")
  );

  el("#wsUrl").value = "ws://localhost:8080";

  function onConnect() { actions.connect(el("#wsUrl").value); }
  function onBrainChange(e) { actions.setBrain(e.target.value); }
  function onSenseChange(e) { actions.setSenseGroups(e.target.value ? [e.target.value] : []); }
  function onChatChange(e) { actions.selectChat(e.target.value); }

  // brain/sense hover：选中项详情卡片（实时读 store，mouseenter 触发渲染）
  attachHoverInfo(el("#brainSel"), () => {
    const st = store.get();
    const b = st.brains.find((x) => x.name === st.selection.brain);
    return b ? buildBrainCard(b) : null;
  });
  attachHoverInfo(el("#senseSel"), () => {
    const st = store.get();
    const g = st.senseGroups.find((x) => x.name === (st.selection.senseGroups[0] ?? null));
    return g ? buildSenseCard(g) : null;
  });

  store.subscribe(update);
  update(store.get());

  function update(s) {
    el("#statusDot").className = `status-dot ${s.connection.status}`;
    el("#btnConn").disabled = s.connection.status === "connected";
    el("#btnDisc").disabled = s.connection.status !== "connected";

    syncSelect(el("#brainSel"), s.brains.map((b) => ({ value: b.name, text: b.name })), s.selection.brain);
    syncSelect(el("#senseSel"), s.senseGroups.map((g) => ({ value: g.name, text: g.name })), s.selection.senseGroups[0] ?? null);
    syncSelect(el("#chatSel"), s.chats.map((c) => ({ value: c.chatId, text: `${truncate(c.chatId, 12)} (${c.messageCount ?? 0})` })), s.currentChatId);

    // NEW 需先选 brain + senseGroups；DELETE 需先选中 chat
    el("#btnNew").disabled = !s.selection.brain || s.selection.senseGroups.length === 0;
    el("#btnDelete").disabled = !s.currentChatId;
  }
}

function syncSelect(sel, options, selected) {
  // 首位插 disabled placeholder（value="")，无选中时回落它，避免原生显示首项误为"已选中"
  const cur = Array.from(sel.options).map((o) => o.value).join(",");
  const next = ["", ...options.map((o) => o.value)].join(",");
  // sel 刚创建无 option 时 cur=next="" 会被跳过 → 占位项永不插入（新页空下拉）。
  // 故 options 为空且 select 无任何 option 时强制重建一次插入 placeholder。
  if (cur !== next || sel.options.length === 0) {
    sel.innerHTML = "";
    sel.appendChild(h("option", { attrs: { value: "", disabled: true } }, "— select —"));
    for (const o of options) sel.appendChild(h("option", { attrs: { value: o.value } }, o.text));
  }
  if (selected && Array.from(sel.options).some((o) => o.value === selected)) sel.value = selected;
  else sel.value = "";
}

// —— hover info-card 构造 ——

function buildBrainCard(b) {
  return h("div", {},
    h("div", { class: "ic-title" }, `◈ ${b.name}`),
    h("div", { class: "ic-row" }, h("span", { class: "ic-key" }, "provider"), h("span", { class: "ic-val" }, b.provider ?? "—")),
    h("div", { class: "ic-row" }, h("span", { class: "ic-key" }, "model"), h("span", { class: "ic-val" }, b.model ?? "—")),
    h("div", { class: "ic-row" }, h("span", { class: "ic-key" }, "thinking"), h("span", { class: "ic-val" }, b.thinking ? "on" : "off")),
  );
}

function buildSenseCard(g) {
  const tools = g.senses?.length
    ? g.senses.map(parseSense).map(({ name, level }) =>
        h("div", { class: "ic-tool" },
          h("span", { class: "ic-tool-name" }, name),
          level ? h("span", { class: `badge badge-${level}` }, level) : null,
        ))
    : [h("div", { class: "ic-empty" }, "no senses")];
  return h("div", {},
    h("div", { class: "ic-title" }, `◈ ${g.name}`),
    h("div", { class: "ic-key" }, "senses"),
    h("div", { class: "ic-tools" }, tools),
  );
}

// sense 项 "name[:level]" → { name, level }（level 为覆盖监管等级 auto/confirm/manual）
function parseSense(s) {
  const [name, level] = s.split(":");
  return { name, level: level || null };
}
