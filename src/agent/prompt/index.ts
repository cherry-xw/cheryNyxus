import { readFileSync, existsSync } from "fs";
import os from "os";
import path from "path";
import dayjs from "dayjs";
import config from "@/utils/config.js";
import { getSkillMetas } from "./loadSkill.js";
import { detectVcs, formatVcsBlock } from "@/utils/vcs.js";
import { readMemoryIndexContent, readMemoryIndex } from "@/memory/index.js";

/**
 * 全局 system prompt 固定路径：config.global.prompts_dir + "/system.md"（统一目录源）。
 * 模块加载期读取一次并缓存（override 走实时读取，支持每子 agent 不同文件）。
 */
const globalSystemPromptPath = path.join(config.global.prompts_dir, "system.md");
const systemPrompt = existsSync(globalSystemPromptPath)
  ? readFileSync(globalSystemPromptPath, "utf-8").trim()
  : "";

interface EnvInfo {
  os: string;
  date: string;
  time: string;
}

/** 提示词分段（计量用）：text 为段文本，count 为条目数（记忆条数 / skill 数）。 */
export interface PromptSegmentText {
  text: string;
  count?: number;
}

/** skills 段预聚合 token（getSkillMetas 一次性算好，buildSystemPromptSegments 直接累加）。 */
export interface SkillsSegmentTokens {
  nameDescTokens: number;
  triggerTokens: number;
  contentTokens: number;
  promptTokens: number;
}

/** buildSystemPromptSegments 返回值：系统提示词各分段（上下文分段计量用，单一数据源）。 */
export interface SystemPromptSegments {
  /** 系统提示词：全局 base + <environment> + <workspace>（**不含** override）。 */
  system: string;
  /** 用户系统提示词：override 补充（合并语义，给出时非空，可与 system 并存）。 */
  userSystem: string;
  /** 记忆：<memory global> + <memory workspace>，count = 记忆条数。 */
  memory: PromptSegmentText;
  /** 技能：<skills> 元数据，count = skill 数；token 字段由 computeSkillTokens 预计算后累加。 */
  skills: PromptSegmentText & SkillsSegmentTokens;
}

interface PromptPieces {
  globalBase: string;
  userSystem: string;
  envBlock: string; // <environment>...</environment>
  workspaceSection: string;
  memorySection: string;
  memoryCount: number;
  skillsInner: string;
  skillsCount: number;
  /** skill 段预聚合 token（从 getSkillMetas 复用，不在本模块重算）。 */
  skillsTokens: SkillsSegmentTokens;
  // 注意：内置命令（/.chery/command/*.md）不再预注入 system prompt；trigger 时由 send 路径临时附注。
  // 详见 docs/agent/command.md。
}

/**
 * 组装系统提示词各组成片段（buildFirstSystemPrompt 与分段计量共用，单一数据源）。
 * override 合并语义：给出则作补充拼接到全局 base 之后（**非**替换）；文件缺失 warn + 留空（仅全局 base）。
 */
