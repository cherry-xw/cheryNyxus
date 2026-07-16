import { describe, expect, it } from "vitest";
import {
  COMPACT_COMMAND,
  composeCommandPrompt,
  toSkillCommands,
} from "../../web/src/features/agent/commands.js";

describe("message commands", () => {
  it("maps only user skill metadata into skill commands", () => {
    expect(toSkillCommands([{ name: "review", description: "Review code" }])).toEqual([
      expect.objectContaining({
        id: "skill:review",
        name: "/review",
        kind: "skill",
        skillName: "review",
      }),
    ]);
  });

  it("adds an explicit skill-tool instruction before the user text", () => {
    const command = toSkillCommands([{ name: "review", description: "Review code" }])[0]!;
    const prompt = composeCommandPrompt("请检查这个改动", [command]);

    expect(prompt).toContain('调用 skill 工具，参数为 {"name":"review"}');
    expect(prompt).toContain("请检查这个改动");
    expect(prompt.indexOf("调用 skill 工具")).toBeLessThan(prompt.indexOf("请检查这个改动"));
  });

  it("keeps compact builtin-only and emits its compaction instruction", () => {
    const prompt = composeCommandPrompt("", [COMPACT_COMMAND]);

    expect(COMPACT_COMMAND.name).toBe("/compact");
    expect(COMPACT_COMMAND.kind).toBe("builtin");
    expect(prompt).toContain("压缩当前上下文");
  });
});
