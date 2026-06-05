import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConnectionState = {
  id: "conn-1",
  ws: { send: vi.fn(), on: vi.fn(), close: vi.fn() } as any,
  sessionId: undefined as string | undefined,
  pendingRequests: new Map<string, any>(),
};

const mockConnectionManager = {
  create: vi.fn(() => mockConnectionState),
  get: vi.fn(() => mockConnectionState),
  setSession: vi.fn(),
  addPendingRequest: vi.fn(() => ({ requestId: "req-1", startTime: Date.now(), timeoutMs: 60000 })),
  setRequestGenerator: vi.fn(),
  setRequestInterruptId: vi.fn(),
  setRequestTimeout: vi.fn(),
  clearRequestTimeout: vi.fn(),
  removePendingRequest: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
};

let connectionHandler: Function | undefined;

const mockWss = {
  on: vi.fn((event: string, cb: Function) => {
    if (event === "connection") connectionHandler = cb;
  }),
  close: vi.fn(),
};

vi.mock("ws", () => ({
  WebSocketServer: vi.fn().mockImplementation(function() { return mockWss; }),
}));

vi.mock("@/service/websocket/transport.js", () => ({
  transport: {
    parseMessage: vi.fn((data: string | Buffer) => JSON.parse(typeof data === "string" ? data : data.toString("utf-8"))),
    serializeMessage: vi.fn((msg: unknown) => JSON.stringify(msg)),
    encode: vi.fn((event: unknown) => JSON.stringify(event)),
  },
}));

vi.mock("@/service/websocket/connection.js", () => ({
  connectionManager: mockConnectionManager,
}));

describe("createWebSocketServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionHandler = undefined;
  });

  it("should register connection handler on WSS", async () => {
    const { createWebSocketServer } = await import("@/service/websocket/index.js");
    const mockRouter = { handle: vi.fn() };
    createWebSocketServer({ port: 0, router: mockRouter });
    expect(connectionHandler).toBeDefined();
  });

  it("should create connection state on new connection", async () => {
    const { createWebSocketServer } = await import("@/service/websocket/index.js");
    const mockRouter = { handle: vi.fn() };
    createWebSocketServer({ port: 0, router: mockRouter });

    const mockWs = { on: vi.fn(), send: vi.fn() };
    connectionHandler!(mockWs);
    expect(mockConnectionManager.create).toHaveBeenCalledWith(mockWs);
  });

  it("should register message, close, error handlers on ws", async () => {
    const { createWebSocketServer } = await import("@/service/websocket/index.js");
    const mockRouter = { handle: vi.fn() };
    createWebSocketServer({ port: 0, router: mockRouter });

    const mockWs = { on: vi.fn(), send: vi.fn() };
    connectionHandler!(mockWs);
    expect(mockWs.on).toHaveBeenCalledWith("message", expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith("close", expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith("error", expect.any(Function));
  });
});
