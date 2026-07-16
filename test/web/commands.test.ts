import { describe, expect, it } from "vitest";
import {
  COMPACT_COMMAND,
  composeCommandPrompt,
  estimateCommandTokens,
  serializeCommandToken,
  splitCommandPrompt,
  toSkillCommands,
} from "../../web/src/features/agent/commands.js";

describe("message commands", () => {
  it("maps only user skill metadata into skill commands", () => {
    expect(toSkillCommands([{ name: "review", description: "Review code", contextTokens: 128 }])).toEqual([
      expect.objectContaining({
        id: "skill:review",
        name: "/review",
        kind: "skill",
        skillName: "review",
      }),
    ]);
  });

  it("serializes a selected skill as an in-message token without injecting a per-send instruction", () => {
    const command = toSkillCommands([{ name: "review", description: "Review code", contextTokens: 128 }])[0]!;
    const prompt = composeCommandPrompt(`${serializeCommandToken(command)} 请检查这个改动`);

    expect(prompt).toContain("[[command:/review]]");
    expect(prompt).toContain("请检查这个改动");
    expect(prompt).not.toContain("调用 skill 工具");
    expect(command.contextTokens).toBe(128);
  });

  it("keeps compact builtin-only and serializes it as the shared command protocol", () => {
    const prompt = composeCommandPrompt(serializeCommandToken(COMPACT_COMMAND));

    expect(COMPACT_COMMAND.name).toBe("/compact");
    expect(COMPACT_COMMAND.label).toBe("compact");
    expect(COMPACT_COMMAND.kind).toBe("builtin");
    expect(prompt).toBe("[[command:/compact]]");
    expect(estimateCommandTokens(COMPACT_COMMAND)).toBe(5);
  });

  it("splits only the fixed command protocol into rich-text render segments", () => {
    expect(splitCommandPrompt("[[command:/review]] 请检查 /tmp/notes")).toEqual([
      { type: "command", value: "/review" },
      { type: "text", value: " 请检查 /tmp/notes" },
    ]);
  });
});
