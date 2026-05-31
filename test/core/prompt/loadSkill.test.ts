import { describe, it, expect } from "vitest";
import { getSkillMap, getSkill, getSkillMetas } from "@/core/prompt/loadSkill";

describe("loadSkill", () => {
  describe("Skill loading", () => {
    it("getSkillMap returns Map", () => {
      const map = getSkillMap();
      expect(map).toBeInstanceOf(Map);
    });

    it("getSkill returns skill or undefined", () => {
      const skill = getSkill("non-existent");
      expect(skill).toBeUndefined();
    });

    it("getSkillMetas returns array", () => {
      const metas = getSkillMetas();
      expect(Array.isArray(metas)).toBe(true);
    });

    it("skill meta has name and description", () => {
      const metas = getSkillMetas();
      for (const meta of metas) {
        expect(meta).toHaveProperty("name");
        expect(meta).toHaveProperty("description");
      }
    });
  });

  describe("Skill data structure", () => {
    it("skill has content property", () => {
      const map = getSkillMap();
      for (const skill of map.values()) {
        expect(skill).toHaveProperty("name");
        expect(skill).toHaveProperty("description");
        expect(skill).toHaveProperty("content");
      }
    });
  });
});