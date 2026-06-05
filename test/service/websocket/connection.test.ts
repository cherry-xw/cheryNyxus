import { describe, it, expect, vi, beforeEach } from "vitest";
import { RpcClient } from "@test/helpers/rpcClient.js";

vi.mock("@/db/interrupt.js", () => ({
  interruptRepo: {
    update: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@/service/agent/interrupt.js", () => ({
  interruptManager: {
    cleanupSession: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("ConnectionManager", () => {
  let ConnectionManager: typeof import("@/service/websocket/connection.js").ConnectionManager;
  let manager: InstanceType<typeof ConnectionManager>;

  function createMockWs() {
    const listeners: Record<string, Function[]> = {};
    return {
      on: vi.fn((event: string, cb: Function) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(cb);
      }),
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
      listeners,
    } as any;
  }

  beforeEach(async () => {
    const mod = await import("@/service/websocket/connection.js");
    ConnectionManager = mod.ConnectionManager;
    manager = new ConnectionManager();
  });

  it("should create and store ConnectionState", () => {
    const ws = createMockWs();
    const state = manager.create(ws);
    expect(state.id).toBeDefined();
    expect(state.ws).toBe(ws);
    expect(state.sessionId).toBeUndefined();
    expect(state.pendingRequests).toBeInstanceOf(Map);
  });

  it("should get state for known ws", () => {
    const ws = createMockWs();
    manager.create(ws);
    expect(manager.get(ws)).toBeDefined();
  });

  it("should return undefined for unknown ws", () => {
    expect(manager.get(createMockWs())).toBeUndefined();
  });

  it("should set sessionId on state", () => {
    const ws = createMockWs();
    manager.create(ws);
    manager.setSession(ws, "sess-1");
    expect(manager.get(ws)!.sessionId).toBe("sess-1");
  });

  it("should ignore setSession for unknown ws", () => {
    expect(() => manager.setSession(createMockWs(), "sess-1")).not.toThrow();
  });

  it("should add pending request", () => {
    const ws = createMockWs();
    manager.create(ws);
    const pending = manager.addPendingRequest(ws, "req-1");
    expect(pending.requestId).toBe("req-1");
    expect(pending.approvalTimeoutMs).toBe(300000); // 默认 5 分钟
    expect(manager.get(ws)!.pendingRequests.has("req-1")).toBe(true);
  });

  it("should use custom approval timeout", () => {
    const ws = createMockWs();
    manager.create(ws);
    const pending = manager.addPendingRequest(ws, "req-1", 60000);
    expect(pending.approvalTimeoutMs).toBe(60000);
  });

  it("should throw for unknown connection on addPendingRequest", () => {
    expect(() => manager.addPendingRequest(createMockWs(), "req-1")).toThrow("Connection not found");
  });

  it("should set request generator", () => {
    const ws = createMockWs();
    manager.create(ws);
    manager.addPendingRequest(ws, "req-1");
    const gen = (async function* () { yield 1; })();
    manager.setRequestGenerator(ws, "req-1", gen);
    expect(manager.get(ws)!.pendingRequests.get("req-1")!.generator).toBe(gen);
  });

  it("should set request interruptId", () => {
    const ws = createMockWs();
    manager.create(ws);
    manager.addPendingRequest(ws, "req-1");
    manager.setRequestInterruptId(ws, "req-1", "int-1");
    expect(manager.get(ws)!.pendingRequests.get("req-1")!.interruptId).toBe("int-1");
  });

  it("should start and trigger approval timeout", () => {
    vi.useFakeTimers();
    const ws = createMockWs();
    manager.create(ws);
    manager.addPendingRequest(ws, "req-1", 1000);
    manager.setRequestInterruptId(ws, "req-1", "int-1");
    const cb = vi.fn();
    manager.startApprovalTimeout(ws, "req-1", cb);
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("should clear approval timeout before it fires", () => {
    vi.useFakeTimers();
    const ws = createMockWs();
    manager.create(ws);
    manager.addPendingRequest(ws, "req-1", 1000);
    manager.setRequestInterruptId(ws, "req-1", "int-1");
    const cb = vi.fn();
    manager.startApprovalTimeout(ws, "req-1", cb);
    manager.clearApprovalTimeout(ws, "req-1");
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("should remove pending request and clear approval timeout", () => {
    vi.useFakeTimers();
    const ws = createMockWs();
    manager.create(ws);
    manager.addPendingRequest(ws, "req-1", 1000);
    manager.setRequestInterruptId(ws, "req-1", "int-1");
    const cb = vi.fn();
    manager.startApprovalTimeout(ws, "req-1", cb);
    manager.removePendingRequest(ws, "req-1");
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
    expect(manager.get(ws)!.pendingRequests.has("req-1")).toBe(false);
    vi.useRealTimers();
  });

  it("should persist interrupt on close", async () => {
    const { interruptRepo } = await import("@/db/interrupt.js");
    const ws = createMockWs();
    manager.create(ws);
    manager.addPendingRequest(ws, "req-1");
    manager.setRequestInterruptId(ws, "req-1", "int-1");
    await manager.close(ws);
    expect(interruptRepo.update).toHaveBeenCalledWith("int-1", expect.objectContaining({ status: "pending" }));
  });

  it("should terminate generator on close", async () => {
    const ws = createMockWs();
    manager.create(ws);
    manager.addPendingRequest(ws, "req-1");
    const gen = (async function* () { yield 1; })();
    const returnSpy = vi.spyOn(gen, "return");
    manager.setRequestGenerator(ws, "req-1", gen);
    await manager.close(ws);
    expect(returnSpy).toHaveBeenCalled();
  });

  it("should call cleanupSession on close when sessionId set", async () => {
    const { interruptManager } = await import("@/service/agent/interrupt.js");
    const ws = createMockWs();
    manager.create(ws);
    manager.setSession(ws, "sess-1");
    manager.addPendingRequest(ws, "req-1");
    await manager.close(ws);
    expect(interruptManager.cleanupSession).toHaveBeenCalledWith("sess-1", "Connection closed");
  });

  it("should remove connection from map on close", async () => {
    const ws = createMockWs();
    manager.create(ws);
    await manager.close(ws);
    expect(manager.get(ws)).toBeUndefined();
  });

  it("should ignore close for unknown ws", async () => {
    await expect(manager.close(createMockWs())).resolves.toBeUndefined();
  });

  it("getAll returns all connections", () => {
    manager.create(createMockWs());
    manager.create(createMockWs());
    manager.create(createMockWs());
    expect(manager.getAll()).toHaveLength(3);
  });

  it("getBySessionId returns matching connection", () => {
    const ws = createMockWs();
    manager.create(ws);
    manager.setSession(ws, "sess-1");
    expect(manager.getBySessionId("sess-1")).toBeDefined();
    expect(manager.getBySessionId("sess-2")).toBeUndefined();
  });
});