import type { ZodType } from "zod";
import type { Tool } from "@/core/tool";
import { registerTools, registerTool, getTool, getTools, getToolSupervision } from "@/core/tool";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import config from "@/utils/config.js";
import { preprocessAndCompileAllTools } from "@/utils/toolCompiler.js";

// 导出 zod 和 tool 函数，供外部 tool 编译后使用
export { z } from "zod";
export { tool } from "@/core/tool";

// 显式导入所有工具模块
import bashTool from "./bash";
import readTool from "./read";
import writeTool from "./write";
import skillTool from "./skill";

export { registerTool, registerTools, getTool, getTools, getToolSupervision, ToolManager } from "@/core/tool";
export type { Tool, ToolResult } from "@/core/tool";
export { SupervisionLevel } from "@/core/tool";

/**
 * 注册内置工具
 */
function registerStaticTools(): void {
  registerTools([bashTool, readTool, writeTool, skillTool]);
}

// 启动时立即注册内置工具
registerStaticTools();

/**
 * 动态加载自定义工具（从 dist/custom/ 目录）
 */
async function loadCustomTools(): Promise<void> {
  const cheryDir = config.global.chery_dir || process.cwd();
  const customDir = join(cheryDir, "dist", "custom");

  // 预处理并编译所有外部 tool 文件
  const compiledPaths = await preprocessAndCompileAllTools();

  if (compiledPaths.length === 0) {
    // 检查是否已有编译产物
    if (!existsSync(customDir)) return;

    const files = readdirSync(customDir);
    const jsFiles = files.filter(f => f.endsWith(".js"));

    for (const file of jsFiles) {
      const filePath = join(customDir, file);
      try {
        const module = await import(filePath);
        const tool = module.default as Tool<ZodType>;

        if (tool?.definition?.function?.name) {
          registerTool(tool);
          console.log(`✓ 自定义工具已加载: ${tool.definition.function.name}`);
        }
      } catch (err) {
        console.warn(`⚠ 自定义工具加载失败: ${file}`, (err as Error).message);
      }
    }
    return;
  }

  // 加载新编译的文件
  for (const compiledPath of compiledPaths) {
    try {
      const module = await import(compiledPath);
      const tool = module.default as Tool<ZodType>;

      if (tool?.definition?.function?.name) {
        registerTool(tool);
        console.log(`✓ 自定义工具已加载: ${tool.definition.function.name}`);
      }
    } catch (err) {
      console.warn(`⚠ 自定义工具加载失败: ${compiledPath}`, (err as Error).message);
    }
  }
}

/**
 * 确保工具已加载完成（内置工具 + 自定义工具）
 */
export async function ensureToolsLoaded(): Promise<void> {
  await loadCustomTools();
}