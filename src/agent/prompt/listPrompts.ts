import { readdirSync, existsSync } from "fs";
import { join, relative, dirname, sep } from "path";
import config from "@/utils/config.js";

/**
 * 递归遍历 .chery/prompts/，收集所有 .md 文件的相对路径（相对 .chery/，含 prompts/ 前缀）。
 * 支持任意层级子文件夹——一组相关角色 prompt 放一个子文件夹（如 prompts/prefebMain/*.md）。
 * 实时遍历不缓存（类比 loadSkill readAllSkills），新增/改动/新建子文件夹下次调用即反映。
 *
 * 目录不存在或为空 → 返 []（合法状态，非错误，不 fail loud）。
 * 返回值即 systemPrompt 的存储值（相对 .chery/ 路径），供 prompts.list RPC + 前端级联选择器。
 */
export function listPrompts(): string[] {
  const promptsDir = config.global.prompts_dir;
  if (!existsSync(promptsDir)) return [];

  const cheryDir = dirname(promptsDir); // .chery/ = prompts 的父目录
  const result: string[] = [];

  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
        result.push(relative(cheryDir, full).split(sep).join("/"));
      }
    }
  };

  walk(promptsDir);
  return result.sort();
}
