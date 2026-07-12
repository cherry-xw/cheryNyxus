import { beforeEach, describe, expect, it, vi } from "vitest";

const { builder, ws } = vi.hoisted(() => ({
  builder: {
    isRunning: vi.fn(),
    appendRoleReply: vi.fn(),
  },
  ws: { readyState: 1, OPEN: 1, send: vi.fn() },
}));

vi.mock("@/db/chat.js", () => ({
  addMessage: vi.fn(),
  updateChatMetadata: vi.fn(),
  getChat: vi.fn(),
  listAllChats: vi.fn(),
  getMessages: vi.fn(),
  parseMessageRow: vi.fn(),
}));
vi.mock("@/service/chat/runtime.js", () => ({
  ensureChat: vi.fn(),
  abortChatRuntime: vi.fn(),
}));
vi.mock("@/service/websocket/connection.js", () => ({
  connectionManager: { findOwnerWsByChatId: vi.fn() },
}));
vi.mock("@/service/websocket/transport.js", () => ({
  transport: { encode: vi.fn((value) => value) },
}));
vi.mock("@/service/message/types.js", () => ({
  createNotification: vi.fn((_type, _requestId, data) => ({ data })),
}));
vi.mock("@/agent/spawnBroker.js", () => ({
  clearWaitedChild: vi.fn(),
  registerWaitedChild: vi.fn(),
}));
vi.mock("@/utils/logger/index.js", () => ({ logger: { event: vi.fn() } }));

import { addMessage, getChat, updateChatMetadata } from "@/db/chat.js";
import { ensureChat } from "@/service/chat/runtime.js";
import { connectionManager } from "@/service/websocket/connection.js";
import { clearWaitedChild } from "@/agent/spawnBroker.js";
import { wakeParent } from "@/service/chat/wake.js";

describe("wakeParent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getChat).mockImplementation((chatId: string) => (
      chatId === "parent" ? { id: "parent" } as never : undefined
    ));
    vi.mocked(ensureChat).mockResolvedValue(builder as never);
    vi.mocked(builder.appendRoleReply).mockReturnValue("role-message");
    vi.mocked(connectionManager.findOwnerWsByChatId).mockReturnValue(undefined as never);
  });

  it("persists the reply before consuming wait and records offline parent recovery", async () => {
    vi.mocked(builder.isRunning).mockReturnValue(false);

    await wakeParent("parent", "child", "researcher", "done");

    expect(addMessage).toHaveBeenCalledWith("role-message", "parent", {
      role: "role",
      content: "done",
    });
    expect(clearWaitedChild).toHaveBeenCalledWith("child");
    expect(updateChatMetadata).toHaveBeenCalledWith("child", { wait: false });
    expect(updateChatMetadata).toHaveBeenCalledWith("parent", { resumePending: true });
  });

  it("does not schedule another resume while the parent loop is already running", async () => {
    vi.mocked(builder.isRunning).mockReturnValue(true);

    await wakeParent("parent", "child", "researcher", "done");

    expect(updateChatMetadata).not.toHaveBeenCalledWith("parent", { resumePending: true });
  });
});
