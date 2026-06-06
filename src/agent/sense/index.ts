import type { ZodType } from "zod";
import type { Sense } from "@/core/sense";
import type { TestCase } from "@/core/sense/compiler/types.js";
import { registerSenses } from "@/core/sense";
import { readdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { sense } from "@/core/sense";
import { SupervisionLevel } from "@/core/sense";

// 显式导入所有感官模块
import bashSense from "./bash";
import readSense from "./read";
import writeSense from "./write";
import skillSense from "./skill";

export { registerSenses, getSenses, SenseManager } from "@/core/sense";
export type { Sense, SenseResult } from "@/core/sense";
export { SupervisionLevel } from "@/core/sense";
export { z } from "zod";
export { sense } from "@/core/sense";

/**
 * 注册内置感官
 */
function registerStaticSenses(): void {
  registerSenses([bashSense, readSense, writeSense, skillSense]);
}

// 启动时立即注册内置感官
registerStaticSenses();

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
 * 执行感官自测用例
 * 返回详细测试结果
 */
export async function runSenseTests(
  senseInstance: Sense<ZodType>,
  testCases: TestCase[],
): Promise<TestResultDetail> {
  const failures: { input: unknown; expected: unknown; actual: unknown }[] = [];
  let passedCount = 0;

  for (const tc of testCases) {
    try {
      const parsedInput = senseInstance.executor.schema.parse(tc.input);
      const result = await senseInstance.executor.execute(parsedInput, new Map());
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
  sense,
  SupervisionLevel,
  registerSenses,
};

/**
 * 动态加载自定义感官（从编译产物目录）
 * 使用 new Function() 在当前上下文执行，无需 import
 */
async function loadCustomSenses(): Promise<void> {
  const sensesDir = join(dirname(fileURLToPath(import.meta.url)), "senses");

  if (!existsSync(sensesDir)) {
    console.warn("⚠ 未找到编译产物目录，自定义感官未加载。请先运行 compile:senses 命令编译外部感官。");
    return;
  }

  const files = readdirSync(sensesDir);
  const jsFiles = files.filter(f => f.endsWith(".js"));

  if (jsFiles.length === 0) {
    console.warn("⚠ 未找到编译产物，自定义感官未加载。请先运行 compile:senses 命令编译外部感官。");
    return;
  }

  for (const file of jsFiles) {
    const filePath = join(sensesDir, file);
    try {
      const code = readFileSync(filePath, "utf-8");
      // 移除 hash 注释行
      const pureCode = code.replace(/^\/\/ hash:[a-f0-9]+\n/, "");

      // 使用 new Function 在当前上下文执行
      // 传入运行时上下文变量
      const fn = new Function("z", "sense", "SupervisionLevel", "registerSenses", pureCode);
      const result = fn(
        runtimeContext.z,
        runtimeContext.sense,
        runtimeContext.SupervisionLevel,
        runtimeContext.registerSenses,
      );

      // 如果代码返回 sense 实例，直接注册
      if (result?.definition?.function?.name) {
        registerSenses([result]);
        console.log(`✓ 自定义感官已加载: ${result.definition.function.name}`);
      }
    } catch (err) {
      console.warn(`⚠ 自定义感官加载失败: ${file}`, (err as Error).message);
    }
  }
}

/**
 * 确保感官已加载完成（内置感官 + 自定义感官）
 */
export async function ensureCustomSensesLoaded(): Promise<void> {
  await loadCustomSenses();
}