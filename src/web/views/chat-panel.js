/**
 * 聊天主区：blocks 列表 reconciliation。
 *
 * key-based 复用（blockId → 控制器）：新 block 创建，已有 block 调 update 增量，
 * 顺序按 state.blocks 对齐，多余移除。reverse-fold 联动其后 revoked blocks 显隐。
 */
import { store } from "@web/core/store.js";
import { createBlock } from "@web/views/messages.js";

export function mountChatPanel(container) {
  container.classList.add("chat-messages");
  const list = container;
  const ctrlMap = new Map(); // blockId → { el, update }

  const unsub = store.subscribe(reconcile);
  reconcile();
  return unsub;

  function reconcile() {
    const blocks = store.get().blocks;
    const seen = new Set();
    let prev = null;

    for (const b of blocks) {
      seen.add(b.id);
      let entry = ctrlMap.get(b.id);
      if (!entry) { entry = createBlock(b); entry.el.dataset.blockId = b.id; ctrlMap.set(b.id, entry); }
      entry.update(b);
      // 顺序对齐：el 不在 list 内（首次创建/被移除后）或位置不符 → 重新插入
      // 注意：仅比 previousElementSibling !== prev 无法覆盖首次插入（未入 DOM 时两者皆 null）
      if (!list.contains(entry.el) || entry.el.previousElementSibling !== prev) {
        if (prev) prev.after(entry.el);
        else list.prepend(entry.el);
      }
      prev = entry.el;
    }

    // 移除多余
    for (const [id, entry] of ctrlMap) {
      if (!seen.has(id)) { entry.el.remove(); ctrlMap.delete(id); }
    }

    applyReverseFolds(blocks);
    list.scrollTop = list.scrollHeight;
  }

  /** reverse-fold 展开时显示其后连续 revoked blocks */
  function applyReverseFolds(blocks) {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.kind !== "reverse-fold") continue;
      const show = b.expanded ? "" : "none";
      let j = i + 1;
      while (j < blocks.length && blocks[j].revoked) {
        const e = ctrlMap.get(blocks[j].id);
        if (e) e.el.style.display = show;
        j++;
      }
    }
  }
}
