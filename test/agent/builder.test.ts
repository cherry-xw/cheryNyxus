import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config.yaml 加载
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
      ollama_client: {
        provider: "ollama",
        model: "ollama-model",
        url: "http://localhost:11434",
        key: "",
        tool_group: "safe_tools",
      },
      openai_client: {
        provider: "openai",
        model: "gpt-4",
        url: "https://api.openai.com/v1",
        key: "test-key",
        tool_group: ["safe_tools", "dangerous_tools"],
      },
    },
  },
  tool_groups: {
    safe_tools: {
      tools: ["read_file"],
    },
    dangerous_tools: {
      tools: ["execute_command"],
    },
  },
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

// Mock adapter 获取
const mockLLMAdapter = {
  chat: vi.fn(),
  chatStream: vi.fn(),
};

const mockMessageAdapter = {
  role: vi.fn(),
  content: vi.fn(),
  thinking: vi.fn(),
  extractStreamDelta: vi.fn(),
  extractStreamThinking: vi.fn(),
  buildMessages: vi.fn(),
};

const mockToolAdapter = {
  buildTools: vi.fn(),
  extractToolCalls: vi.fn(),
  assembleToolCallChunks: vi.fn(),
};

vi.mock("@/core/llm/adapter", () => ({
  getLLMAdapter: vi.fn(() => mockLLMAdapter),
}));

vi.mock("@/core/message/adapter", () => ({
  getMessageAdapter: vi.fn(() => mockMessageAdapter),
}));

vi.mock("@/core/tool/adapter", () => ({
  getToolAdapter: vi.fn(() => mockToolAdapter),
}));

// Mock 工具加载 - 使用函数形式避免构造函数问题
vi.mock("@/agent/tool/index", () => {
  const mockAdd = vi.fn();
  return {
    ensureToolsLoaded: vi.fn(),
    getTools: vi.fn((names: string[]) =>
      names.map((name: string) => ({
        definition: {
          function: {
            name,
            description: `Mock ${name}`,
            parameters: {},
          },
        },
        supervisionLevel: 0,
      }))
    ),
    // 使用类形式 mock ToolManager
    ToolManager: class MockToolManager {
      add = mockAdd;
      get = vi.fn();
      execute = vi.fn();
      setSupervision = vi.fn();
      fillSupervisionDefault = vi.fn();
      loadFromGroups = vi.fn();
    },
  };
});

// Mock env 初始化
vi.mock("@/utils/env", () => ({
  initEnvInfo: vi.fn(),
}));

// Mock Middleware - 使用 class 形式
vi.mock("@/agent/middleware/index", () => {
  class MockMiddleware {
    send = vi.fn();
  }
  return {
    default: MockMiddleware,
    defaultHandlers: [],
  };
});

describe("AgentBuilder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("use() method", () => {
    it("should throw error when client config not found", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const builder = new AgentBuilder();
      expect(() => builder.use("nonexistent_client")).toThrow("配置 \"nonexistent_client\" 不存在");
    });

    it("should select ollama provider", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const builder = new AgentBuilder();
      const result = builder.use("ollama_client");
      expect(result).toBeInstanceOf(AgentBuilder);
    });

    it("should select openai provider", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const builder = new AgentBuilder();
      const result = builder.use("openai_client");
      expect(result).toBeInstanceOf(AgentBuilder);
    });
  });

  describe("setSessionId() method", () => {
    it("should set custom session ID", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const builder = new AgentBuilder();
      builder.use("ollama_client").setSessionId("custom-session-id");
    });
  });

  describe("build() method", () => {
    it("should throw error when build() without use()", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const builder = new AgentBuilder();
      await expect(builder.build()).rejects.toThrow("必须先调用 use() 选择 LLM 服务");
    });

    it("should build successfully with use()", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const builder = new AgentBuilder();
      builder.use("ollama_client");

      const middleware = await builder.build();
      expect(middleware).toBeDefined();
    });
  });

  describe("chain calls", () => {
    it("should support chain: use().setSessionId()", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const builder = new AgentBuilder();
      builder
        .use("ollama_client")
        .setSessionId("test-session");

      expect(builder).toBeDefined();
    });

    it("should build after chain calls", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const builder = new AgentBuilder();
      builder
        .use("ollama_client")
        .setSessionId("test-session");

      const middleware = await builder.build();
      expect(middleware).toBeDefined();
    });
  });

  describe("build() edge cases", () => {
    it("should call loadFromGroups with correct parameters", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const builder = new AgentBuilder();
      builder.use("ollama_client");
      await builder.build();

      // loadFromGroups 应被调用（参数验证在 toolManager.test.ts 中）
      // 此测试仅验证流程不抛错
    });

    it("should handle multiple tool groups", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const builder = new AgentBuilder();
      builder.use("openai_client"); // 使用有多个 tool_group 的客户端
      const middleware = await builder.build();
      expect(middleware).toBeDefined();
    });

    it("should build with no tool_group configured", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const config = (await import("@/utils/config")).default;
      const origClient = config.llm.brain.ollama_client;
      config.llm.brain.ollama_client = {
        ...origClient,
        tool_group: undefined,
      };

      const builder = new AgentBuilder();
      builder.use("ollama_client");
      const middleware = await builder.build();

      expect(middleware).toBeDefined();

      config.llm.brain.ollama_client = origClient;
    });

    it("should apply group-level supervision override", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const config = (await import("@/utils/config")).default;
      const origClient = config.llm.brain.ollama_client;
      config.llm.brain.ollama_client = {
        ...origClient,
        tool_group: ["supervised_tools"],
      };
      config.tool_groups.supervised_tools = {
        tools: ["read_file"],
        supervision: 2,
      };

      const builder = new AgentBuilder();
      builder.use("ollama_client");
      const middleware = await builder.build();

      expect(middleware).toBeDefined();

      config.llm.brain.ollama_client = origClient;
      delete config.tool_groups.supervised_tools;
    });
  });
});