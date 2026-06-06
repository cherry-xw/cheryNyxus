import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config.yaml 加载 - 在顶层定义
const mockConfig = {
  global: {
    thinking: false,
    supervision: 0,
    stream: true,
    timeout: 30000,
    maxLoopCount: 10,
  },
  llm: {
    agent: {
      test_client: {
        provider: "ollama",
        model: "test-model",
        url: "http://localhost:11434",
        key: "",
        sense_group: [],
      },
    },
  },
  sense_groups: {},
};

vi.mock("@/utils/config", () => ({
  default: mockConfig,
}));

// Mock provider 注册
vi.mock("@/agent/provider/ollama", () => ({
  registerOllamaAdapter: vi.fn(),
}));

vi.mock("@/agent/provider/openai", () => ({
  registerOpenAIAdapter: vi.fn(),
}));

// Mock adapter 获取 - 返回有效的 adapter
vi.mock("@/core/llm/adapter", () => ({
  getLLMAdapter: vi.fn(() => ({
    chat: vi.fn(),
    chatStream: vi.fn(),
  })),
}));

vi.mock("@/core/message/adapter", () => ({
  getMessageAdapter: vi.fn(() => ({
    role: vi.fn(),
    content: vi.fn(),
    thinking: vi.fn(),
    extractStreamDelta: vi.fn(),
    extractStreamThinking: vi.fn(),
    buildMessages: vi.fn(),
  })),
}));

vi.mock("@/core/sense/adapter", () => ({
  getSenseAdapter: vi.fn(() => ({
    buildTools: vi.fn(),
    extractSenseCalls: vi.fn(),
    assembleSenseCallChunks: vi.fn(),
  })),
}));

// Mock 工具加载
vi.mock("@/agent/sense/index", () => ({
  ensureToolsLoaded: vi.fn(),
  getSenses: vi.fn(() => []),
  SenseManager: vi.fn().mockImplementation(() => ({
    add: vi.fn(),
    getAll: vi.fn(() => []),
    get: vi.fn(),
    execute: vi.fn(),
  })),
}));

// Mock env 初始化
vi.mock("@/utils/env", () => ({
  initEnvInfo: vi.fn(),
}));

describe("Agent Index - AgentBuilder Basic Usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create AgentBuilder instance", async () => {
    const { AgentBuilder } = await import("@/agent/builder");
    const builder = new AgentBuilder();
    expect(builder).toBeDefined();
    expect(builder).toBeInstanceOf(AgentBuilder);
  });

  it("should chain use() method", async () => {
    const { AgentBuilder } = await import("@/agent/builder");
    const builder = new AgentBuilder();
    const result = builder.use("test_client");
    expect(result).toBeInstanceOf(AgentBuilder);
    expect(result).toBe(builder);
  });

  it("should chain setSessionId() method", async () => {
    const { AgentBuilder } = await import("@/agent/builder");
    const builder = new AgentBuilder();
    const result = builder.setSessionId("test-session");
    expect(result).toBeInstanceOf(AgentBuilder);
    expect(result).toBe(builder);
  });

  it("should throw error when build() without use()", async () => {
    const { AgentBuilder } = await import("@/agent/builder");
    const builder = new AgentBuilder();
    await expect(builder.build()).rejects.toThrow("必须先调用 use() 选择 LLM 服务");
  });
});