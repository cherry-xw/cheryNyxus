/**
 * 单 block 渲染控制器：createBlock(block) → { el, update(block) }。
 *
 * update 内部 diff：
 *   - assistant thinking/content 流式增量 appendText（不重建，无闪烁）
 *   - senseCalls 按 index 复用 DOM，状态/结果定向更新
 *   - revoked 样式、reverse-fold 展开态同步
 * 所有用户/LLM 内容走 textContent（自动转义防 XSS）。
 */
import { h, appendText } from "@web/lib/dom.js";
import { parseStyled, highlightJSON, levelInfo, renderKV } from "@web/core/format.js";
import { actions } from "@web/core/actions.js";

export function createBlock(block) {
  switch (block.kind) {
    case "user": return simple(block, "block block-user", "text");
    case "system": return simple(block, "block block-system", "text");
    case "error": return simple(block, "block block-error", "text");
    case "sense": return standaloneSense(block);
    case "assistant": return assistant(block);
    case "reverse-fold": return reverseFold(block);
    default: return simple(block, "block block-system", "text");
  }
}

function simple(block, cls, field) {
  const el = h("div", { class: cls });
  if (block.revoked) el.classList.add("revoked");
  el.textContent = block[field] ?? "";
  return {
    el,
    update: (b) => {
      el.classList.toggle("revoked", !!b.revoked);
      const v = b[field] ?? "";
      if (el.textContent !== v) el.textContent = v;
    },
  };
}

function standaloneSense(block) {
  // 橙色外框：标题 + argument（键值表）+ result（顶部「详情」按钮控制显隐）
  let resultWrap = null, resultBody = null, lastResult;
  let lastThink2 = undefined;
  const toggleBtn = h("button", {
    class: "sense-detail-toggle",
    on: { click: () => {
      if (!resultWrap) return;
      const active = resultWrap.classList.toggle("active");
      toggleBtn.classList.toggle("active", active);
    } },
  }, "DETAIL");
  const head = h("div", { class: "sense-head" },
    h("span", { class: "sense-name" }, block.senseName || "?"),
    h("span", { class: "badge badge-confirm" }, "DONE"),
    toggleBtn,
  );
  const argsEl = h("div", { class: "sense-args" });
  const header = h("div", { class: "sense-header" }, head, argsEl);
  // sense 样式 thinking：框内 collapsible THINK（replay 由 replayCycleThink 填充）
  const sThinkBody = h("div", { class: "body" });
  const sThink = h("details", { class: "sense-thinking" }, h("summary", {}, "THINK"), sThinkBody);
  const el = h("div", { class: "sense-block" }, sThink, header);

  function applyArgs(args) {
    const r = renderKV(args || "");
    argsEl.className = `sense-args ${r.mode}`;
    if (r.mode === "kv") argsEl.innerHTML = r.html;
    else if (r.mode === "json") argsEl.innerHTML = highlightJSON(r.text);
    else argsEl.textContent = r.text;
  }
  function applyResult(result) {
    if ((result == null || result === "") && !resultWrap) return;
    if (!resultWrap) {
      resultBody = h("div", { class: "sense-result" });
      resultWrap = h("div", { class: "sense-result-wrap" }, resultBody);
      header.appendChild(h("hr", { class: "sense-sep" }));
      el.appendChild(resultWrap);
    }
    const { ok, text } = parseStyled(result);
    resultBody.className = `sense-result ${ok ? "json" : "raw"}`;
    if (ok) resultBody.innerHTML = highlightJSON(text);
    else resultBody.textContent = text;
  }
  function applyThink(thinking) {
    const th = thinking ?? null;
    if (th === lastThink2) return;
    lastThink2 = th;
    sThinkBody.textContent = th ?? "";
    sThink.style.display = th ? "" : "none";
  }
  applyArgs(block.arguments);
  applyResult(block.result);
  applyThink(block.thinking);

  if (block.revoked) el.classList.add("revoked");
  return {
    el,
    update: (b) => {
      el.classList.toggle("revoked", !!b.revoked);
      applyThink(b.thinking);
      if (b.result !== lastResult) { lastResult = b.result; applyResult(b.result); }
    },
  };
}

