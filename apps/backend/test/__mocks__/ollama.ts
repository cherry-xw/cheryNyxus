import { vi } from "vitest";

export const mockOllamaResponse = {
  message: {
    role: "assistant",
    content: "Hello from Ollama",
  },
};

vi.mock("ollama", () => ({
  chat: vi.fn().mockImplementation(async (options) => {
    if (options.stream) {
      return {
        async *[Symbol.asyncIterator]() {
          yield { message: { content: "Hello" } };
          yield { message: { content: " from Ollama" } };
        },
      };
    }
    return mockOllamaResponse;
  }),
}));