import { describe, it, expect, vi } from "vitest";

vi.mock("@/service/message/router.js", () => ({
  createRouter: vi.fn(() => ({ register: vi.fn(), handle: vi.fn() })),
}));

vi.mock("@/service/agent/index.js", () => ({
  registerAgentHandlers: vi.fn(),
}));

vi.mock("@/service/websocket/index.js", () => ({
  createWebSocketServer: vi.fn(() => ({ close: vi.fn() })),
}));

describe("startService", () => {
  it("should create router, register handlers, and create WSS", async () => {
    const { startService } = await import("@/service/index.js");
    const { createRouter } = await import("@/service/message/router.js");
    const { registerAgentHandlers } = await import("@/service/agent/index.js");
    const { createWebSocketServer } = await import("@/service/websocket/index.js");

    startService(9090);

    expect(createRouter).toHaveBeenCalled();
    expect(registerAgentHandlers).toHaveBeenCalledWith(expect.any(Object));
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
    expect(mod.createRpcRequest).toBeDefined();
    expect(mod.Method).toBeDefined();
    expect(mod.EventType).toBeDefined();
  });
});
