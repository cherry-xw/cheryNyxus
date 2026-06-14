/**
 * 右侧 chunk 全量数据面板：所有 chunk/notification/request/response 原始帧日志。
 * 追加式渲染（不重建已有项），点击展开看完整 JSON。
 */
import { h, clear } from "@web/lib/dom.js";
import { store } from "@web/core/store.js";
import { actions } from "@web/core/actions.js";
import { prettyJSON, formatTime } from "@web/core/format.js";

export function mountChunkPanel(container) {
  container.classList.add("chunk-panel");
  const head = h("div", { class: "chunk-panel-head" },
    "RAW STREAM",
    h("button", { class: "btn", on: { click: () => actions.clearLog() } }, "CLEAR")
  );
  const list = h("div", { class: "chunk-list" });
  container.append(head, list);

  let rendered = 0;
  store.subscribe(update);

  function update() {
    const log = store.get().log;
    if (log.length < rendered) { clear(list); rendered = 0; } // cleared
    while (rendered < log.length) {
      list.appendChild(createItem(log[rendered]));
      rendered++;
    }
    list.scrollTop = list.scrollHeight;
  }
}

function createItem(item) {
  const text = prettyJSON(item.raw);
  const pre = h("pre", {});
  pre.textContent = text;
  // COPY 按钮：stopPropagation 不触发 meta toggle，复制后短暂回显 ✓
  const copyBtn = h("button", { class: "btn btn-mini", on: { click: onCopy } }, "COPY");
  // toggle 仅绑 meta 行：pre 区域可自由选中复制，不触发展开/折叠
  const meta = h("div", { class: "meta", on: { click: () => el.classList.toggle("expanded") } },
    h("span", { class: `dir ${item.dir}` }, item.dir.toUpperCase()),
    h("span", { class: "time" }, formatTime(item.ts)),
    h("span", { class: "summary" }, item.summary),
    copyBtn,
  );
  const el = h("div", { class: "chunk-item" }, meta, pre);

  function onCopy(e) {
    e.stopPropagation();
    copyToClipboard(text);
    copyBtn.textContent = "✓";
    setTimeout(() => { copyBtn.textContent = "COPY"; }, 1200);
  }
  return el;
}

/** 复制到剪贴板：优先 navigator.clipboard，降级 execCommand */
function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch { /* ignore */ }
  ta.remove();
}
