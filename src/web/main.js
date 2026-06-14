/**
 * 应用入口：装配布局骨架 + 各 view mount + 自动连接默认 WS。
 *
 * 布局：#app > topbar + .main(.chat-zone[chat-scroll-wrap(chat-messages + minimap) + approval-zone + input-bar] + .chunk-panel)
 */
import { h, el } from "@web/lib/dom.js";
import { actions } from "@web/core/actions.js";
import { mountTopbar } from "@web/views/topbar.js";
import { mountChatPanel } from "@web/views/chat-panel.js";
import { mountApprovalTabs } from "@web/views/approval-tabs.js";
import { mountInputBar } from "@web/views/input-bar.js";
import { mountChunkPanel } from "@web/views/chunk-panel.js";
import { mountMinimap } from "@web/views/minimap.js";

const app = el("#app");

// 布局骨架（各 view mount 填充并赋予 class）
const topbar = h("div");
const chatMessages = h("div");
const minimap = h("div");
const chatScrollWrap = h("div", { class: "chat-scroll-wrap" }, chatMessages, minimap);
const approvalZone = h("div");
const inputBar = h("div");
const chatZone = h("div", { class: "chat-zone" }, chatScrollWrap, approvalZone, inputBar);
const chunkPanel = h("div");
const main = h("div", { class: "main" }, chatZone, chunkPanel);

app.append(topbar, main);

mountTopbar(topbar);
mountChatPanel(chatMessages);
mountMinimap(minimap, chatMessages);
mountApprovalTabs(approvalZone);
mountInputBar(inputBar);
mountChunkPanel(chunkPanel);

// 自动连接默认地址（服务未起时 onclose 回 disconnected，用户起服务后手动 CONNECT）
actions.connect("ws://localhost:8080");
