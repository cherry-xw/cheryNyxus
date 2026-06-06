import { describe, it, expect, vi } from "vitest";

vi.mock("@/service/message/router.js", () => ({
  createRouter: vi.fn(() => ({ register: vi.fn(), handle: vi.fn() })),
}));

vi.mock("@/service/soul/lifecycle.js", () => ({
  registerSoulHandlers: vi.fn(),
}));

vi.mock("@/service/chat/send.js", () => ({
  registerChatHandlers: vi.fn(),
}));

vi.mock("@/service/chat/handler.js", () => ({
  registerChatManageHandlers: vi.fn(),
}));

vi.mock("@/service/websocket/index.js", () => ({
  createWebSocketServer: vi.fn(() => ({ close: vi.fn() })),
}));

describe("startService", () => {
  it("should create router, register handlers, and create WSS", async () => {
    const { startService } = await import("@/service/index.js");
    const { createRouter } = await import("@/service/message/router.js");
    const { registerSoulHandlers } = await import("@/service/soul/lifecycle.js");
    const { registerChatHandlers } = await import("@/service/chat/send.js");
    const { registerChatManageHandlers } = await import("@/service/chat/handler.js");
    const { createWebSocketServer } = await import("@/service/websocket/index.js");

    startService(9090);

    expect(createRouter).toHaveBeenCalled();
    expect(registerSoulHandlers).toHaveBeenCalledWith(expect.any(Object));
    expect(registerChatHandlers).toHaveBeenCalledWith(expect.any(Object));
    expect(registerChatManageHandlers).toHaveBeenCalledWith(expect.any(Object));
    expect(createWebSocketServer).toHaveBeenCalledWith({
      port: 9090,
      router: expect.any(Object),
    });
  });

  it("should re-export createWebSocketServer", async () => {
    const mod = await import("@/service/index.js");
    expect(mod.createWebSocketServer).toBeDefined();
  });

  it("should re-export createRouter", async () => {
    const mod = await import("@/service/index.js");
    expect(mod.createRouter).toBeDefined();
  });

  it("should re-export message types", async () => {
    const mod = await import("@/service/index.js");
    expect(mod.createRequest).toBeDefined();
    expect(mod.Method).toBeDefined();
    expect(mod.createResponse).toBeDefined();
    expect(mod.createChunk).toBeDefined();
    expect(mod.createNotification).toBeDefined();
  });
});