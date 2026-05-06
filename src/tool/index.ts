import type { ZodType } from "zod";
import type { Tool } from "./base/toolCreator";
import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export {
  tool,
} from "./base/toolCreator";
export type { Tool };
export * from "./adapter.ts";
export { ToolManager } from "./base/toolManager";

/**
 * 工具注册表：工具名 → Tool 实例
 * 用于按名称获取工具实例
 */
const toolRegistry: Record<string, Tool<ZodType>> = {};

/**
 * 动态加载 handle 目录下的所有工具模块
 */
async function loadTools(): Promise<void> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const handleDir = join(currentDir, "handle");

  const files = readdirSync(handleDir)
    .filter(file => file.endsWith(".ts") && !file.endsWith(".d.ts"));

  await Promise.all(
    files.map(async (file) => {
      const modulePath = join(handleDir, file);
      const module = await import(`file://${modulePath}`);
      const tool = module.default as Tool<ZodType>;
      if (tool?.definition?.function?.name) {
        toolRegistry[tool.definition.function.name] = tool;
      }
    })
  );
}

// 启动时加载所有工具
const loadPromise = loadTools();

/**
 * 确保工具已加载完成
 */
export async function ensureToolsLoaded(): Promise<void> {
  await loadPromise;
}

/**
 * 获取单个工具实例
 * @param name 工具名称
 * @returns Tool 实例或 undefined
 */
export function getTool(name: string): Tool<ZodType> | undefined {
  return toolRegistry[name];
}

/**
 * 批量获取工具实例
 * @param names 工具名称列表
 * @returns Tool 实例数组（过滤掉未找到的工具）
 */
export function getTools(names: string[]): Tool<ZodType>[] {
  return names.map(name => toolRegistry[name]).filter((tool): tool is Tool<ZodType> => tool !== undefined);
}
