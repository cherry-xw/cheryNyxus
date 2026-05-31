import { describe, it, expect } from "vitest";
import * as toolIndex from "@/core/tool/index";

describe("tool index exports", () => {
  it("exports toolCreator", () => {
    expect(toolIndex.tool).toBeDefined();
    expect(typeof toolIndex.tool).toBe("function");
  });

  it("exports ToolManager", () => {
    expect(toolIndex.ToolManager).toBeDefined();
    expect(typeof toolIndex.ToolManager).toBe("function");
  });

  it("exports registerToolAdapter", () => {
    expect(toolIndex.registerToolAdapter).toBeDefined();
    expect(typeof toolIndex.registerToolAdapter).toBe("function");
  });

  it("exports getToolAdapter", () => {
    expect(toolIndex.getToolAdapter).toBeDefined();
    expect(typeof toolIndex.getToolAdapter).toBe("function");
  });
});