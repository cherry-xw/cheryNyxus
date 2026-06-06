import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WebSocket, WebSocketServer } from "ws";

// Mock dependencies before importing
let connectionHandler: ((ws: WebSocket) => void) | undefined;

const mockConnectionState = {
  id: "conn-1",
  ws: null as WebSocket | null,
  soulId: undefined as string | undefined,
  pendingRequests: new Map<string, { requestId: string; approvalId?: string }>(),
};

const mockConnectionManager = {
  create: vi.fn((ws: WebSocket) => {
    mockConnectionState.ws = ws;
    mockConnectionState.soulId = undefined;
    mockConnectionState.pendingRequests.clear();
    return mockConnectionState;
  }),
  get: vi.fn(() => mockConnectionState),
  getBySoulId: vi.fn(),
  addPendingRequest: vi.fn((ws: WebSocket, requestId: string) => {
    mockConnectionState.pendingRequests.set(requestId, { requestId });
    return { requestId, startTime: Date.now() };
  }),
  setRequestGenerator: vi.fn(),
  setRequestApprovalId: vi.fn((ws: WebSocket, requestId: string, approvalId: string) => {
    const pending = mockConnectionState.pendingRequests.get(requestId);
    if (pending) {
      pending.approvalId = approvalId;
    }
  }),
  startApprovalTimeout: vi.fn(),
  clearApprovalTimeout: vi.fn(),
  removePendingRequest: vi.fn((ws: WebSocket, requestId: string) => {
    mockConnectionState.pendingRequests.delete(requestId);
  }),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockWss = {
  on: vi.fn((event: string, cb: Function) => {
    if (event === "connection") connectionHandler = cb;
  }),
  close: vi.fn(),
};

// Use class syntax for constructor mock
vi.mock("ws", () => ({
  WebSocketServer: vi.fn().mockImplementation(function (this: typeof mockWss, _config: { port: number }) {
    return mockWss;
  }),
  WebSocket: vi.fn(),
}));

vi.mock("@/service/websocket/transport.js", () => ({
  transport: {
    parseMessage: vi.fn((data: string | Buffer) => {
      const str = typeof data === "string" ? data : data.toString("utf-8");
      return JSON.parse(str);
    }),
    serializeMessage: vi.fn((msg: unknown) => JSON.stringify(msg)),
    encode: vi.fn((event: unknown) => Buffer.from(JSON.stringify(event))),
  },
}));

vi.mock("@/service/websocket/connection.js", () => ({
  connectionManager: mockConnectionManager,
}));

vi.mock("@/service/message/index.js", () => ({
  RpcRouter: vi.fn(),
  createResponse: vi.fn((id, success, data, error) => ({ id, success, data, error })),
  createChunk: vi.fn(),
  createNotification: vi.fn(),
  createError: vi.fn((code, message) => ({ code, message })),
  ErrorCode: { INTERNAL: -32603, TIMEOUT: -32001, METHOD_NOT_FOUND: -32601 },
  isRpcRequest: vi.fn((msg) => msg && typeof msg.method === "string"),
}));

vi.mock("@/utils/generator.js", () => ({
  isAsyncGenerator: vi.fn((obj) => obj && typeof obj[Symbol.asyncIterator] === "function"),
}));

describe("createWebSocketServer", () => {
  let createWebSocketServer: typeof import("@/service/websocket/index.js").createWebSocketServer;
  let connectionManager: typeof import("@/service/websocket/index.js").connectionManager;
  let transport: typeof import("@/service/websocket/transport.js").transport;
  let isRpcRequest: ReturnType<typeof vi.fn>;
  let isAsyncGenerator: ReturnType<typeof vi.fn>;
  let WebSocketServer: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    connectionHandler = undefined;
    mockConnectionState.pendingRequests.clear();

    // Re-import to reset module state
    vi.resetModules();

    // Import mocked modules
    const wsMod = await import("ws");
    WebSocketServer = wsMod.WebSocketServer as ReturnType<typeof vi.fn>;

    const transportMod = await import("@/service/websocket/transport.js");
    transport = transportMod.transport;

    const messageMod = await import("@/service/message/index.js");
    isRpcRequest = messageMod.isRpcRequest as ReturnType<typeof vi.fn>;

    const genMod = await import("@/utils/generator.js");
    isAsyncGenerator = genMod.isAsyncGenerator as ReturnType<typeof vi.fn>;

    const mod = await import("@/service/websocket/index.js");
    createWebSocketServer = mod.createWebSocketServer;
    connectionManager = mod.connectionManager;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("server initialization", () => {
    it("should create WebSocketServer with port", async () => {
      const mockRouter = { handle: vi.fn() };

      createWebSocketServer({ port: 8080, router: mockRouter });

      expect(WebSocketServer).toHaveBeenCalledWith({ port: 8080 });
      expect(connectionHandler).toBeDefined();
    });

    it("should register connection handler on WSS", async () => {
      const mockRouter = { handle: vi.fn() };

      createWebSocketServer({ port: 0, router: mockRouter });

      expect(mockWss.on).toHaveBeenCalledWith("connection", expect.any(Function));
      expect(connectionHandler).toBeDefined();
    });
  });

  describe("connection handling", () => {
    it("should create connection state on new connection", async () => {
      const mockRouter = { handle: vi.fn() };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      expect(mockConnectionManager.create).toHaveBeenCalledWith(mockWs);
    });

    it("should register message, close, error handlers on ws", async () => {
      const mockRouter = { handle: vi.fn() };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      expect(mockWs.on).toHaveBeenCalledWith("message", expect.any(Function));
      expect(mockWs.on).toHaveBeenCalledWith("close", expect.any(Function));
      expect(mockWs.on).toHaveBeenCalledWith("error", expect.any(Function));
    });

    it("should call connectionManager.close on ws close", async () => {
      const mockRouter = { handle: vi.fn() };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      // Get close handler
      const closeCall = mockWs.on.mock.calls.find((c) => c[0] === "close");
      expect(closeCall).toBeDefined();
      const closeHandler = closeCall![1] as () => void;

      await closeHandler();

      expect(mockConnectionManager.close).toHaveBeenCalledWith(mockWs);
    });

    it("should log error on ws error", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mockRouter = { handle: vi.fn() };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      // Get error handler
      const errorCall = mockWs.on.mock.calls.find((c) => c[0] === "error");
      expect(errorCall).toBeDefined();
      const errorHandler = errorCall![1] as (err: Error) => void;

      errorHandler(new Error("test error"));

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("WebSocket 错误"),
        "test error"
      );

      consoleSpy.mockRestore();
    });
  });

  describe("message handling", () => {
    it("should handle valid RPC request", async () => {
      const mockRouter = { handle: vi.fn().mockResolvedValue({ id: "1", success: true }) };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      // Get message handler
      const msgCall = mockWs.on.mock.calls.find((c) => c[0] === "message");
      const messageHandler = msgCall![1] as (data: Buffer) => void;

      const request = { id: "req-1", method: "test.method", params: {} };
      isRpcRequest.mockReturnValue(true);

      messageHandler(Buffer.from(JSON.stringify(request)));

      // Wait for async handling
      await new Promise((r) => setTimeout(r, 10));

      expect(mockRouter.handle).toHaveBeenCalled();
      expect(mockConnectionManager.addPendingRequest).toHaveBeenCalled();
    });

    it("should handle non-RPC message with error", async () => {
      const mockRouter = { handle: vi.fn() };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      const msgCall = mockWs.on.mock.calls.find((c) => c[0] === "message");
      const messageHandler = msgCall![1] as (data: Buffer) => void;

      isRpcRequest.mockReturnValue(false);

      messageHandler(Buffer.from('{"invalid": true}'));

      await new Promise((r) => setTimeout(r, 10));

      expect(mockWs.send).toHaveBeenCalled();
      const sentData = mockWs.send.mock.calls[0][0];
      const parsed = JSON.parse(sentData);
      expect(parsed.success).toBe(false);
    });

    it("should handle message parsing error", async () => {
      const mockRouter = { handle: vi.fn() };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      const msgCall = mockWs.on.mock.calls.find((c) => c[0] === "message");
      const messageHandler = msgCall![1] as (data: Buffer) => void;

      // Make parseMessage throw
      transport.parseMessage.mockImplementationOnce(() => {
        throw new Error("parse error");
      });

      messageHandler(Buffer.from("invalid json"));

      await new Promise((r) => setTimeout(r, 10));

      expect(mockWs.send).toHaveBeenCalled();
    });

    it("should handle message parsing error without request id", async () => {
      const mockRouter = { handle: vi.fn() };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      const msgCall = mockWs.on.mock.calls.find((c) => c[0] === "message");
      const messageHandler = msgCall![1] as (data: Buffer) => void;

      // First call throws, second call returns object without id
      transport.parseMessage
        .mockImplementationOnce(() => {
          throw new Error("parse error");
        })
        .mockReturnValueOnce({});

      messageHandler(Buffer.from("invalid"));

      await new Promise((r) => setTimeout(r, 10));

      expect(mockWs.send).toHaveBeenCalled();
    });
  });

  describe("request handling", () => {
    it("should handle regular (non-streaming) request", async () => {
      const mockRouter = {
        handle: vi.fn().mockResolvedValue({
          id: "req-1",
          success: true,
          data: { result: "ok" },
        }),
      };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      const msgCall = mockWs.on.mock.calls.find((c) => c[0] === "message");
      const messageHandler = msgCall![1] as (data: Buffer) => void;

      const request = { id: "req-1", method: "test.method", params: {} };
      isRpcRequest.mockReturnValue(true);

      messageHandler(Buffer.from(JSON.stringify(request)));

      await new Promise((r) => setTimeout(r, 10));

      expect(mockRouter.handle).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          connectionId: "conn-1",
          sendChunk: expect.any(Function),
          sendNotification: expect.any(Function),
        })
      );
      expect(mockConnectionManager.removePendingRequest).toHaveBeenCalled();
    });

    it("should sync soulId to connectionState when handler sets it", async () => {
      const mockRouter = {
        handle: vi.fn().mockImplementation((req, ctx) => {
          ctx.soulId = "new-soul-id";
          return { id: req.id, success: true };
        }),
      };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      const msgCall = mockWs.on.mock.calls.find((c) => c[0] === "message");
      const messageHandler = msgCall![1] as (data: Buffer) => void;

      const request = { id: "req-1", method: "soul.create", params: {} };
      isRpcRequest.mockReturnValue(true);

      messageHandler(Buffer.from(JSON.stringify(request)));

      await new Promise((r) => setTimeout(r, 10));

      expect(mockConnectionState.soulId).toBe("new-soul-id");
    });

    it("should handle streaming request (async generator)", async () => {
      async function* mockGenerator() {
        yield { kind: "chunk", type: "stream", requestId: "req-1", data: { content: "hello" } };
        yield { kind: "notification", type: "interrupt", requestId: "req-1", data: {} };
        return { id: "req-1", success: true };
      }

      const mockRouter = {
        handle: vi.fn().mockReturnValue(mockGenerator()),
      };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      const msgCall = mockWs.on.mock.calls.find((c) => c[0] === "message");
      const messageHandler = msgCall![1] as (data: Buffer) => void;

      const request = { id: "req-1", method: "chat.send", params: {} };
      isRpcRequest.mockReturnValue(true);
      isAsyncGenerator.mockReturnValue(true);

      messageHandler(Buffer.from(JSON.stringify(request)));

      await new Promise((r) => setTimeout(r, 50));

      expect(mockConnectionManager.setRequestGenerator).toHaveBeenCalled();
      expect(mockWs.send).toHaveBeenCalled();
    });

    it("should handle interrupt notification and start approval timeout", async () => {
      async function* mockGenerator() {
        yield {
          kind: "notification",
          type: "interrupt",
          requestId: "req-1",
          data: { approvalId: "approval-123" },
        };
        return { id: "req-1", success: true };
      }

      const mockRouter = {
        handle: vi.fn().mockReturnValue(mockGenerator()),
      };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      const msgCall = mockWs.on.mock.calls.find((c) => c[0] === "message");
      const messageHandler = msgCall![1] as (data: Buffer) => void;

      const request = { id: "req-1", method: "chat.send", params: {} };
      isRpcRequest.mockReturnValue(true);
      isAsyncGenerator.mockReturnValue(true);

      messageHandler(Buffer.from(JSON.stringify(request)));

      await new Promise((r) => setTimeout(r, 50));

      expect(mockConnectionManager.setRequestApprovalId).toHaveBeenCalledWith(
        expect.anything(),
        "req-1",
        "approval-123"
      );
      expect(mockConnectionManager.startApprovalTimeout).toHaveBeenCalled();
    });

    it("should clear approval timeout after request completes", async () => {
      async function* mockGenerator() {
        yield { kind: "chunk", type: "stream", requestId: "req-1", data: {} };
        return { id: "req-1", success: true };
      }

      const mockRouter = {
        handle: vi.fn().mockReturnValue(mockGenerator()),
      };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      const msgCall = mockWs.on.mock.calls.find((c) => c[0] === "message");
      const messageHandler = msgCall![1] as (data: Buffer) => void;

      const request = { id: "req-1", method: "chat.send", params: {} };
      isRpcRequest.mockReturnValue(true);
      isAsyncGenerator.mockReturnValue(true);

      messageHandler(Buffer.from(JSON.stringify(request)));

      await new Promise((r) => setTimeout(r, 50));

      expect(mockConnectionManager.clearApprovalTimeout).toHaveBeenCalled();
      expect(mockConnectionManager.removePendingRequest).toHaveBeenCalled();
    });

    it("should handle generator with return value", async () => {
      async function* mockGenerator() {
        return { id: "req-1", success: true, data: { chatId: "chat-1" } };
      }

      const mockRouter = {
        handle: vi.fn().mockReturnValue(mockGenerator()),
      };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      const msgCall = mockWs.on.mock.calls.find((c) => c[0] === "message");
      const messageHandler = msgCall![1] as (data: Buffer) => void;

      const request = { id: "req-1", method: "chat.send", params: {} };
      isRpcRequest.mockReturnValue(true);
      isAsyncGenerator.mockReturnValue(true);

      messageHandler(Buffer.from(JSON.stringify(request)));

      await new Promise((r) => setTimeout(r, 50));

      // Should send the return value
      expect(transport.serializeMessage).toHaveBeenCalled();
    });

    it("should handle generator without return value", async () => {
      async function* mockGenerator() {
        yield { kind: "chunk", type: "stream", requestId: "req-1", data: {} };
        // No return value - generator ends without explicit return
      }

      const mockRouter = {
        handle: vi.fn().mockReturnValue(mockGenerator()),
      };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      const msgCall = mockWs.on.mock.calls.find((c) => c[0] === "message");
      const messageHandler = msgCall![1] as (data: Buffer) => void;

      const request = { id: "req-1", method: "chat.send", params: {} };
      isRpcRequest.mockReturnValue(true);
      isAsyncGenerator.mockReturnValue(true);

      messageHandler(Buffer.from(JSON.stringify(request)));

      await new Promise((r) => setTimeout(r, 50));

      // Should still complete without error
      expect(mockConnectionManager.removePendingRequest).toHaveBeenCalled();
    });

    it("should handle interrupt notification without approvalId data", async () => {
      async function* mockGenerator() {
        yield {
          kind: "notification",
          type: "interrupt",
          requestId: "req-1",
          data: {}, // No approvalId
        };
        return { id: "req-1", success: true };
      }

      const mockRouter = {
        handle: vi.fn().mockReturnValue(mockGenerator()),
      };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      const msgCall = mockWs.on.mock.calls.find((c) => c[0] === "message");
      const messageHandler = msgCall![1] as (data: Buffer) => void;

      const request = { id: "req-1", method: "chat.send", params: {} };
      isRpcRequest.mockReturnValue(true);
      isAsyncGenerator.mockReturnValue(true);

      messageHandler(Buffer.from(JSON.stringify(request)));

      await new Promise((r) => setTimeout(r, 50));

      // Should not set approval id or start timeout
      expect(mockConnectionManager.setRequestApprovalId).not.toHaveBeenCalled();
      expect(mockConnectionManager.startApprovalTimeout).not.toHaveBeenCalled();
    });
  });

  describe("approval timeout callback", () => {
    it("should close connection on approval timeout", async () => {
      let timeoutCallback: (() => Promise<void>) | undefined;

      // Capture the timeout callback
      mockConnectionManager.startApprovalTimeout.mockImplementation(
        (_ws: WebSocket, _reqId: string, cb: () => Promise<void>) => {
          timeoutCallback = cb;
        }
      );

      async function* mockGenerator() {
        yield {
          kind: "notification",
          type: "interrupt",
          requestId: "req-1",
          data: { approvalId: "approval-123" },
        };
        // Never completes - waiting for approval
        await new Promise(() => {});
      }

      const mockRouter = {
        handle: vi.fn().mockReturnValue(mockGenerator()),
      };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      const msgCall = mockWs.on.mock.calls.find((c) => c[0] === "message");
      const messageHandler = msgCall![1] as (data: Buffer) => void;

      const request = { id: "req-1", method: "chat.send", params: {} };
      isRpcRequest.mockReturnValue(true);
      isAsyncGenerator.mockReturnValue(true);

      messageHandler(Buffer.from(JSON.stringify(request)));

      await new Promise((r) => setTimeout(r, 10));

      // Simulate timeout
      if (timeoutCallback) {
        await timeoutCallback();
      }

      expect(mockWs.send).toHaveBeenCalled();
      expect(mockConnectionManager.close).toHaveBeenCalled();
    });
  });

  describe("sendError function", () => {
    it("should send error response with request id", async () => {
      const mockRouter = { handle: vi.fn() };
      createWebSocketServer({ port: 0, router: mockRouter });

      const mockWs = createMockWs();
      connectionHandler!(mockWs);

      const msgCall = mockWs.on.mock.calls.find((c) => c[0] === "message");
      const messageHandler = msgCall![1] as (data: Buffer) => void;

      // Trigger error by having router throw
      mockRouter.handle.mockRejectedValue(new Error("handler error"));
      transport.parseMessage.mockReturnValue({ id: "req-1" });

      messageHandler(Buffer.from('{"id":"req-1","method":"test"}'));

      await new Promise((r) => setTimeout(r, 10));

      expect(mockWs.send).toHaveBeenCalled();
      const sentData = mockWs.send.mock.calls[0][0];
      expect(sentData).toBeDefined();
    });
  });

  describe("connectionManager export", () => {
    it("should export connectionManager", async () => {
      expect(connectionManager).toBe(mockConnectionManager);
    });
  });
});

function createMockWs(): WebSocket {
  return {
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}