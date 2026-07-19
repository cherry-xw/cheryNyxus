/**
 * Settings 面板共享纯函数。依赖 draft/senseTools 的 mutate 操作留在各自 tab 内。
 */
import type { SenseToolInfo } from "@/services/agentApi";
import { DANGEROUS_SENSES } from "./constants";

/** entry = "name" 或 "name:level"，取工具名部分。 */
export function toolName(entry: string): string {
  const idx = entry.indexOf(":");
  return idx >= 0 ? entry.slice(0, idx) : entry;
}

/** entry = "name" 或 "name:level"，取监管等级部分（空=继承）。 */
export function toolLevel(entry: string): string {
  const idx = entry.indexOf(":");
  return idx >= 0 ? entry.slice(idx + 1) : "";
}

/** entry 工具名命中内置工具则返回其元信息（行内显示 label + description tooltip）。 */
export function matchedTool(entry: string, senseTools: SenseToolInfo[]): SenseToolInfo | undefined {
  return senseTools.find((t) => t.name === toolName(entry));
}

export function isDangerousSense(entry: string): boolean {
  const base = entry.split(":")[0] ?? "";
  return DANGEROUS_SENSES.includes(base);
}

/**
 * 计算装备 token 总和：values 为空（继承全部模式）则按 options 全量累加。
 * RolesTab.roleTokens / EquipmentPicker.tokens 共用，消除重复估算逻辑。
 * MCP 等无后端 token 数据的资源，调用方在 tokenMap 里填占位值（如 200）。
 */
export function computeSelectionTokens(
  values: string[] | undefined,
  options: string[],
  tokenMap: Record<string, number>,
): number {
  return (values ?? options).reduce((sum, name) => sum + (tokenMap[name] ?? 0), 0);
}
