/**
 * Bash 进程浮层面板：列出当前 chat 挂起的 execute_command 子进程 + 终止按钮。
 *
 * toggle 由 topbar PROC 按钮触发（actions.toggleProcessPanel → store.ui.processPanelOpen）；
 * 打开时 actions 自动 listBashProcesses 刷新；kill 成功后刷新（被杀进程从列表消失）。
 * 显隐由 update 据 processPanelOpen 控制 container.style.display；内容仅在打开时渲染。
 */
import { h } from "@web/lib/dom.js";
import { store } from "@web/core/store.js";
import { actions } from "@web/core/actions.js";
import { truncate, formatTime } from "@web/core/format.js";

export function mountProcessPanel(container) {
  const panel = h("div", { class: "process-panel" });

  function render() {
    const s = store.get();
    panel.innerHTML = "";

    panel.append(h("div", { class: "pp-head" },
      h("span", { class: "pp-title" }, `挂起进程 (${s.bashProcesses.length})`),
      h("button", { class: "btn pp-refresh", on: { click: () => actions.listBashProcesses() } }, "刷新"),
      h("button", { class: "btn", on: { click: () => actions.toggleProcessPanel() } }, "关闭"),
    ));

    if (s.bashProcesses.length === 0) {
      panel.append(h("div", { class: "pp-empty" }, "无挂起进程"));
      return;
    }

    const list = h("div", { class: "pp-list" });
    for (const p of s.bashProcesses) {
      list.append(h("div", { class: "pp-row" },
        h("span", { class: "pp-pid", title: "pid" }, String(p.pid)),
        h("span", { class: "pp-cmd", title: p.command }, truncate(p.command, 40)),
        h("span", { class: "pp-time", title: "启动时间" }, formatTime(p.startedAt)),
        p.killed
          ? h("span", { class: "badge badge-stale" }, "KILLED")
          : h("button", { class: "btn btn-danger pp-kill", on: { click: () => actions.killBashProcess(p.pid) } }, "终止"),
      ));
    }
    panel.append(list);
  }

  function update(s) {
    const open = !!s.ui.processPanelOpen;
    container.style.display = open ? "" : "none";
    if (open) render();
  }

  container.append(panel);
  store.subscribe(update);
  update(store.get());
}
