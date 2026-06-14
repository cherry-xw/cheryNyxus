import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import config from "@/utils/config.js";
import { logger } from "@/utils/logger/index.js";

export interface SkillData {
  name: string;
  description: string;
  content: string;
  /** P1-5：自动触发条件描述（软提示，拼入 system prompt 供 LLM 判断何时触发） */
  trigger?: string;
}

interface SkillMeta {
  name: string;
  description: string;
  content: string;
  trigger?: string;
}

/**
 * 解析 SKILL.md 文件的 frontmatter 和 content
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
    };
  }

  try {
    const frontmatter = yaml.load(match[1]!) as Record<string, unknown>;
    const bodyContent = content.slice(match[0]!.length).trim();

    return {
      name: (frontmatter.name as string) || defaultName,
      description: (frontmatter.description as string) || "",
      trigger: (frontmatter.trigger as string) || undefined,
      content: bodyContent,
    };
  } catch {
    return {
      name: defaultName,
      description: "",
      content: content.trim(),
      trigger: undefined,
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
        },
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      };
    }
  }

  return undefined;
}

/**
 * 获取所有 skill 的元数据（不含 content）。
 */
export function getSkillMetas(): Array<{ name: string; description: string; trigger?: string }> {
  return readAllSkills().map((s) => ({
    name: s.name,
    description: s.description,
    trigger: s.trigger,
  }));
}
