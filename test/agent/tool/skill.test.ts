import { describe, it, expect, vi, beforeEach } from "vitest";
import skillTool from "@/agent/tool/skill";
import { SupervisionLevel } from "@/core/config";
import type { ToolSharedData } from "@/core/tool";

const mockGetSkill = vi.fn();

vi.mock("@/core/prompt/loadSkill", () => ({
  getSkill: (...args: unknown[]) => mockGetSkill(...args),
}));

vi.mock("@/utils/hash", () => ({
  hashGenerator: vi.fn(() => "skill-hash"),
}));

describe("Skill Tool", () => {
  let sharedData: ToolSharedData;

  beforeEach(() => {
    vi.clearAllMocks();
    sharedData = new Map();
  });

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

  describe("executor", () => {
    it("should return skill content when skill found", async () => {
      mockGetSkill.mockReturnValue({
        name: "my_skill",
        description: "A test skill",
        content: "Do something useful",
      });

      const result = await skillTool.executor.execute(
        { name: "my_skill" },
        sharedData,
      );

      expect(result.content).toContain("my_skill");
      expect(result.content).toContain("技能已激活");
      expect(result.content).toContain("Do something useful");
      expect(result.hash).toBe("skill-hash");
    });

    it("should return error when skill not found", async () => {
      mockGetSkill.mockReturnValue(undefined);

      const result = await skillTool.executor.execute(
        { name: "nonexistent" },
        sharedData,
      );

      expect(result.content).toContain("not found");
      expect(result.hash).toBe("");
    });

    it("should call hashGenerator with correct args", async () => {
      mockGetSkill.mockReturnValue({
        name: "test_skill",
        description: "Test",
        content: "Content",
      });

      const { hashGenerator } = vi.mocked(await import("@/utils/hash"));

      await skillTool.executor.execute(
        { name: "test_skill" },
        sharedData,
      );

      expect(hashGenerator).toHaveBeenCalledWith("skill", "test_skill");
    });
  });
});
