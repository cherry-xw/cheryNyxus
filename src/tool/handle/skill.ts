import { z } from "zod";
import { tool } from "@/tool/base/toolCreator.js";
import { SupervisionLevel } from "@/config";
import { getSkill } from "@/prompt/loadSkill.js";

/**
 * 加载 skill content 的 tool
 * 参数: skill name
 * 返回: SkillData (name, description, content)
 */
export const loadSkillTool = tool(
  "Skill",
  "激活一个技能，加载其完整指令。当用户的问题与任何技能的描述匹配时，你必须调用此工具。",
  z.object({
    name: z.string().describe("技能名称，必须与 <skill> 中的 name 字段完全一致"),
  }),
  async ({ name }) => {
    const skill = getSkill(name);

    if (!skill) {
      return `Error: skill "${name}" not found`;
    }

    return `"${skill.name}"技能已激活。以下是完整指令，请严格遵守：

${skill.content}`;
  },
  SupervisionLevel.auto
);