function buildPromptPieces(promptPathOverride?: string, workspace?: string): PromptPieces {
  // override 路径实时读（每子 agent 可不同文件）；缺失容错仅用全局 base（配置期 validateRawConfig 已校验存在）
  let userSystem = "";
  if (promptPathOverride) {
    if (existsSync(promptPathOverride)) {
      userSystem = readFileSync(promptPathOverride, "utf-8").trim();
    } else {
      console.warn(`[prompt] systemPrompt override 文件不存在，仅用全局 base: ${promptPathOverride}`);
    }
  }

  const envInfo: EnvInfo = {
    os: `${os.type()} ${os.release()}`,
    date: dayjs().format("YYYY-MM-DD"),
    time: dayjs().toISOString(),
  };
  const envBlock = `<environment>
操作系统: ${envInfo.os}
当前日期: ${envInfo.date}
当前时间: ${envInfo.time}
</environment>`;

  // workspace（预设级项目工作目录）：仅提示词层声明本会话专属该项目，不改变 sense 实际行为
  let workspaceSection = "";
  if (workspace) {
    const vcsBlock = formatVcsBlock(detectVcs(workspace));
    const vcsLine = vcsBlock ? `\n${vcsBlock}` : "";
    workspaceSection = `\n\n<workspace>\n当前工作区: ${workspace}\n本会话用于开发该项目，文件操作与命令以此目录为基准。${vcsLine}\n</workspace>`;
  }

  // 项目记忆：双层注入（仅在初始化时一次性注入；不动态更新）
  //   <memory layer="global">    所有 chat 共享（用户习惯/事实/准则）
  //   <memory layer="workspace"> 当前 chat（项目行为规范）
  const globalContent = readMemoryIndexContent(undefined, "global");
  const wsContent = readMemoryIndexContent(workspace, "workspace");
  const memoryParts: string[] = [];
  if (globalContent) {
    memoryParts.push(
      `<memory layer="global">\n以下是全局活跃记忆（所有 chat 共享，最多 ${config.memory?.global?.max_count ?? 30} 条），通过 memory_manage 工具的 scope="global" 管理。\n${globalContent}\n</memory>`,
    );
  }
  if (wsContent) {
    memoryParts.push(
      `<memory layer="workspace">\n以下是当前 workspace 活跃记忆（最多 ${config.memory?.workspace?.max_count ?? 15} 条），通过 memory_manage 工具的 scope="workspace" 管理。\n${wsContent}\n</memory>`,
    );
  }
  const memorySection = memoryParts.length ? `\n\n${memoryParts.join("\n\n")}` : "";
  const memoryCount =
    readMemoryIndex(undefined, "global").length + readMemoryIndex(workspace, "workspace").length;

  // P1-5：trigger 作为软提示注入 skill 描述，供 LLM 判断何时自动触发该 skill
  const skillMetas = getSkillMetas();
  const skillsInner = skillMetas
    .map((s) => {
      const trigger = s.trigger ? `\n触发条件: ${s.trigger}` : "";
      return `<skill name="${s.name}">\n${s.description}${trigger}\n</skill>`;
    })
    .join("\n");
  // 累加 skill 段预计算 token（loadSkill 集中算好，不在本模块重算）
  const skillsTokens = skillMetas.reduce<SkillsSegmentTokens>(
    (acc, s) => ({
      nameDescTokens: acc.nameDescTokens + s.nameDescTokens,
      triggerTokens: acc.triggerTokens + s.triggerTokens,
      contentTokens: acc.contentTokens + s.contentTokens,
      promptTokens: acc.promptTokens + s.promptTokens,
    }),
    { nameDescTokens: 0, triggerTokens: 0, contentTokens: 0, promptTokens: 0 },
  );
  // 内置命令（/.chery/command/*.md）不在默认 system prompt 注入；trigger 时由 autoCompact / manual
  // 路径临时附注到 user prompt 末尾。详见 docs/agent/command.md。

  return {
    globalBase: systemPrompt,
    userSystem,
    envBlock,
    workspaceSection,
    memorySection,
    memoryCount,
    skillsInner,
    skillsCount: skillMetas.length,
    skillsTokens,
  };
}

/**
 * 构建系统提示词各分段（上下文分段计量用）。
 * system 段含全局 base + <environment> + <workspace>（**不含** override），
 * userSystem 段为 override 补充；二者 token 之和 = 实际 <system-reminder> 内 body（合并）。
 */
export function buildSystemPromptSegments(promptPathOverride?: string, workspace?: string): SystemPromptSegments {
  const p = buildPromptPieces(promptPathOverride, workspace);
  return {
    system: `<system-reminder>\n${p.globalBase}\n</system-reminder>\n\n${p.envBlock}${p.workspaceSection}`,
    userSystem: p.userSystem,
    memory: { text: p.memorySection, count: p.memoryCount },
    skills: {
      text: `<skills>\n${p.skillsInner}\n</skills>`,
      count: p.skillsCount,
      ...p.skillsTokens,
    },
  };
}

/**
 * 构建首条 system prompt（全局 base + override **合并**）。
 * @param promptPathOverride 可选，per-subagent / 预设 main 的专属 system prompt 文件绝对路径；
 *   给出则作**补充**合并到全局 base 之后（合并非替换，支持每子 agent 不同 prompt 文件）；
 *   文件缺失 warn + 仅用全局 base（配置期 validateRawConfig 已 existsSync 校验）。缺省 → 仅全局 base。
 * @param workspace 可选，预设级项目工作目录（注入 <workspace> 段）。
 */
export default function buildFirstSystemPrompt(promptPathOverride?: string, workspace?: string): string {
  const p = buildPromptPieces(promptPathOverride, workspace);
  // 合并：全局 base 在前为基础，override 在后为补充
  const body = p.userSystem ? `${p.globalBase}\n\n${p.userSystem}` : p.globalBase;
  return `<system-reminder>
${body}
</system-reminder>

${p.envBlock}${p.workspaceSection}${p.memorySection}

<skills>
${p.skillsInner}
</skills>`;
}
