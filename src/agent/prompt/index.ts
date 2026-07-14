import { readFileSync, existsSync } from "fs";
import os from "os";
import dayjs from "dayjs";
import config from "@/utils/config.js";
import { getSkillMetas } from "./loadSkill.js";
import { detectVcs, formatVcsBlock } from "@/utils/vcs.js";
import { readMemoryIndexContent } from "@/memory/index.js";

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
export default function buildFirstSystemPrompt(promptPathOverride?: string, workspace?: string): string {
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

  // workspace（预设级项目工作目录）：仅提示词层声明本会话专属该项目，不改变 sense 实际行为
  // 自动探测 VCS（git/svn）并挂载默认元信息，AI 可感知分支/状态/远程等背景
  let workspaceSection = "";
  if (workspace) {
    const vcsBlock = formatVcsBlock(detectVcs(workspace));
    const vcsLine = vcsBlock ? `\n${vcsBlock}` : "";
    workspaceSection = `\n\n<workspace>\n当前工作区: ${workspace}\n本会话用于开发该项目，文件操作与命令以此目录为基准。${vcsLine}\n</workspace>`;
  }

  // 项目记忆：读取 MEMORY.md 汇总索引注入 <memory> 段（初始化时一次性注入，不动态更新）
  const memoryContent = readMemoryIndexContent(workspace);
  const memorySection = memoryContent
    ? `\n\n<memory>\n以下是项目活跃记忆（最多 ${config.memory?.max_count ?? 15} 条），通过 memory_manage 工具管理。\n${memoryContent}\n</memory>`
    : "";

  return `<system-reminder>
${body}
</system-reminder>

<environment>
操作系统: ${envInfo.os}
当前日期: ${envInfo.date}
当前时间: ${envInfo.time}
</environment>${workspaceSection}${memorySection}

<skills>
${skillsSection}
</skills>`;
}
