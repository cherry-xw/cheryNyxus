import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import config from "@/utils/config.js";
import { logger } from "@/utils/logger/index.js";

export interface SkillData {
  name: string;
  description: string;
  content: string;
}

interface SkillMeta {
  name: string;
  description: string;
  content: string;
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
    };
  }

  try {
    const frontmatter = yaml.load(match[1]!) as Record<string, unknown>;
    const bodyContent = content.slice(match[0]!.length).trim();

    return {
      name: (frontmatter.name as string) || defaultName,
      description: (frontmatter.description as string) || "",
      content: bodyContent,
    };
  } catch {
    return {
      name: defaultName,
      description: "",
      content: content.trim(),
    };
  }
}

/**
 * 遍历 skills 目录，读取所有 SKILL.md/skill.md 文件。
 */
function loadSkills(): Map<string, SkillData> {
  const skillsDir = config.global.skills_dir;

  if (!existsSync(skillsDir)) return new Map();

  const skillMap = new Map<string, SkillData>();
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

    if (skillMap.has(meta.name)) {
      logger.warn(
        `[loadSkill] Warning: skill name "${meta.name}" conflict, overwriting with latest`,
      );
    }

    skillMap.set(meta.name, {
      name: meta.name,
      description: meta.description,
      content: meta.content,
    });
  }

  return skillMap;
}

const skillMap = loadSkills();

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
export function getSkillMetas(): Array<{ name: string; description: string }> {
  return Array.from(skillMap.values()).map((s) => ({
    name: s.name,
    description: s.description,
  }));
}
