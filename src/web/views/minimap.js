/**
 * 快速定位条：贴聊天区右边缘的竖向标记条。
 * 每个 block 一个色块（按类型着色），点击 scrollIntoView 到对应 block。
 */
import { h } from "@web/lib/dom.js";
import { store } from "@web/core/store.js";

export function mountMinimap(container, scrollRoot) {
  container.classList.add("minimap");
  const unsub = store.subscribe(update);
  update();

  function update() {
    container.innerHTML = "";
    for (const b of store.get().blocks) {
      if (b.revoked) continue;
      container.appendChild(h("div", {
        class: `mm-mark mm-${typeClass(b)}`,
        title: typeLabel(b),
        on: { click: () => scrollTo(b.id) },
      }));
    }
  }

  function scrollTo(blockId) {
    const el = scrollRoot.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return unsub;
}

function typeClass(b) {
  if (b.kind === "reverse-fold") return "reverse";
  return b.kind || "other";
}

function typeLabel(b) {
  const map = {
    user: "USER",
    assistant: "AI",
    sense: `SENSE ${b.senseName || ""}`,
    system: "SYSTEM",
    error: "ERROR",
    "reverse-fold": "REVOKED",
  };
  return map[b.kind] ?? b.kind ?? "?";
}
