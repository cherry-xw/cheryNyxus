import { describe, expect, it, vi } from "vitest";

vi.mock("@/agent/prompt/loadSkill.js", () => ({
  getSkillMetas: vi.fn(),
}));

import { getSkillMetas } from "@/agent/prompt/loadSkill.js";
import { handleSkillsList } from "@/service/skill/list.js";

describe("service/skill/list", () => {
  it("returns the current user skill metadata without content", async () => {
    vi.mocked(getSkillMetas).mockReturnValue([
      { name: "review", description: "Review code", trigger: "用户请求审查", contextTokens: 128 },
    ]);

    await expect(handleSkillsList({ connectionId: "c1" }, {})).resolves.toEqual({
      skills: [{ name: "review", description: "Review code", trigger: "用户请求审查", contextTokens: 128 }],
    });
  });
});
