import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import config from "@/utils/config.js";
import { logger } from "@/utils/logger/index.js";
import { estimateTokens } from "@/utils/token.js";

export interface SkillData {
  name: string;
  description: string;
  content: string;
  /** P1-5：自动触发条件描述（软提示，拼入 system prompt 供 LLM 判断何时触发） */
  trigger?: string;
  /** SKILL.md frontmatter 中其他用户自定义字段（保留全部，用于 JSON 序列化 token 估算）。 */
  extra?: Record<string, unknown>;
}

/** skill 感官成功加载时写入模型上下文的完整文本（与 sense/skill 保持单一来源）。 */
export function formatSkillActivationContent(skill: Pick<SkillData, "name" | "content">): string {
  return `"${skill.name}"技能已激活。以下是完整指令，请严格遵守：\n\n${skill.content}`;
}

interface SkillMeta {
  name: string;
  description: string;
  content: string;
  trigger?: string;
  extra?: Record<string, unknown>;
}

/**
 * 解析 SKILL.md 文件的 frontmatter 和 content。
 * 保留全部 frontmatter 字段到 extra（不只取 name/description/trigger）——供 promptTokens
 * JSON 序列化时「全部纳入」使用。
 */
function parseSkillFrontmatter(
  content: string,
  defaultName: string,
): SkillMeta {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (!match) {
    return {
      name: defaultName,
      description: "",
      content: content.trim(),
      trigger: undefined,
      extra: undefined,
    };
  }

  try {
    const frontmatter = (yaml.load(match[1]!) || {}) as Record<string, unknown>;
    const bodyContent = content.slice(match[0]!.length).trim();

    // 拆出已知字段到对应位置，其余保留为 extra（用户自定义字段）
    const { name: _n, description: _d, trigger: _t, ...rest } = frontmatter;

    return {
      name: (frontmatter.name as string) || defaultName,
      description: (frontmatter.description as string) || "",
      trigger: (frontmatter.trigger as string) || undefined,
      content: bodyContent,
      extra: Object.keys(rest).length > 0 ? rest : undefined,
    };
  } catch {
    return {
      name: defaultName,
      description: "",
      content: content.trim(),
      trigger: undefined,
      extra: undefined,
    };
  }
}

/**
 * 遍历 skills 目录，读取所有 SKILL.md/skill.md 文件（实时，不缓存）。
 * P1-4：原模块级 skillMap 缓存导致新增/改动 SKILL.md 不反映；改为实时遍历，
 *       getSkillMetas 每次重读，保证配置热更可见（类比 sense 的 reloadSenses）。
 */
function readAllSkills(): SkillData[] {
  const skillsDir = config.global.skills_dir;

  if (!existsSync(skillsDir)) return [];

  const result: SkillData[] = [];
  const dirs = readdirSync(skillsDir, { withFileTypes: true });

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;

    const dirName = dir.name;
    const skillPath = join(skillsDir, dirName);
    const files = readdirSync(skillPath);
    const skillFile = files.find((f) => f.toLowerCase() === "skill.md");
    if (!skillFile) continue;

    const fileContent = readFileSync(join(skillPath, skillFile), "utf-8");
    const meta = parseSkillFrontmatter(fileContent, dirName);

    if (result.some((s) => s.name === meta.name)) {
      logger.warn(
        `[loadSkill] Warning: skill name "${meta.name}" conflict, overwriting with latest`,
      );
    }
    result.push({
      name: meta.name,
      description: meta.description,
      content: meta.content,
      trigger: meta.trigger,
      extra: meta.extra,
    });
  }

  return result;
}

/**
 * 实时读取单个 skill 数据。
 */
export function getSkillRealtime(name: string):
  | { skill: SkillData; size: number; mtimeMs: number }
  | undefined {
  const skillsDir = config.global.skills_dir;
  if (!existsSync(skillsDir)) return undefined;

  const dirs = readdirSync(skillsDir, { withFileTypes: true });

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;

    const dirName = dir.name;
    const skillPath = join(skillsDir, dirName);
    const files = readdirSync(skillPath);
    const skillFile = files.find((f) => f.toLowerCase() === "skill.md");
    if (!skillFile) continue;

    const filePath = join(skillPath, skillFile);
    const fileContent = readFileSync(filePath, "utf-8");
    const meta = parseSkillFrontmatter(fileContent, dirName);

    if (meta.name === name) {
      const fileStat = statSync(filePath);
      return {
        skill: {
          name: meta.name,
          description: meta.description,
          content: meta.content,
          trigger: meta.trigger,
          extra: meta.extra,
        },
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      };
    }
  }

  return undefined;
}

/**
 * 集中计算 skill 的所有 token 字段（单一来源）。
 *
 * 字段语义：
 *   - nameDescTokens: 仅 name + description 的 token（不含 trigger、正文、其他附加内容）。
 *   - triggerTokens: 仅 trigger 行的 token（无 trigger 则 0）。
 *   - contentTokens: 仅正文 content 的 token。
 *   - promptTokens: JSON 序列化全字段（含 extra 用户自定义字段）的 token——按设计用作
 *     正文段的 token 计算（与 skill 感官调用结果注入上下文的体量一致）。
 *   - contextTokens: 激活该 skill 后预计新增的上下文 token（即 promptTokens），供前端
 *     发送窗口 `/` 命令菜单 hover 卡片展示「加载该 skill 的 token 消耗」；与正文段 token
 *     计算口径一致。
 *
 * **仅计算 SKILL.md 的部分 token 消耗，不包含其他附加拆分的技能内容**——
 *   不含 formatSkillActivationContent 激活包装前缀（注入到 skill 感官调用结果，归用户对话段）。
 *   system prompt `<skills>` 段的 XML 标签外壳由 computeContextBreakdown 用 estimateTokens(skills.text) 统一估算。
 */
export interface SkillTokenBreakdown {
  nameDescTokens: number;
  triggerTokens: number;
  contentTokens: number;
  promptTokens: number;
  contextTokens: number;
}

export function computeSkillTokens(s: SkillData): SkillTokenBreakdown {
  const nameDescTokens = estimateTokens(`${s.name}\n${s.description}`);
  const triggerTokens = s.trigger
    ? estimateTokens(`触发条件: ${s.trigger}`)
    : 0;
  const contentTokens = estimateTokens(s.content);
  // promptTokens = JSON 序列化全字段（含 extra 用户自定义字段），按设计用作正文 token 计算。
  // 序列化按稳定顺序：name/description/trigger/content/extra 全部纳入。
  const promptJson = JSON.stringify({
    name: s.name,
    description: s.description,
    ...(s.trigger ? { trigger: s.trigger } : {}),
    content: s.content,
    ...(s.extra || {}),
  });
  const promptTokens = estimateTokens(promptJson);
  return {
    nameDescTokens,
    triggerTokens,
    contentTokens,
    promptTokens,
    contextTokens: promptTokens,
  };
}

/**
 * 获取所有 skill 的元数据（含预计算 token 字段）。
 *
 * 所有 token 字段集中在 computeSkillTokens 计算（单一来源），调用方直接复用，
 * 不再各自 estimateTokens。设计语义详见 computeSkillTokens 注释。
 *
 * 用途：skills.list RPC 返回给前端（contextTokens）+ system prompt `<skills>` 拼装 +
 * computeContextBreakdown.skills 段（estimateTokens(skills.text)）+ 正文段（promptTokens）等。
 */
export function getSkillMetas(): Array<
  SkillData & SkillTokenBreakdown
> {
  return readAllSkills().map((s) => ({
    ...s,
    ...computeSkillTokens(s),
  }));
}