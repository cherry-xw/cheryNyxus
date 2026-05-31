import { describe, it, expect, vi } from "vitest";
import skillTool from "@/agent/tool/skill";
import { SupervisionLevel } from "@/core/config";

// Mock getSkill - 使用正确的路径格式
vi.mock("@/core/prompt/loadSkill", () => ({
  getSkill: vi.fn((name: string) => {
    if (name === "existing_skill") {
      return {
        name: "existing_skill",
        description: "Test skill",
        content: "Skill content here",
      };
    }
    return undefined;
  }),
}));

// Mock hash generator
vi.mock("@/utils/hash", () => ({
  hashGenerator: vi.fn(() => "skill-hash"),
}));

describe("Skill Tool", () => {
  describe("tool definition", () => {
    it("should have correct name", () => {
      expect(skillTool.definition.function.name).toBe("skill");
    });

    it("should have correct supervision level", () => {
      expect(skillTool.supervisionLevel).toBe(SupervisionLevel.auto);
    });

    it("should have valid schema", () => {
      expect(skillTool.definition.function.parameters).toBeDefined();
    });

    it("should have description", () => {
      expect(skillTool.definition.function.description).toBeDefined();
    });
  });
});