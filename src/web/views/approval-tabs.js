/**
 * 审批多 tab（并行）：interrupt 入 tab，accept/rejected 出 tab，每 tab 独立操作。
 * 填充 container（.approval-zone）。approvals 非空时 .active 显示。
 *
 * 面板 = 终端中断警报：抬头指示灯 + 命令栏（计数 + DISMISS RESOLVED 批量清退）
 *        + tab 行（右侧动作区始终占位：pending=闪烁警报点待决断，已决=常驻 × 清退）+ body。
 *        有 pending 时整框 CRT 呼吸警报（layout.css ap-alarm）；全已决回静态冷静。
 * 已决结果保留可复查，直至显式清退（× / DISMISS RESOLVED / 单条 DISMISS）。
 */
import { h, clear } from "@web/lib/dom.js";
import { store } from "@web/core/store.js";
import { actions } from "@web/core/actions.js";
import { renderKV, highlightJSON, prettyJSON, levelInfo } from "@web/core/format.js";

const reasonCache = new Map(); // approvalId → reason text（保留用户输入，跨重渲染）

export function mountApprovalTabs(container) {
  container.classList.add("approval-zone");
  const headerEl = h("div", { class: "approval-header" });
  const tabsEl = h("div", { class: "approval-tabs" });
  const bodyEl = h("div", { class: "approval-body" });
  container.append(headerEl, tabsEl, bodyEl);

  store.subscribe(update);
  update(store.get());

  function update(s) {
    const approvals = s.approvals;
    container.classList.toggle("active", approvals.length > 0);
    // 有 pending → 整框 CRT 呼吸警报（layout.css ap-alarm）；全已决 → 静态冷静
    const pending = approvals.filter((a) => a.status === "pending").length;
    container.classList.toggle("has-pending", pending > 0);
    if (approvals.length === 0) { clear(headerEl); clear(tabsEl); clear(bodyEl); return; }

    // active tab 兜底（ui 值失效时回退首个）
    const hasActive = s.ui.approvalActiveTab && approvals.some((a) => a.approvalId === s.ui.approvalActiveTab);
    const activeId = hasActive ? s.ui.approvalActiveTab : approvals[0].approvalId;
    if (!hasActive) { store.selectApprovalTab(activeId); return; }

    renderHeader(headerEl, approvals);
    renderTabs(tabsEl, approvals, activeId);
    renderBody(bodyEl, approvals.find((a) => a.approvalId === activeId));
  }

  function renderHeader(host, approvals) {
    const pending = approvals.filter((a) => a.status === "pending").length;
    const done = approvals.length - pending;
    clear(host);
    host.append(
      h("span", { class: "ap-title" }, pending > 0 ? "⚠ APPROVAL REQUIRED" : "▣ APPROVAL QUEUE"),
      h("span", { class: "ap-counts" },
        pending > 0 ? [h("span", { class: "num-pending" }, String(pending)), " PENDING"] : null,
        done > 0 ? [pending > 0 ? " · " : null, h("span", { class: "num-done" }, String(done)), " RESOLVED"] : null,
      ),
      h("span", { class: "ap-spacer" }),
      h("button", {
        class: "ap-dismiss", disabled: done === 0,
        on: { click: () => actions.dismissResolved() },
        title: done > 0 ? "清退所有已决审批" : "无已决审批",
      }, done > 0 ? `DISMISS RESOLVED · ${done}` : "NO RESOLVED")
    );
  }

  function renderTabs(host, approvals, activeId) {
    clear(host);
    for (const a of approvals) {
      const resolved = a.status !== "pending";
      // pending 靠右侧警报点（无左标）；已决左标 ✓/⊘ + 颜色
      const mark = a.status === "accepted" ? "✓" : a.status === "rejected" ? "⊘" : null;
      const tab = h("div", {
        class: `approval-tab ${a.status} ${a.approvalId === activeId ? "active" : ""}`,
        attrs: { title: resolved ? `${a.senseName} — ${a.status}（点击切换 · × 清退）` : `${a.senseName} — 等待审核` },
        on: { click: () => actions.selectApprovalTab(a.approvalId) },
      }, [
        mark ? h("span", { class: "ap-tab-mark" }, mark) : null,
        h("span", { class: "ap-tab-name" }, a.senseName),
        // 右侧动作区（始终占位）：pending=闪烁警报点（不可关，须先决断解锁服务端）；已决=常驻 × 清退
        resolved
          ? h("button", {
              class: "ap-tab-close", type: "button",
              attrs: { "aria-label": `清退 ${a.senseName}`, title: "清退此审批" },
              on: { click: (e) => { e.stopPropagation(); actions.closeApproval(a.approvalId); } },
            }, "×")
          : h("span", { class: "ap-tab-beacon", attrs: { title: "等待审核 — 先 accept/reject" } }),
      ]);
      host.appendChild(tab);
    }
  }

  function renderBody(host, a) {
    clear(host);
    if (!a) return;
    const li = levelInfo(a.level);
    const r = renderKV(a.arguments);
    const argsEl = h("div", { class: `ap-args ${r.mode}` });
    if (r.mode === "kv") argsEl.innerHTML = r.html;
    else if (r.mode === "json") argsEl.innerHTML = highlightJSON(r.text);
    else argsEl.textContent = r.text;

    host.append(
      h("div", { class: "ap-sense" },
        "⚙ ", a.senseName, " ",
        h("span", { class: `badge ${li.badge}` }, li.name),
        " ", h("span", { class: "sense-status" }, a.status.toUpperCase())
      ),
      argsEl
    );

    if (a.status === "accepted" && a.result != null) {
      const r = h("div", { class: "ap-result accepted" });
      r.textContent = typeof a.result === "string" ? a.result : prettyJSON(a.result);
      host.append(r);
    } else if (a.status === "rejected" && a.reason != null) {
      const r = h("div", { class: "ap-result rejected" });
      r.textContent = a.reason;
      host.append(r);
    }

    if (a.status === "pending") {
      const ta = h("textarea", { class: "approval-reason", attrs: { placeholder: "reason (optional, for reject)", rows: "2" } });
      ta.value = reasonCache.get(a.approvalId) ?? "";
      ta.addEventListener("input", () => reasonCache.set(a.approvalId, ta.value));
      host.append(
        ta,
        h("div", { class: "approval-actions" },
          h("button", { class: "btn btn-accept", on: { click: () => actions.approve(a.approvalId, "accept", reasonCache.get(a.approvalId)) } }, "ACCEPT"),
          h("button", { class: "btn btn-reject", on: { click: () => actions.approve(a.approvalId, "reject", reasonCache.get(a.approvalId)) } }, "REJECT")
        )
      );
    } else {
      // 已决：结果已展示可复查；右下角 DISMISS 单条清退（亦可 ✕ tab / 批量 DISMISS RESOLVED）
      host.append(h("div", { class: "approval-actions" },
        h("button", { class: "btn btn-dismiss", on: { click: () => actions.closeApproval(a.approvalId) } }, "DISMISS")
      ));
    }
  }
}
