import { describe, it, expect, vi } from "vitest";
import buildFirstSystemPrompt from "@/core/prompt/index";

// Mock getEnvInfo
vi.mock("@/utils/env", () => ({
  getEnvInfo: () => ({
    workDir: "/test/dir",
    os: "test-os",
    date: "2024-01-01",
    time: "10:00:00",
  }),
}));

// Mock getSkillMetas
vi.mock("@/core/prompt/loadSkill", () => ({
  getSkillMetas: () => [
    { name: "skill1", description: "First skill" },
    { name: "skill2", description: "Second skill" },
  ],
}));

describe("buildFirstSystemPrompt", () => {
  it("returns formatted prompt string", () => {
    const prompt = buildFirstSystemPrompt();

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("contains system-reminder section", () => {
    const prompt = buildFirstSystemPrompt();

    expect(prompt).toContain("<system-reminder>");
    expect(prompt).toContain("</system-reminder>");
  });

  it("contains environment section", () => {
    const prompt = buildFirstSystemPrompt();

    expect(prompt).toContain("<environment>");
    expect(prompt).toContain("</environment>");
    expect(prompt).toContain("工作目录");
    expect(prompt).toContain("操作系统");
    expect(prompt).toContain("当前日期");
    expect(prompt).toContain("当前时间");
  });

  it("contains skills section", () => {
    const prompt = buildFirstSystemPrompt();

    expect(prompt).toContain("<skills>");
    expect(prompt).toContain("</skills>");
    expect(prompt).toContain("<skill");
    expect(prompt).toContain("</skill>");
  });

  it("includes skill metadata", () => {
    const prompt = buildFirstSystemPrompt();

    expect(prompt).toContain("skill1");
    expect(prompt).toContain("First skill");
  });
});