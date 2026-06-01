import type { ZodType } from "zod";
import type { Tool } from "@/core/tool";
import type { TestCase } from "@/utils/toolCompiler.js";
import { registerTool, registerTools, getTool, getTools, getToolSupervision } from "@/core/tool";
import { readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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
 * 执行工具自测用例
 * 任一用例失败返回 false
 */
export async function runToolTests(
  toolInstance: Tool<ZodType>,
  testCases: TestCase[],
): Promise<boolean> {
  for (const tc of testCases) {
    try {
      const parsedInput = toolInstance.executor.schema.parse(tc.input);
      const result = await toolInstance.executor.execute(parsedInput, new Map());
      if (result.content !== tc.output.content || result.hash !== tc.output.hash) {
        console.error(
          `✗ 工具测试失败: ${toolInstance.definition.function.name}`,
          `\n  input:    ${JSON.stringify(tc.input)}`,
          `\n  expected: ${JSON.stringify(tc.output)}`,
          `\n  actual:   ${JSON.stringify(result)}`,
        );
        return false;
      }
    } catch (err) {
      console.error(
        `✗ 工具测试执行异常: ${toolInstance.definition.function.name}`,
        (err as Error).message,
      );
      return false;
    }
  }
  return true;
}

/**
 * 动态加载自定义工具（从 index.js 同级的 tools/ 目录）
 * 需先通过 compile:tools 命令编译外部工具
 */
async function loadCustomTools(): Promise<void> {
  const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "tools");

  if (!existsSync(toolsDir)) {
    console.warn("⚠ 未找到编译产物目录，自定义工具未加载。请先运行 compile:tools 命令编译外部工具。");
    return;
  }

  const files = readdirSync(toolsDir);
  const jsFiles = files.filter(f => f.endsWith(".js"));

  if (jsFiles.length === 0) {
    console.warn("⚠ 未找到编译产物，自定义工具未加载。请先运行 compile:tools 命令编译外部工具。");
    return;
  }

  for (const file of jsFiles) {
    const filePath = join(toolsDir, file);
    try {
      const module = await import(filePath);
      const toolInstance = module.default as Tool<ZodType>;

      if (toolInstance?.definition?.function?.name) {
        registerTool(toolInstance);
        console.log(`✓ 自定义工具已加载: ${toolInstance.definition.function.name}`);
      }
    } catch (err) {
      console.warn(`⚠ 自定义工具加载失败: ${file}`, (err as Error).message);
    }
  }
}

/**
 * 确保工具已加载完成（内置工具 + 自定义工具）
 */
export async function ensureToolsLoaded(): Promise<void> {
  await loadCustomTools();
}
