import { readFileSync, existsSync } from "fs";
import os from "os";
import dayjs from "dayjs";
import config from "@/utils/config.js";
import { getSkillMetas } from "./loadSkill.js";

const systemPromptPath = config.global.system_prompt;
const systemPrompt = existsSync(systemPromptPath)
  ? readFileSync(systemPromptPath, "utf-8").trim()
  : "";

interface EnvInfo {
  os: string;
  date: string;
  time: string;
}

/**
 * 构建首条 system prompt。
 */
export default function buildFirstSystemPrompt(): string {
  const envInfo: EnvInfo = {
    os: `${os.type()} ${os.release()}`,
    date: dayjs().format("YYYY-MM-DD"),
    time: dayjs().toISOString(),
  };

  const skillsSection = getSkillMetas()
    .map((s) => `<skill name="${s.name}">\n${s.description}\n</skill>`)
    .join("\n");

  return `<system-reminder>
${systemPrompt}
</system-reminder>

<environment>
操作系统: ${envInfo.os}
当前日期: ${envInfo.date}
当前时间: ${envInfo.time}
</environment>

<skills>
${skillsSection}
</skills>`;
}