function assistant(block) {
  const el = h("div", { class: "block" });
  if (block.revoked) el.classList.add("revoked");
  const contentEl = h("div", { class: "block-content" });
  el.appendChild(contentEl);

  let thinkDetails = null, thinkBody = null;
  let lastThink = 0, lastContent = 0;
  const senseMap = new Map(); // index → { el, nameEl, statusEl, argsEl, resultEl, lastName }

  function ensureThinking() {
    if (thinkDetails) return;
    thinkBody = h("div", { class: "body" });
    thinkDetails = h("details", { class: "block-thinking", open: true }, h("summary", {}, "THINK"), thinkBody);
    el.insertBefore(thinkDetails, contentEl);
  }

  function updateSense(calls) {
    calls.forEach((sc, idx) => {
      let e = senseMap.get(idx);
      if (!e) {
        const nameEl = h("span", { class: "sense-name" }, sc.name || "...");
        const statusEl = h("span", { class: "sense-status" }, sc.status || "");
        const toggleBtn = h("button", {
          class: "sense-detail-toggle",
          on: { click: () => {
            if (!e.resultWrap) return;
            const active = e.resultWrap.classList.toggle("active");
            toggleBtn.classList.toggle("active", active);
          } },
        }, "DETAIL");
        // 橙色外框：标题 + argument + result（顶部「详情」按钮控制显隐）
        const head = h("div", { class: "sense-head" }, nameEl, toggleBtn, statusEl);
        const argsEl = h("div", { class: "sense-args" });
        const header = h("div", { class: "sense-header" }, head, argsEl);
        // sense 样式 thinking：框内 args 上方 collapsible THINK（sense_end 时由 pendingThink 填充）
        const sThinkBody = h("div", { class: "body" });
        const sThink = h("details", { class: "sense-thinking" }, h("summary", {}, "THINK"), sThinkBody);
        sThink.style.display = "none";
        const senseEl = h("div", { class: "sense-block" }, sThink, header);
        // insertBefore contentEl：工具块在总结块之前（多轮 loop 时工具在前、最终总结在后）
        el.insertBefore(senseEl, contentEl);
        e = { el: senseEl, header, head, toggleBtn, nameEl, statusEl, argsEl, badgeEl: null, resultWrap: null, resultBody: null, lastArgsCls: null, lastName: "", sThink, sThinkBody, lastSenseThink: undefined };
        senseMap.set(idx, e);
      }
      // badge 补建：sc 由 stream delta 首建时 level 未设（仅 interrupt 后到达），此处补建
      if (sc.level != null && !e.badgeEl) {
        const info = levelInfo(sc.level);
        e.badgeEl = h("span", { class: `badge ${info.badge}` }, info.name);
        e.head.insertBefore(e.badgeEl, e.toggleBtn);
      }
      if (sc.name && sc.name !== e.lastName) { e.nameEl.textContent = sc.name; e.lastName = sc.name; }
      // sense thinking（sense_end 填充，一次性整段）：变化时刷新，无值则隐藏
      const sTh = sc.thinking ?? null;
      if (sTh !== e.lastSenseThink) {
        e.lastSenseThink = sTh;
        e.sThinkBody.textContent = sTh ?? "";
        e.sThink.style.display = sTh ? "" : "none";
      }
      // argument 结构化：对象→键值表 / 非对象 JSON→高亮 / 非法→原样
      const r = renderKV(sc.arguments || "");
      const cls = `sense-args ${r.mode}`;
      if (cls !== e.lastArgsCls) { e.argsEl.className = cls; e.lastArgsCls = cls; }
      if (r.mode === "kv") { if (e.argsEl.innerHTML !== r.html) e.argsEl.innerHTML = r.html; }
      else if (r.mode === "json") { const html = highlightJSON(r.text); if (e.argsEl.innerHTML !== html) e.argsEl.innerHTML = html; }
      else if (e.argsEl.textContent !== r.text) e.argsEl.textContent = r.text;
      e.statusEl.textContent = sc.status || "";
      // result 嵌套折叠（懒创建）：argument 后插分割线 + details[RESULT]，默认 closed
      const hasResult = (sc.status === "accepted" && sc.result != null) || (sc.status === "rejected" && sc.reason != null);
      if (hasResult && !e.resultWrap) {
        const rb = h("div", { class: "sense-result" });
        e.resultWrap = h("div", { class: "sense-result-wrap" }, rb);
        e.resultBody = rb;
        e.header.appendChild(h("hr", { class: "sense-sep" }));
        e.el.appendChild(e.resultWrap);
      }
      if (e.resultWrap) {
        if (sc.status === "rejected") {
          e.resultWrap.classList.add("rejected");
          e.resultBody.className = "sense-result raw rejected";
          if (e.resultBody.textContent !== sc.reason) e.resultBody.textContent = sc.reason ?? "";
        } else {
          e.resultWrap.classList.remove("rejected");
          const { ok: rOk, text: rText } = parseStyled(sc.result);
          e.resultBody.className = `sense-result ${rOk ? "json" : "raw"}`;
          if (rOk) { const html = highlightJSON(rText); if (e.resultBody.innerHTML !== html) e.resultBody.innerHTML = html; }
          else if (e.resultBody.textContent !== rText) e.resultBody.textContent = rText;
        }
      }
    });
  }

  function update(b) {
    el.classList.toggle("revoked", !!b.revoked);
    // 顶部 THINK = content 样式 thinking（sense cycle 的 thinking 已移入各 sense block）
    // sense_end 清空 transient / 新 cycle 开始 → 文本缩短：重置 thinkBody + lastThink，避免残留
    const t = b.thinking?.text ?? "";
    if (t.length < lastThink) {
      if (thinkBody) thinkBody.textContent = "";
      lastThink = 0;
    }
    if (t.length > lastThink) {
      ensureThinking();
      appendText(thinkBody, t.slice(lastThink));
      lastThink = t.length;
    }
    if (thinkDetails) {
      const empty = t.length === 0;
      thinkDetails.style.display = empty ? "none" : ""; // sense cycle 清空后隐藏顶部 THINK
      thinkDetails.open = !b.thinking?.done && !empty; // 流式中展开，thinking_end 后折叠
      // thinking 紧贴 content 上方（所有 sense block 之后），而非顶部：
      // content 样式 thinking 是最终回答的推理，须紧邻 content；sense 样式 transient 流式时也落在底部（下一动作发生处）。
      // sense block 也 insertBefore(senseEl, contentEl)，会把 thinkDetails 顶到最前 → 有内容时复位到 content 紧前。
      if (!empty && thinkDetails.nextElementSibling !== contentEl) {
        el.insertBefore(thinkDetails, contentEl);
      }
    }
    // thinking_end → sense_end（无 content_end）时 content 为空：隐藏占位，避免残留 ◆ 空行
    const hasContent = !!(b.content && b.content.text);
    contentEl.style.display = hasContent ? "" : "none";
    if (hasContent && b.content.text.length > lastContent) {
      appendText(contentEl, b.content.text.slice(lastContent));
      lastContent = b.content.text.length;
    }
    updateSense(b.senseCalls || []);
  }

  return { el, update };
}

function reverseFold(block) {
  const label = (n) => `▼ ${n} MESSAGE${n > 1 ? "S" : ""} REVOKED`;
  const summary = h("summary", {}, label(block.count));
  const el = h("details", { class: "reverse-fold", open: block.expanded }, summary);
  // 阻止原生 toggle，由 actions.toggleReverse → store → update 同步 el.open
  summary.addEventListener("click", (e) => { e.preventDefault(); actions.toggleReverse(block.id); });
  return {
    el,
    update: (b) => { el.open = b.expanded; const s = el.querySelector("summary"); if (s) s.textContent = label(b.count); },
  };
}
