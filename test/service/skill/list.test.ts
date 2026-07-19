import { describe, expect, it, vi } from "vitest";

vi.mock("@/agent/prompt/loadSkill.js", () => ({
  getSkillMetas: vi.fn(),
  getSkillMetasPaginated: vi.fn(),
  getSkillNameList: vi.fn(),
}));

import { getSkillMetas, getSkillMetasPaginated } from "@/agent/prompt/loadSkill.js";
import { handleSkillsList } from "@/service/skill/list.js";

describe("service/skill/list", () => {
  it("returns the current user skill metadata without content", async () => {
    vi.mocked(getSkillMetas).mockReturnValue([
      { name: "review", description: "Review code", trigger: "用户请求审查", contextTokens: 128 },
    ]);

    await expect(handleSkillsList({ connectionId: "c1" }, {})).resolves.toEqual({
      skills: [{ name: "review", description: "Review code", trigger: "用户请求审查", contextTokens: 128 }],
      total: 1,
      page: 1,
      pageSize: 1,
    });
  });

  it("delegates paginated requests and preserves the corrected page", async () => {
    vi.mocked(getSkillMetasPaginated).mockReturnValue({ skills: [], total: 501, page: 11, pageSize: 50 });
    await expect(handleSkillsList({ connectionId: "c1" }, { page: 99, pageSize: 50, search: "x" })).resolves.toEqual({
      skills: [], total: 501, page: 11, pageSize: 50,
    });
  });
});
