import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WebSocket } from "ws";

// close() 会调 approvalManager.abort(pending.approvalId)，mock 掉以验证调用且不碰 core registry。
const approvalMock = vi.hoisted(() => ({ abort: vi.fn() }));
vi.mock("@/service/approval/manager.js", () => ({ approvalManager: approvalMock }));

import { ConnectionManager } from "@/service/websocket/connection.js";

function mockWs(): WebSocket {
  return {} as WebSocket;
}

describe("service/websocket/ConnectionManager", () => {
  let cm: ConnectionManager;

  beforeEach(() => {
    cm = new ConnectionManager();
    approvalMock.abort.mockClear();
  });

  describe("create / get / getAll", () => {
    it("create stores state keyed by ws and get retrieves it", () => {
      const ws = mockWs();
      const state = cm.create(ws);
      expect(state.id).toBeTruthy();
      expect(state.ws).toBe(ws);
      expect(state.pendingRequests).toBeInstanceOf(Map);
      expect(cm.get(ws)).toBe(state);
    });

    it("get returns undefined for unknown ws", () => {
      expect(cm.get(mockWs())).toBeUndefined();
    });

    it("getAll returns all created states", () => {
      cm.create(mockWs());
      cm.create(mockWs());
      expect(cm.getAll()).toHaveLength(2);
    });
  });

  describe("addPendingRequest", () => {
    it("stores pending with default approval timeout (900000ms)", () => {
      const ws = mockWs();
      cm.create(ws);
      expect(cm.addPendingRequest(ws, "req-1").approvalTimeoutMs).toBe(900000);
    });

    it("honors custom approval timeout", () => {
      const ws = mockWs();
      cm.create(ws);
      expect(cm.addPendingRequest(ws, "req-1", 5000).approvalTimeoutMs).toBe(5000);
    });

    it("throws when connection not found", () => {
      expect(() => cm.addPendingRequest(mockWs(), "req-1")).toThrow(/Connection not found/);
    });
  });

  describe("approval timeout lifecycle", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("startApprovalTimeout fires onTimeout after configured ms", () => {
      const ws = mockWs();
      cm.create(ws);
      cm.addPendingRequest(ws, "req-1", 1000);
      const onTimeout = vi.fn();
      cm.startApprovalTimeout(ws, "req-1", onTimeout);
      vi.advanceTimersByTime(999);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it("clearApprovalTimeout cancels the timer", () => {
      const ws = mockWs();
      cm.create(ws);
      cm.addPendingRequest(ws, "req-1", 1000);
      const onTimeout = vi.fn();
      cm.startApprovalTimeout(ws, "req-1", onTimeout);
      cm.clearApprovalTimeout(ws, "req-1");
      vi.advanceTimersByTime(2000);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("startApprovalTimeout is idempotent (no double fire)", () => {
      const ws = mockWs();
      cm.create(ws);
      cm.addPendingRequest(ws, "req-1", 1000);
      const onTimeout = vi.fn();
      cm.startApprovalTimeout(ws, "req-1", onTimeout);
      cm.startApprovalTimeout(ws, "req-1", onTimeout);
      vi.advanceTimersByTime(1000);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it("removePendingRequest clears timer and removes entry", () => {
      const ws = mockWs();
      const state = cm.create(ws);
      cm.addPendingRequest(ws, "req-1", 1000);
      cm.startApprovalTimeout(ws, "req-1", vi.fn());
      cm.removePendingRequest(ws, "req-1");
      expect(state.pendingRequests.has("req-1")).toBe(false);
    });
  });

  describe("setRequestApprovalId", () => {
    it("records approvalId on pending request", () => {
      const ws = mockWs();
      const state = cm.create(ws);
      cm.addPendingRequest(ws, "req-1");
      cm.setRequestApprovalId(ws, "req-1", "appr-1");
      expect(state.pendingRequests.get("req-1")?.approvalId).toBe("appr-1");
    });
  });

  describe("bindChatConnection / releaseChatConnection / forceReleaseChatConnection", () => {
    it("bind then re-bind same owner is allowed", () => {
      expect(() => cm.bindChatConnection("chat-1", "conn-A")).not.toThrow();
      expect(() => cm.bindChatConnection("chat-1", "conn-A")).not.toThrow();
    });

    it("bind from a different owner throws busy error", () => {
      cm.bindChatConnection("chat-1", "conn-A");
      expect(() => cm.bindChatConnection("chat-1", "conn-B")).toThrow(/busy/);
    });

    it("release only unbinds when connectionId matches owner", () => {
      cm.bindChatConnection("chat-1", "conn-A");
      cm.releaseChatConnection("chat-1", "conn-B"); // no-op (not owner)
      expect(() => cm.bindChatConnection("chat-1", "conn-C")).toThrow(/busy/);

      cm.releaseChatConnection("chat-1", "conn-A"); // owner releases
      expect(() => cm.bindChatConnection("chat-1", "conn-C")).not.toThrow();
    });

    it("forceRelease unbinds unconditionally (chat.abort cross-connection)", () => {
      cm.bindChatConnection("chat-1", "conn-A");
      cm.forceReleaseChatConnection("chat-1");
      expect(() => cm.bindChatConnection("chat-1", "conn-B")).not.toThrow();
    });
  });

  describe("close", () => {
    it("removes connection and releases owned chat bindings", async () => {
      const ws = mockWs();
      const state = cm.create(ws);
      cm.bindChatConnection("chat-1", state.id);
      await cm.close(ws);
      expect(cm.get(ws)).toBeUndefined();
      // chat binding released → new connection can bind
      expect(() => cm.bindChatConnection("chat-1", "new-conn")).not.toThrow();
    });

    it("is a no-op for unknown ws", async () => {
      await expect(cm.close(mockWs())).resolves.toBeUndefined();
    });

    it("aborts pending approvals on close", async () => {
      const ws = mockWs();
      cm.create(ws);
      cm.addPendingRequest(ws, "req-1");
      cm.setRequestApprovalId(ws, "req-1", "appr-1");
      await cm.close(ws);
      expect(approvalMock.abort).toHaveBeenCalledWith("appr-1");
      expect(cm.get(ws)).toBeUndefined();
    });
  });
});
