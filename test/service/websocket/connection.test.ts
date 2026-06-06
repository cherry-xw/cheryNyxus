import { describe, it, expect, vi, beforeEach } from "vitest";
import { RpcClient } from "@test/helpers/rpcClient.js";

vi.mock("@/db/approval.js", () => ({
  approvalRepo: {
    update: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@/service/approval/manager.js", () => ({
  approvalManager: {
    cleanupSoul: vi.fn().mockResolvedValue(undefined),
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
    expect(state.soulId).toBeUndefined();
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

  it("should set soulId on state", () => {
    const ws = createMockWs();
    manager.create(ws);
    manager.setSoul(ws, "soul-1");
    expect(manager.get(ws)!.soulId).toBe("soul-1");
  });

  it("should ignore setSoul for unknown ws", () => {
    expect(() => manager.setSoul(createMockWs(), "soul-1")).not.toThrow();
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

  it("should set request approvalId", () => {
    const ws = createMockWs();
    manager.create(ws);
    manager.addPendingRequest(ws, "req-1");
    manager.setRequestApprovalId(ws, "req-1", "approval-1");
    expect(manager.get(ws)!.pendingRequests.get("req-1")!.approvalId).toBe("approval-1");
  });

  it("should start and trigger approval timeout", () => {
    vi.useFakeTimers();
    const ws = createMockWs();
    manager.create(ws);
    manager.addPendingRequest(ws, "req-1", 1000);
    manager.setRequestApprovalId(ws, "req-1", "approval-1");
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
    manager.setRequestApprovalId(ws, "req-1", "approval-1");
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
    manager.setRequestApprovalId(ws, "req-1", "approval-1");
    const cb = vi.fn();
    manager.startApprovalTimeout(ws, "req-1", cb);
    manager.removePendingRequest(ws, "req-1");
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
    expect(manager.get(ws)!.pendingRequests.has("req-1")).toBe(false);
    vi.useRealTimers();
  });

  it("should persist approval on close", async () => {
    const { approvalRepo } = await import("@/db/approval.js");
    const ws = createMockWs();
    manager.create(ws);
    manager.addPendingRequest(ws, "req-1");
    manager.setRequestApprovalId(ws, "req-1", "approval-1");
    await manager.close(ws);
    expect(approvalRepo.update).toHaveBeenCalledWith("approval-1", expect.objectContaining({ status: "pending" }));
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

  it("should call cleanupSoul on close when soulId set", async () => {
    const { approvalManager } = await import("@/service/approval/manager.js");
    const ws = createMockWs();
    manager.create(ws);
    manager.setSoul(ws, "soul-1");
    manager.addPendingRequest(ws, "req-1");
    await manager.close(ws);
    expect(approvalManager.cleanupSoul).toHaveBeenCalledWith("soul-1");
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

  it("getBySoulId returns matching connection", () => {
    const ws = createMockWs();
    manager.create(ws);
    manager.setSoul(ws, "soul-1");
    expect(manager.getBySoulId("soul-1")).toBeDefined();
    expect(manager.getBySoulId("soul-2")).toBeUndefined();
  });
});