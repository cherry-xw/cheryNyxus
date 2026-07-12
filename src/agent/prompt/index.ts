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
 * @param promptPathOverride 可选，per-subagent / 预设 main 的专属 system prompt 文件绝对路径；
 *   给出则实时读取（非模块缓存），缺失 warn + 退回全局 systemPrompt。缺省 → 全局。
 */
export default function buildFirstSystemPrompt(promptPathOverride?: string): string {
  // override 路径实时读（每子 agent 可不同文件）；缺失容错退回全局（配置期 validateRawConfig 已校验存在）
  let body: string;
  if (promptPathOverride) {
    if (existsSync(promptPathOverride)) {
      body = readFileSync(promptPathOverride, "utf-8").trim();
    } else {
      console.warn(`[prompt] systemPrompt override 文件不存在，退回全局: ${promptPathOverride}`);
      body = systemPrompt;
    }
  } else {
    body = systemPrompt;
  }

  const envInfo: EnvInfo = {
    os: `${os.type()} ${os.release()}`,
    date: dayjs().format("YYYY-MM-DD"),
    time: dayjs().toISOString(),
  };

  // P1-5：trigger 作为软提示注入 skill 描述，供 LLM 判断何时自动触发该 skill
  const skillsSection = getSkillMetas()
    .map((s) => {
      const trigger = s.trigger ? `\n触发条件: ${s.trigger}` : "";
      return `<skill name="${s.name}">\n${s.description}${trigger}\n</skill>`;
    })
    .join("\n");

  return `<system-reminder>
${body}
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
