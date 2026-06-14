/**
 * Hover 信息卡片：mouseenter target 渲染卡片定位其下方，mouseleave 隐藏。
 *
 * 单例共享 card 节点（挂 body），避免重复创建/泄漏。getContent 返回 Node 显示，
 * 返回 null 隐藏。card 自身可 hover 保持（复制内容），120ms 延迟隐藏消除抖动。
 *
 * 仅受控内部字符串渲染（h + textContent 自动转义）。
 */
import { h } from "./dom.js";

let cardEl = null;
let hideTimer = null;
let cardBound = false;

function ensureCard() {
  if (cardEl) return cardEl;
  cardEl = h("div", { class: "info-card", attrs: { hidden: true } });
  document.body.append(cardEl);
  return cardEl;
}

function bindCardHover() {
  if (cardBound) return;
  cardBound = true;
  const card = ensureCard();
  card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  card.addEventListener("mouseleave", () => scheduleHide());
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (cardEl) cardEl.hidden = true; }, 120);
}

function position(card, target) {
  const r = target.getBoundingClientRect();
  card.style.left = `${r.left + window.scrollX}px`;
  card.style.top = `${r.bottom + 4 + window.scrollY}px`;
}

/**
 * 绑定 hover：target mouseenter 时调 getContent 取卡片内容渲染并定位其下方。
 * getContent 实时读取（每次 enter 调用），无需重绑。
 */
export function attachHoverInfo(target, getContent) {
  bindCardHover();
  target.addEventListener("mouseenter", () => {
    clearTimeout(hideTimer);
    const content = getContent();
    const card = ensureCard();
    if (!content) { card.hidden = true; return; }
    card.replaceChildren(content);
    card.hidden = false;
    position(card, target);
  });
  target.addEventListener("mouseleave", scheduleHide);
}
