import { vi } from "vitest";

export const mockOpenAIChatCompletion = {
  choices: [
    {
      message: {
        role: "assistant",
        content: "Hello, I am an AI assistant.",
      },
    },
  ],
};

export const mockOpenAIStreamChunks = [
  { choices: [{ delta: { content: "Hello" } }] },
  { choices: [{ delta: { content: ", " } }] },
  { choices: [{ delta: { content: "world" } }] },
];

vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async (options) => {
            if (options.stream) {
              return {
                async *[Symbol.asyncIterator]() {
                  for (const chunk of mockOpenAIStreamChunks) {
                    yield chunk;
                  }
                },
              };
            }
            return mockOpenAIChatCompletion;
          }),
        },
      },
    })),
  };
});