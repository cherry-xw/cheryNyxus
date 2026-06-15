import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/service/message/router.js", () => ({ createRouter: vi.fn() }));
vi.mock("@/service/websocket/index.js", () => ({ createWebSocketServer: vi.fn() }));
vi.mock("@/service/brain/list.js", () => ({ registerBrainHandlers: vi.fn() }));
vi.mock("@/service/sense/list.js", () => ({ registerSenseHandlers: vi.fn() }));
vi.mock("@/service/runtime/set.js", () => ({ registerRuntimeSetHandlers: vi.fn() }));
vi.mock("@/service/chat/send.js", () => ({ registerChatHandlers: vi.fn() }));
vi.mock("@/service/chat/handler.js", () => ({ registerChatManageHandlers: vi.fn() }));

import { startService } from "@/service/index.js";
import { createRouter } from "@/service/message/router.js";
import { createWebSocketServer } from "@/service/websocket/index.js";
import { registerBrainHandlers } from "@/service/brain/list.js";
import { registerSenseHandlers } from "@/service/sense/list.js";
import { registerRuntimeSetHandlers } from "@/service/runtime/set.js";
import { registerChatHandlers } from "@/service/chat/send.js";
import { registerChatManageHandlers } from "@/service/chat/handler.js";

describe("service/index startService", () => {
  beforeEach(() => {
    vi.mocked(createRouter).mockReset();
    vi.mocked(createWebSocketServer).mockReset();
    vi.mocked(registerBrainHandlers).mockReset();
    vi.mocked(registerSenseHandlers).mockReset();
    vi.mocked(registerRuntimeSetHandlers).mockReset();
    vi.mocked(registerChatHandlers).mockReset();
    vi.mocked(registerChatManageHandlers).mockReset();
    vi.mocked(createWebSocketServer).mockReturnValue({ close: () => undefined } as never);
  });

  it("creates router, registers all handlers, starts ws server", () => {
    const fakeRouter = {};
    vi.mocked(createRouter).mockReturnValue(fakeRouter as never);
    startService(1234);
    expect(registerBrainHandlers).toHaveBeenCalledWith(fakeRouter);
    expect(registerSenseHandlers).toHaveBeenCalledWith(fakeRouter);
    expect(registerRuntimeSetHandlers).toHaveBeenCalledWith(fakeRouter);
    expect(registerChatHandlers).toHaveBeenCalledWith(fakeRouter);
    expect(registerChatManageHandlers).toHaveBeenCalledWith(fakeRouter);
    expect(createWebSocketServer).toHaveBeenCalledWith({ port: 1234, router: fakeRouter });
  });

  it("re-exports createWebSocketServer, createRouter and message types", async () => {
    const mod = await import("@/service/index.js");
    expect(typeof mod.createWebSocketServer).toBe("function");
    expect(typeof mod.createRouter).toBe("function");
    expect(typeof mod.createRequest).toBe("function");
    expect(typeof mod.Method).toBe("object");
  });
});
