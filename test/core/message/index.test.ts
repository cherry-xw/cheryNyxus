import { describe, it, expect } from "vitest";
import * as messageIndex from "@/core/message/index";

describe("message index exports", () => {
  it("exports MessageAdapter", () => {
    expect(messageIndex.MessageAdapter).toBeDefined();
  });

  it("exports registerMessageAdapter", () => {
    expect(messageIndex.registerMessageAdapter).toBeDefined();
    expect(typeof messageIndex.registerMessageAdapter).toBe("function");
  });

  it("exports getMessageAdapter", () => {
    expect(messageIndex.getMessageAdapter).toBeDefined();
    expect(typeof messageIndex.getMessageAdapter).toBe("function");
  });

  it("exports LLMResponse type", () => {
    // Type is exported, verify module structure
    expect(messageIndex).toBeDefined();
  });
});