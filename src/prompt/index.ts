import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { getSkillMetas } from "./loadSkill.js";
import { getEnvInfo } from "@/utils/env.js";

// ESM 下获取当前模块目录
const promptModulePath = fileURLToPath(import.meta.url);
const promptDir = dirname(promptModulePath);

const systemPrompt = readFileSync(join(promptDir, "system.md"), "utf-8").trim();

/**
 * 构建完整 prompt
 * @param userPrompt 用户传入的 prompt
 * @returns 格式化的完整 prompt
 */
export default function buildFirstSystemPrompt(): string {
  const skills = getSkillMetas();
  const envInfo = getEnvInfo();

  const skillsSection = skills
    .map((s) => `<skill name="${s.name}">\n${s.description}\n</skill>`)
    .join("\n");

  return `<system-reminder>
${systemPrompt}
</system-reminder>

<environment>
工作目录: ${envInfo.workDir}
操作系统: ${envInfo.os}
当前日期: ${envInfo.date}
当前时间: ${envInfo.time}
</environment>

<skills>
${skillsSection}
</skills>`;
}
