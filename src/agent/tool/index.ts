import type { ZodType } from "zod";
import type { Tool } from "@/core/tool";
import type { TestCase } from "@/core/tool/compiler/types.js";
import { registerTools } from "@/core/tool";
import { readdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { tool } from "@/core/tool";
import { SupervisionLevel } from "@/core/tool";

// 显式导入所有工具模块
import bashTool from "./bash";
import readTool from "./read";
import writeTool from "./write";
import skillTool from "./skill";

export { registerTools, getTools, ToolManager } from "@/core/tool";
export type { Tool, ToolResult } from "@/core/tool";
export { SupervisionLevel } from "@/core/tool";
export { z } from "zod";
export { tool } from "@/core/tool";

/**
 * 注册内置工具
 */
function registerStaticTools(): void {
  registerTools([bashTool, readTool, writeTool, skillTool]);
}

// 启动时立即注册内置工具
registerStaticTools();

/**
 * 测试结果详情
 */
export interface TestResultDetail {
  passed: boolean;
  passedCount: number;
  totalCount: number;
  failures: { input: unknown; expected: unknown; actual: unknown }[];
  error?: string;
}

/**
 * 执行工具自测用例
 * 返回详细测试结果
 */
export async function runToolTests(
  toolInstance: Tool<ZodType>,
  testCases: TestCase[],
): Promise<TestResultDetail> {
  const failures: { input: unknown; expected: unknown; actual: unknown }[] = [];
  let passedCount = 0;

  for (const tc of testCases) {
    try {
      const parsedInput = toolInstance.executor.schema.parse(tc.input);
      const result = await toolInstance.executor.execute(parsedInput, new Map());
      if (result.content !== tc.output.content || result.hash !== tc.output.hash) {
        failures.push({
          input: tc.input,
          expected: tc.output,
          actual: result,
        });
      } else {
        passedCount++;
      }
    } catch (err) {
      return {
        passed: false,
        passedCount,
        totalCount: testCases.length,
        failures,
        error: (err as Error).message,
      };
    }
  }

  return {
    passed: failures.length === 0,
    passedCount,
    totalCount: testCases.length,
    failures,
  };
}

// 提供运行时上下文给 new Function() 执行
const runtimeContext = {
  z,
  tool,
  SupervisionLevel,
  registerTools,
};

/**
 * 动态加载自定义工具（从编译产物目录）
 * 使用 new Function() 在当前上下文执行，无需 import
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
      const code = readFileSync(filePath, "utf-8");
      // 移除 hash 注释行
      const pureCode = code.replace(/^\/\/ hash:[a-f0-9]+\n/, "");

      // 使用 new Function 在当前上下文执行
      // 传入运行时上下文变量
      const fn = new Function("z", "tool", "SupervisionLevel", "registerTools", pureCode);
      const result = fn(
        runtimeContext.z,
        runtimeContext.tool,
        runtimeContext.SupervisionLevel,
        runtimeContext.registerTools,
      );

      // 如果代码返回 tool 实例，直接注册
      if (result?.definition?.function?.name) {
        registerTools([result]);
        console.log(`✓ 自定义工具已加载: ${result.definition.function.name}`);
      }
    } catch (err) {
      console.warn(`⚠ 自定义工具加载失败: ${file}`, (err as Error).message);
    }
  }
}

/**
 * 确保工具已加载完成（内置工具 + 自定义工具）
 */
export async function ensureCustomToolsLoaded(): Promise<void> {
  await loadCustomTools();
}
