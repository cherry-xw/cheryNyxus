/**
 * 插件列表后端（settings 「插件」tab）：列出 .chery/plugins/* 与其 manifest + 内含 skills。
 *
 * skill 发现复用 loadSkill.discoverSkillRoots（与 loader 加载逻辑同源），保证列表展示与
 * 实际注入 system prompt 的插件 skill 一致。skill 名为对外命名空间名 `<plugin>__<skill>`。
 *
 * token 计算：复用 loadSkill.loadSkillFromFolder + computeSkillTokens（与 skills.list 同源单一口径），
 * 为每个 skill 填 nameDescTokens/triggerTokens/contentTokens；buildPluginInfo 据此聚合 totalSystemTokens
 * 与 min/maxContentTokens 供插件卡展示。
 */
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import type { HandlerContext } from "../message/router.js";
import type { PluginsListResponseData, PluginSkillInfo, PluginInfo } from "../message/types.js";
import { discoverSkillRoots, loadSkillFromFolder, computeSkillTokens } from "@/agent/prompt/loadSkill.js";
import { pluginsDir } from "../skill/importShared.js";
import { readManifest } from "./registry.js";

/** 列出插件内 skills（对外名 `<plugin>__<skill>` + description + trigger + 单 skill token）。
 *  读取失败（fs/parse 错误）的 skill 回退到空 desc + 0 token（保留入口，不阻断列表）。 */
export function listPluginSkills(pluginName: string, dir: string): PluginSkillInfo[] {
  const skills: PluginSkillInfo[] = [];
  for (const loc of discoverSkillRoots(dir)) {
    const skillData = loadSkillFromFolder(loc.skillDir, { plugin: pluginName, defaultName: loc.defaultName });
    if (!skillData) {
      // 与旧 peekSkillMeta-空回退行为一致：保留 entry，描述空、token 0。
      skills.push({
        name: `${pluginName}__${loc.defaultName}`,
        description: "",
        nameDescTokens: 0,
        triggerTokens: 0,
        contentTokens: 0,
      });
      continue;
    }
    const tokens = computeSkillTokens(skillData);
    skills.push({
      name: skillData.name,
      description: skillData.description,
      trigger: skillData.trigger,
      nameDescTokens: tokens.nameDescTokens,
      triggerTokens: tokens.triggerTokens,
      contentTokens: tokens.contentTokens,
    });
  }
  return skills;
}

/** 构建单个 PluginInfo（manifest + skills 扫描 + token 聚合）。manifest 缺失则字段为空串。 */
export function buildPluginInfo(name: string): PluginInfo | undefined {
  const dir = join(pluginsDir(), name);
  if (!existsSync(dir) || !readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory())) {
    // 仅要求目录存在即可（空插件也列出，便于卸载）
  }
  const m = readManifest(name);
  const skills = listPluginSkills(name, dir);
  // 聚合：system = Σ(nameDesc + trigger)；content 取 min/max（空数组均 0）。
  const totalSystemTokens = skills.reduce(
    (sum, s) => sum + s.nameDescTokens + (s.triggerTokens ?? 0),
    0,
  );
  const minContentTokens = skills.length > 0
    ? Math.min(...skills.map((s) => s.contentTokens))
    : 0;
  const maxContentTokens = skills.length > 0
    ? Math.max(...skills.map((s) => s.contentTokens))
    : 0;
  return {
    name,
    sourceUrl: m?.sourceUrl ?? "",
    cloneUrl: m?.cloneUrl ?? "",
    branch: m?.branch ?? "",
    commitSha: m?.commitSha ?? "",
    commitDate: m?.commitDate ?? "",
    installedAt: m?.installedAt ?? "",
    updatedAt: m?.updatedAt ?? "",
    lastCheckedAt: m?.lastCheckedAt,
    latestSha: m?.latestSha,
    latestDate: m?.latestDate,
    updateAvailable: m?.updateAvailable,
    totalSystemTokens,
    minContentTokens,
    maxContentTokens,
    skills,
  };
}

/** plugins.list：列出全部已安装插件。 */
export async function handlePluginsList(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<PluginsListResponseData> {
  const dir = pluginsDir();
  if (!existsSync(dir)) return { plugins: [] };
  const plugins: PluginInfo[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const info = buildPluginInfo(e.name);
    if (info) plugins.push(info);
  }
  return { plugins };
}
