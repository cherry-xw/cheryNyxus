import { describe, it, expect } from "vitest";
import * as llmIndex from "@/core/llm/index";

describe("llm index exports", () => {
  it("exports registerLLMAdapter", () => {
    expect(llmIndex.registerLLMAdapter).toBeDefined();
    expect(typeof llmIndex.registerLLMAdapter).toBe("function");
  });

  it("exports getLLMAdapter", () => {
    expect(llmIndex.getLLMAdapter).toBeDefined();
    expect(typeof llmIndex.getLLMAdapter).toBe("function");
  });
});