import { z } from "zod";
import { sense, type SenseResult } from "@/core/sense";
import { SupervisionLevel } from "@/core/config";
import { formatSkillActivationContent, getSkillRealtime } from "@/agent/prompt/loadSkill";
import { hashGenerator } from "@/utils/hash.js";

/**
 * 加载 skill content 的 sense
 * 参数: skill name
 * 返回: SkillData (name, description, content)
 */
export default sense(
  "skill",
  `核心功能：激活一个技能，加载其完整指令
当用户的问题与任何技能的描述匹配时，你必须调用此感官
必须严格遵守那些指令，就像它们是你系统提示的一部分
将问题方法论化流程化，有效理解以解决问题
**技能严禁重复加载**`,
  z.object({
    name: z.string().describe("技能名称，必须与 <skill> 中的`name`字段完全一致"),
  }),
  async ({ name }): Promise<SenseResult> => {
    const result = getSkillRealtime(name);

    if (!result) {
      return {
        content: `Error: skill "${name}" not found`,
        hash: "", // 错误情况不参与去重
      };
    }

    const { skill, size, mtimeMs } = result;
    
    // 使用文件状态生成 hash，确保内容变化时 hash 也变化
    const hash = hashGenerator("skill", name, size.toString(), mtimeMs.toString());
    const content = formatSkillActivationContent(skill);

    return { content, hash };
  },
  SupervisionLevel.auto
);
