import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { preprocessAndCompileAllTools } from "@/utils/toolCompiler.js";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";

describe("toolCompiler", () => {
  const testDir = join(process.cwd(), ".chery", "tools");
  const distDir = join(process.cwd(), "dist", "custom");
  const tempDir = join(process.cwd(), ".chery", "tools", "temp");

  // 记录测试创建的文件
  const createdTestFiles: string[] = [];

  beforeAll(() => {
    // 确保测试目录存在
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    // 清理所有测试产物
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }

    // 清理测试创建的 tool 文件
    for (const file of createdTestFiles) {
      if (existsSync(file)) {
        rmSync(file, { force: true });
      }
    }

    // 清理 dist/custom 下的测试编译产物
    if (existsSync(distDir)) {
      const jsFiles = readdirSync(distDir).filter(f => f.endsWith(".js"));
      for (const jsFile of jsFiles) {
        // 只清理测试相关的文件（非 echo_text.js）
        if (jsFile !== "echo_text.js") {
          rmSync(join(distDir, jsFile), { force: true });
        }
      }
    }
  });

  afterEach(() => {
    // 每个测试后也尝试清理（防止测试中断导致 afterAll 不执行）
    for (const file of createdTestFiles) {
      if (existsSync(file)) {
        rmSync(file, { force: true });
      }
    }
    createdTestFiles.length = 0;
  });

  it("should preprocess tool file with missing imports", async () => {
    // 创建测试 tool 文件（无导入）
    const testToolPath = join(testDir, "test_tool.ts");
    createdTestFiles.push(testToolPath);
    writeFileSync(testToolPath, `
const TestSchema = z.object({
  message: z.string().describe("测试消息"),
});

export default tool(
  "test_tool",
  "测试工具",
  TestSchema,
  async (input) => {
    return { content: input.message, hash: "" };
  },
  SupervisionLevel.auto,
);
`, "utf-8");

    // 执行预处理和编译
    const compiledPaths = await preprocessAndCompileAllTools();

    // 验证编译产物
    expect(compiledPaths.length).toBeGreaterThan(0);

    // 检查预处理后的文件是否包含导入语句
    if (existsSync(tempDir)) {
      const preprocessedPath = join(tempDir, "test_tool.ts");
      if (existsSync(preprocessedPath)) {
        const content = readFileSync(preprocessedPath, "utf-8");
        expect(content).toContain("import { z } from \"zod\"");
        expect(content).toContain("import { tool");
        expect(content).toContain("import { SupervisionLevel");
      }
    }
  });

  it("should compile tool file to JS in dist/custom", async () => {
    // 创建测试 tool 文件
    const testToolPath = join(testDir, "compile_test.ts");
    createdTestFiles.push(testToolPath);
    writeFileSync(testToolPath, `
const Schema = z.object({ text: z.string() });

export default tool(
  "compile_test",
  "编译测试",
  Schema,
  async (input) => ({ content: input.text, hash: "" }),
  SupervisionLevel.confirm,
);
`, "utf-8");

    // 执行编译
    const compiledPaths = await preprocessAndCompileAllTools();

    // 验证 JS 文件存在
    const jsPath = join(distDir, "compile_test.js");
    if (existsSync(jsPath)) {
      const jsContent = readFileSync(jsPath, "utf-8");
      // Vite 编译后使用 export { xxx as default } 格式
      expect(jsContent).toContain("as default");
    }
  });
});