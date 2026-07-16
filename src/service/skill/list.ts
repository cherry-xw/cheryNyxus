import type { HandlerContext } from "../message/router.js";
import { Method, type SkillsListResponseData } from "../message/types.js";
import { getSkillMetas } from "@/agent/prompt/loadSkill.js";

/**
 * skills.list：实时列出用户 skills_dir 中的可加载 Skill。
 * 内置命令由前端维护，不能通过本接口进入用户配置/删除范围。
 */
export async function handleSkillsList(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<SkillsListResponseData> {
  return { skills: getSkillMetas() };
}

/** 注册 Skill 目录相关的 RPC handlers。 */
export function registerSkillHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.SKILLS_LIST, handleSkillsList);
}
