import type { HandlerContext } from '../message/router.js'
import {
  Method,
  type SkillsListResponseData,
  type SkillsListNamesResponseData,
  type SkillsListRequestData,
} from '../message/types.js'
import {
  getSkillMetas,
  getSkillMetasPaginated,
  getSkillNameList,
  type SkillPaginationParams,
} from '@/agent/prompt/loadSkill.js'

/**
 * skills.list：实时列出用户 skills_dir 中的可加载 Skill。
 * 支持可选分页（page/pageSize）与搜索（search）/插件过滤（plugin）。
 * 无分页参数时返回全量（向后兼容 prompt builder 等内部调用）。
 *
 * 列表只下发 frontmatter 元数据，不包含技能正文 content（正文只在内部算 token 时使用，
 * 前端不需要正文；contentTokens 已在服务端算好随响应下发）。
 */
export async function handleSkillsList(
  _ctx: HandlerContext,
  params: SkillsListRequestData,
): Promise<SkillsListResponseData> {
  // 无任何参数 → 全量返回（向后兼容）
  if (!params || Object.keys(params).length === 0) {
    const skills = getSkillMetas()
    return {
      skills: skills.map(stripContent),
      total: skills.length,
      page: 1,
      pageSize: skills.length,
    }
  }

  const result = getSkillMetasPaginated(params as SkillPaginationParams)
  return { ...result, skills: result.skills.map(stripContent) }
}

/** 从单项 skill 元数据中去掉正文 content（token 字段、extra、plugin 等其余元数据全部保留）。 */
function stripContent<T extends { content?: unknown }>(skill: T): Omit<T, 'content'> {
  const { content: _omit, ...rest } = skill
  return rest
}

/**
 * skills.listNames：轻量接口，仅返回 skill/plugin 名称列表。
 * 不计算 token，供角色卡 TagSelect 下拉使用。
 */
export async function handleSkillsListNames(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<SkillsListNamesResponseData> {
  return getSkillNameList()
}

/** 注册 Skill 目录相关的 RPC handlers。 */
export function registerSkillHandlers(router: import('../message/router.js').RpcRouter): void {
  router.register(Method.SKILLS_LIST, handleSkillsList)
  router.register(Method.SKILLS_LIST_NAMES, handleSkillsListNames)
}
