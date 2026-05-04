import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import yaml from "js-yaml";

// ESM 下获取当前模块目录
const promptModulePath = fileURLToPath(import.meta.url);
const promptDir = dirname(promptModulePath);

const systemPrompt = readFileSync(
  join(promptDir, "system.md"),
  "utf-8"
).trim();

interface SkillMeta {
  name: string;
  description: string;
}

/**
 * 解析 SKILL.md 文件的 frontmatter
 */
function parseSkillFrontmatter(content: string): SkillMeta | null {
  // 支持跨平台换行符（Windows \r\n 和 Unix \n）
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  try {
    const frontmatter = yaml.load(match[1]!) as Record<string, unknown>;
    return {
      name: (frontmatter.name as string) || "",
      description: (frontmatter.description as string) || "",
    };
  } catch {
    return null;
  }
}

/**
 * 遍历 skills 目录，读取所有 SKILL.md/skill.md 文件
 */
function loadSkills(): SkillMeta[] {
  const skillsDir = join(promptDir, "../skills");
  if (!existsSync(skillsDir)) return [];

  const skills: SkillMeta[] = [];
  const dirs = readdirSync(skillsDir, { withFileTypes: true });

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dirName = dir.name;
    if (!dirName) continue;

    const skillPath = join(skillsDir, dirName);
    const files = readdirSync(skillPath);

    // 查找 SKILL.md 或 skill.md
    const skillFile = files.find(
      (f) => f.toLowerCase() === "skill.md"
    );
    if (!skillFile) continue;

    const content = readFileSync(join(skillPath, skillFile), "utf-8");
    const meta = parseSkillFrontmatter(content);
    if (meta) skills.push(meta);
  }

  return skills;
}

/**
 * 构建完整 prompt
 * @param userPrompt 用户传入的 prompt
 * @returns 格式化的完整 prompt
 */
export default function buildPrompt(userPrompt: string): string {
  const skills = loadSkills();

  const skillsSection = skills
    .map((s) => `<skill name="${s.name}" description="${s.description}" />`)
    .join("\n");

  return `<system>
${systemPrompt}
</system>

<skills>
${skillsSection}
</skills>

<user-question>
${userPrompt}
</user-question>`;
}