import { z } from "zod";
import { tool, type ToolResult } from "@/core/tool";
import { SupervisionLevel } from "@/core/config";
import { getSkill } from "@/core/prompt/loadSkill";
import { generateHash } from "@/utils/hash.js";

/**
 * 加载 skill content 的 tool
 * 参数: skill name
 * 返回: SkillData (name, description, content)
 */
export default tool(
  "Skill",
  `核心功能：激活一个技能，加载其完整指令
当用户的问题与任何技能的描述匹配时，你必须调用此工具
必须严格遵守那些指令，就像它们是你系统提示的一部分
将问题方法论化流程化，有效理解以解决问题
**技能严禁重复加载**`,
  z.object({
    name: z.string().describe("技能名称，必须与 <skill> 中的`name`字段完全一致"),
  }),
  async ({ name }): Promise<ToolResult> => {
    const skill = getSkill(name);

    if (!skill) {
      return {
        content: `Error: skill "${name}" not found`,
        hash: "", // 错误情况不参与去重
      };
    }

    const hash = generateHash(`skill::${name}`);
    const content = `"${skill.name}"技能已激活。以下是完整指令，请严格遵守：\n\n${skill.content}`;

    return { content, hash };
  },
  SupervisionLevel.auto
);