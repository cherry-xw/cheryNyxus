import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import yaml from "js-yaml";
import config from "@/utils/config.js";

// ESM 下获取当前模块目录（用于 fallback）
const promptModulePath = fileURLToPath(import.meta.url);
const promptDir = dirname(promptModulePath);

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
  defaultName: string
): SkillMeta {
  // 支持跨平台换行符（Windows \r\n 和 Unix \n）
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (!match) {
    // frontmatter 缺失时使用默认值
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
    // YAML 解析失败时使用默认值
    return {
      name: defaultName,
      description: "",
      content: content.trim(),
    };
  }
}

/**
 * 遍历 skills 目录，读取所有 SKILL.md/skill.md 文件
 * 返回 Skill Map（key: skill name, value: SkillData）
 */
function loadSkills(): Map<string, SkillData> {
  const skillsDir = config.global.skills_dir;

  if (!existsSync(skillsDir)) return new Map();

  const skillMap = new Map<string, SkillData>();
  const dirs = readdirSync(skillsDir, { withFileTypes: true });

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dirName = dir.name;
    if (!dirName) continue;

    const skillPath = join(skillsDir, dirName);
    const files = readdirSync(skillPath);

    // 查找 SKILL.md 或 skill.md
    const skillFile = files.find((f) => f.toLowerCase() === "skill.md");
    if (!skillFile) continue;

    const fileContent = readFileSync(join(skillPath, skillFile), "utf-8");
    const meta = parseSkillFrontmatter(fileContent, dirName);

    // skill name 冲突时警告并覆盖
    if (skillMap.has(meta.name)) {
      console.warn(
        `[loadSkill] Warning: skill name "${meta.name}" conflict, overwriting with latest`
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

// 启动时一次性加载所有 skills
const skillMap = loadSkills();

/**
 * 获取完整 Skill Map
 */
export function getSkillMap(): Map<string, SkillData> {
  return skillMap;
}

/**
 * 获取单个 skill 数据
 * @param name skill name
 * @returns skill 数据，不存在时返回 undefined
 */
export function getSkill(name: string): SkillData | undefined {
  return skillMap.get(name);
}

/**
 * 获取所有 skill 的元数据（不含 content）
 * 用于 prompt 构建时注入 skill 列表
 */
export function getSkillMetas(): Array<{ name: string; description: string }> {
  return Array.from(skillMap.values()).map((s) => ({
    name: s.name,
    description: s.description,
  }));
}