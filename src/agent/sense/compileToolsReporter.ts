import { pathToFileURL } from "url";
import { runSenseTests, type TestResultDetail } from "./index.js";
import type { CompiledSenseInfo, SenseCompileSummary } from "@/core/sense/compiler/index.js";

const ANSI = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
};

function formatPath(sourcePath: string): string {
  return sourcePath.split("/").pop() ?? sourcePath;
}

function pad(str: string, len: number): string {
  return str.padEnd(len, " ");
}

interface TestInfo {
  detail: TestResultDetail;
}

export function reportSenseCompileResult(
  summary: SenseCompileSummary,
  testResults: Map<string, TestInfo>,
): void {
  interface Row {
    name: string;
    compileOk: boolean;
    testStatus: "none" | "pass" | "fail";
    testInfo?: string;
  }

  interface Failure {
    name: string;
    type: "compile" | "test";
    message?: string;
    testFailures?: { input: unknown; expected: unknown; actual: unknown }[];
  }

  const rows: Row[] = [];
  const failures: Failure[] = [];

  // 编译失败的
  for (const f of summary.failed) {
    const name = formatPath(f.sourcePath);
    rows.push({ name, compileOk: false, testStatus: "none" });
    failures.push({ name, type: "compile", message: f.message });
  }

  // 编译成功的
  for (const info of summary.succeeded) {
    const name = formatPath(info.sourcePath);
    const testInfo = testResults.get(info.sourcePath);

    const row: Row = {
      name,
      compileOk: true,
      testStatus: info.testCases.length === 0 ? "none" : testInfo?.detail.passed ? "pass" : "fail",
    };

    if (info.testCases.length > 0 && testInfo) {
      const { passedCount, totalCount } = testInfo.detail;
      row.testInfo = `${passedCount}/${totalCount}`;
      if (!testInfo.detail.passed) {
        failures.push({
          name,
          type: "test",
          testFailures: testInfo.detail.failures,
          message: testInfo.detail.error,
        });
      }
    }

    rows.push(row);
  }

  // 统计
  const compileOkCount = rows.filter((r) => r.compileOk).length;
  const compileFailCount = rows.filter((r) => !r.compileOk).length;
  const testPassCount = rows.filter((r) => r.testStatus === "pass").length;
  const testFailCount = rows.filter((r) => r.testStatus === "fail").length;
  const noTestCount = rows.filter((r) => r.testStatus === "none").length;

  // 输出表格
  const col1 = 20;
  const col2 = 8;
  const col3 = 10;
  console.log(`\n${pad("脚本", col1)}${pad("编译", col2)}${pad("测试", col3)}`);
  console.log("─".repeat(col1 + col2 + col3));

  for (const row of rows) {
    // 编译标记（不带颜色用于计算宽度）
    const compileRaw = row.compileOk ? "✓" : "✗";
    const compileMark = row.compileOk ? `${ANSI.green}✓${ANSI.reset}` : `${ANSI.red}✗${ANSI.reset}`;
    // 测试标记
    let testRaw = "-";
    let testMark = "-";
    if (row.testStatus === "pass") {
      testRaw = `✓ ${row.testInfo}`;
      testMark = `${ANSI.green}✓ ${row.testInfo}${ANSI.reset}`;
    } else if (row.testStatus === "fail") {
      testRaw = `✗ ${row.testInfo}`;
      testMark = `${ANSI.red}✗ ${row.testInfo}${ANSI.reset}`;
    }
    // 使用原始字符串计算宽度，颜色码不占显示宽度
    const compilePad = " ".repeat(col2 - compileRaw.length);
    const testPad = " ".repeat(col3 - testRaw.length);
    console.log(`${pad(row.name, col1)}${compileMark}${compilePad}${testMark}${testPad}`);
  }

  // 统计摘要
  console.log(
    `\n统计：${ANSI.green}${compileOkCount} 编译成功${ANSI.reset}，` +
      `${compileFailCount > 0 ? `${ANSI.red}${compileFailCount} 编译失败${ANSI.reset}` : `${compileFailCount} 编译失败`} | ` +
      `测试：${ANSI.green}${testPassCount} 通过${ANSI.reset}，` +
      `${testFailCount > 0 ? `${ANSI.red}${testFailCount} 失败${ANSI.reset}` : `${testFailCount} 失败`}，` +
      `${ANSI.yellow}${noTestCount} 无测试${ANSI.reset}`,
  );

  // 输出失败详情
  if (failures.length > 0) {
    console.log(`\n${ANSI.red}失败详情：${ANSI.reset}`);
    for (const f of failures) {
      console.log("─".repeat(50));
      const typeLabel = f.type === "compile" ? "[编译失败]" : "[测试失败]";
      console.log(`${ANSI.red}${typeLabel} ${f.name}:${ANSI.reset}`);
      if (f.type === "compile") {
        console.log(`  错误信息:`);
        console.log(`    ${ANSI.red}${f.message}${ANSI.reset}`);
      } else {
        if (f.message) {
          console.log(`  执行异常:`);
          console.log(`    ${ANSI.red}${f.message}${ANSI.reset}`);
        }
        if (f.testFailures && f.testFailures.length > 0) {
          console.log(`  测试详情:`);
          for (const tf of f.testFailures) {
            console.log(`    input:    ${JSON.stringify(tf.input)}`);
            console.log(`    expected: ${JSON.stringify(tf.expected)}`);
            console.log(`    actual:   ${JSON.stringify(tf.actual)}`);
          }
        }
      }
    }
    console.log("─".repeat(50));
  }
}

export async function runSenseTestsAndCollect(
  infos: CompiledSenseInfo[],
): Promise<Map<string, TestInfo>> {
  const results = new Map<string, TestInfo>();

  for (const info of infos) {
    if (info.testCases.length === 0) {
      results.set(info.sourcePath, {
        detail: { passed: true, passedCount: 0, totalCount: 0, failures: [] },
      });
      continue;
    }

    try {
      const module = await import(pathToFileURL(info.compiledPath).href);
      const detail = await runSenseTests(module.default, info.testCases);
      results.set(info.sourcePath, { detail });
    } catch (err) {
      results.set(info.sourcePath, {
        detail: {
          passed: false,
          passedCount: 0,
          totalCount: info.testCases.length,
          failures: [],
          error: (err as Error).message,
        },
      });
    }
  }

  return results;
}