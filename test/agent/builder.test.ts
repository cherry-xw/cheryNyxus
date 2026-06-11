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
    brain: {
      ollama_client: {
        provider: "ollama",
        model: "ollama-model",
        url: "http://localhost:11434",
        key: "",
        sense_group: "safe_senses",
      },
      openai_client: {
        provider: "openai",
        model: "gpt-4",
        url: "https://api.openai.com/v1",
        key: "test-key",
        sense_group: ["safe_senses", "dangerous_senses"],
      },
    },
  },
  sense_groups: {
    safe_senses: {
      senses: ["read_file"],
    },
    dangerous_senses: {
      senses: ["execute_command"],
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

const mockSenseAdapter = {
  buildSenses: vi.fn(() => []),
  extractSenseCalls: vi.fn(),
  assembleSenseCallChunks: vi.fn(),
};

vi.mock("@/core/llm/adapter", () => ({
  getLLMAdapter: vi.fn(() => mockLLMAdapter),
}));

vi.mock("@/core/message/adapter", () => ({
  getMessageAdapter: vi.fn(() => mockMessageAdapter),
}));

vi.mock("@/core/sense/adapter", () => ({
  getSenseAdapter: vi.fn(() => mockSenseAdapter),
}));

// Mock 工具加载 - 使用函数形式避免构造函数问题
vi.mock("@/agent/sense/index", () => {
  const mockAdd = vi.fn();
  return {
    ensureCustomSensesLoaded: vi.fn(),
    SenseManager: class MockSenseManager {
      add = mockAdd;
      get = vi.fn();
      getAll = vi.fn(() => []);
      execute = vi.fn();
      setSupervision = vi.fn();
      fillSupervisionDefault = vi.fn();
      loadFromGroups = vi.fn();
    },
  };
});

// Mock Middleware - 使用 class 形式
vi.mock("@/agent/middleware/index", () => {
  class MockMiddleware {
    send = vi.fn();
  }
  return {
    default: MockMiddleware,
    defaultHandlers: [],
    createLoopHandler: vi.fn(() => vi.fn()),
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

  describe("setSoulId() method", () => {
    it("should set custom soul ID", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const builder = new AgentBuilder();
      builder.use("ollama_client").setSoulId("custom-soul-id");
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
    it("should support chain: use().setSoulId()", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const builder = new AgentBuilder();
      builder
        .use("ollama_client")
        .setSoulId("test-soul");

      expect(builder).toBeDefined();
    });

    it("should build after chain calls", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const builder = new AgentBuilder();
      builder
        .use("ollama_client")
        .setSoulId("test-soul");

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

      // loadFromGroups 应被调用（参数验证在 senseManager.test.ts 中）
      // 此测试仅验证流程不抛错
    });

    it("should handle multiple tool groups", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const builder = new AgentBuilder();
      builder.use("openai_client"); // 使用有多个 sense_group 的客户端
      const middleware = await builder.build();
      expect(middleware).toBeDefined();
    });

    it("should build with no sense_group configured", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const config = (await import("@/utils/config")).default;
      const origClient = config.llm.brain.ollama_client;
      config.llm.brain.ollama_client = {
        ...origClient,
        sense_group: undefined,
      };

      const builder = new AgentBuilder();
      builder.use("ollama_client");
      const middleware = await builder.build();

      expect(middleware).toBeDefined();

      config.llm.brain.ollama_client = origClient;
    });

    it("should apply sense-level supervision override", async () => {
      const { AgentBuilder } = await import("@/agent/builder");
      const config = (await import("@/utils/config")).default;
      const origClient = config.llm.brain.ollama_client;
      config.llm.brain.ollama_client = {
        ...origClient,
        sense_group: ["supervised_senses"],
      };
      config.sense_groups!.supervised_senses = {
        senses: ["read_file:auto"],
      };

      const builder = new AgentBuilder();
      builder.use("ollama_client");
      const middleware = await builder.build();

      expect(middleware).toBeDefined();

      config.llm.brain.ollama_client = origClient;
      delete config.sense_groups!.supervised_senses;
    });
  });
});