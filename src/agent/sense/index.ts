import type { ZodType } from "zod";
import type { Sense } from "@/core/sense";
import type { TestCase } from "@/core/sense/compiler/types.js";
import { registerSenses, resetSenses } from "@/core/sense";
import { readdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { sense } from "@/core/sense";
import { SupervisionLevel } from "@/core/config";

// 显式导入所有感官模块
import bashSense from "./bash";
import readSense from "./read";
import writeSense from "./write";
import skillSense from "./skill";
import searchSense from "./search";
import spawnSense from "./spawn";
import todoSense from "./todo";
import memorySense from "./memory";
import mediaSenses from "./media";
import askSense from "./ask";
import { logger } from "@/utils/logger/index.js";

/**
 * 内置工具元信息（供 sense.tools API 返回，设置面板感官分组下拉用）。
 * name=原名（作 sense_groups 条目 key，须与各 sense 模块 definition.function.name 一致）；
 * label=中文名（UI 显示）；description=解释（tooltip）；icon=glyph/emoji 字符串（pet bar 运行中工具图标用）。
 */
export interface BuiltinSenseTool {
  name: string;
  label: string;
  description: string;
  icon: string;
}

/**
 * 代码维护的全部内置工具清单（sense.tools API 的数据源）。
 * 仅内置 sense；自定义/外部编译感官与 MCP 工具不在此列，前端组合框允许自由输入。
 * 新增内置 sense 时须同步追加此处（name 与模块一致）。icon 用 glyph/emoji（pet bar 运行中工具显示）。
 */
export const BUILTIN_SENSE_TOOLS: BuiltinSenseTool[] = [
  { name: "execute_command", label: "执行命令", description: "执行 shell 命令，可跑任意终端指令（危险）", icon: "💻" },
  { name: "read_file", label: "读取文件", description: "读文件内容，自动截断长文件与日志", icon: "📄" },
  { name: "write_file", label: "写入文件", description: "创建或编辑文件（危险）", icon: "✏️" },
  { name: "skill", label: "技能", description: "调用已注册的 Skill", icon: "⚡" },
  { name: "search_codebase", label: "搜索代码库", description: "按内容或文件名搜索代码", icon: "🔍" },
  { name: "spawn_role", label: "派遣角色", description: "派出角色执行子任务", icon: "👥" },
  { name: "update_todo", label: "更新待办", description: "增删改待办事项列表", icon: "📋" },
  { name: "generate_image", label: "生成图片", description: "调用配置的图片媒体服务", icon: "🖼️" },
  { name: "generate_video", label: "生成视频", description: "调用配置的视频媒体服务", icon: "🎬" },
  { name: "generate_audio", label: "生成音频", description: "调用配置的音频媒体服务", icon: "🔊" },
  { name: "memory_manage", label: "记忆管理", description: "管理项目记忆（增删改查 + 淘汰归档）", icon: "🧠" },
  { name: "ask_user_question", label: "询问用户", description: "向用户提结构化问题（2-4 选项 + 可选「其他」自由文本）", icon: "❓" },
];

/**
 * 注册内置感官。
 */
function registerBuiltinSenses(): void {
  registerSenses([bashSense, readSense, writeSense, skillSense, searchSense, spawnSense, todoSense, memorySense, askSense, ...mediaSenses]);
}

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
    logger.warn("⚠ 未找到编译产物目录，自定义感官未加载。请先运行 compile:senses 命令编译外部感官。");
    return;
  }

  const files = readdirSync(sensesDir);
  const jsFiles = files.filter(f => f.endsWith(".js"));

  if (jsFiles.length === 0) {
    logger.warn("⚠ 未找到编译产物，自定义感官未加载。请先运行 compile:senses 命令编译外部感官。");
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
        logger.info(`✓ 自定义感官已加载: ${result.definition.function.name}`);
      }
    } catch (err) {
      logger.warn(`⚠ 自定义感官加载失败: ${file}`, (err as Error).message);
    }
  }
}

/**
 * 重新构建全局 sense registry（内置感官 + 编译产物）。
 *
 * A 方案：供启动阶段和 compile-senses 命令结束后显式调用。
 * 长运行服务的热重载可复用该函数，但触发机制另行实现。
 */
export async function reloadSenses(): Promise<void> {
  resetSenses();
  registerBuiltinSenses();
  await loadCustomSenses();
}
