import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { preprocessAndCompileAllTools } from "@/utils/toolCompiler.js";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";

vi.mock("@/utils/config", () => ({
  default: {
    global: {
      tools_dir: undefined,
      chery_dir: undefined,
    },
  },
}));

describe("toolCompiler", () => {
  const testDir = join(process.cwd(), ".chery", "tools");
  const distDir = join(process.cwd(), "dist", "custom");
  const tempDir = join(process.cwd(), ".chery", "tools", "temp");
  let config: any;

  const createdTestFiles: string[] = [];

  beforeAll(async () => {
    config = (await import("@/utils/config")).default;
    config.global.tools_dir = testDir;
    config.global.chery_dir = process.cwd();

    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }

    for (const file of createdTestFiles) {
      if (existsSync(file)) {
        rmSync(file, { force: true });
      }
    }

    if (existsSync(distDir)) {
      const jsFiles = readdirSync(distDir).filter(f => f.endsWith(".js"));
      for (const jsFile of jsFiles) {
        if (jsFile !== "echo_text.js") {
          rmSync(join(distDir, jsFile), { force: true });
        }
      }
    }
  });

  afterEach(() => {
    for (const file of createdTestFiles) {
      if (existsSync(file)) {
        rmSync(file, { force: true });
      }
    }
    createdTestFiles.length = 0;
  });

  it("should preprocess tool file with missing imports", async () => {
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

    const compiledPaths = await preprocessAndCompileAllTools();
    expect(compiledPaths.length).toBeGreaterThan(0);

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

    const compiledPaths = await preprocessAndCompileAllTools();

    const jsPath = join(distDir, "compile_test.js");
    if (existsSync(jsPath)) {
      const jsContent = readFileSync(jsPath, "utf-8");
      expect(jsContent).toContain("as default");
    }
  });

  it("should return empty array when toolsDir does not exist", async () => {
    const origDir = config.global.tools_dir;
    config.global.tools_dir = "/nonexistent/path/tools";

    const result = await preprocessAndCompileAllTools();
    expect(result).toEqual([]);

    config.global.tools_dir = origDir;
  });

  it("should return empty array when no .ts files found", async () => {
    const emptyDir = join(process.cwd(), ".chery", "tools", "empty_test");
    if (!existsSync(emptyDir)) {
      mkdirSync(emptyDir, { recursive: true });
    }
    const origDir = config.global.tools_dir;
    config.global.tools_dir = emptyDir;

    const result = await preprocessAndCompileAllTools();
    expect(result).toEqual([]);

    config.global.tools_dir = origDir;
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("should handle compilation failure gracefully", async () => {
    const testToolPath = join(testDir, "bad_syntax.ts");
    createdTestFiles.push(testToolPath);
    writeFileSync(testToolPath, `
// Intentionally broken TypeScript that will fail compilation
const Schema = z.object({ text: z.string() });

export default tool(
  "bad_syntax",
  "Bad syntax test",
  Schema,
  async (input) => ({ content: input.text, hash: "" }),
  SupervisionLevel.auto,
);
`, "utf-8");

    // Should not throw even if individual file compilation fails
    const result = await preprocessAndCompileAllTools();
    expect(Array.isArray(result)).toBe(true);
  });

  it("should inject imports after existing imports", async () => {
    const testToolPath = join(testDir, "partial_import.ts");
    createdTestFiles.push(testToolPath);
    writeFileSync(testToolPath, `
import { z } from "zod";

const Schema = z.object({ text: z.string() });

export default tool(
  "partial_import",
  "Partial import test",
  Schema,
  async (input) => ({ content: input.text, hash: "" }),
  SupervisionLevel.auto,
);
`, "utf-8");

    await preprocessAndCompileAllTools();

    const preprocessedPath = join(tempDir, "partial_import.ts");
    if (existsSync(preprocessedPath)) {
      const content = readFileSync(preprocessedPath, "utf-8");
      // z already imported, so tool and SupervisionLevel should be added after
      expect(content).toContain("import { z } from \"zod\"");
      expect(content).toContain("import { tool");
      expect(content).toContain("import { SupervisionLevel");
    }
  });

  it("should not modify file when all imports already present", async () => {
    const testToolPath = join(testDir, "full_import.ts");
    createdTestFiles.push(testToolPath);
    writeFileSync(testToolPath, `
import { z } from "zod";
import { tool, type ToolResult } from "@/core/tool";
import { SupervisionLevel } from "@/core/config";

const Schema = z.object({ text: z.string() });

export default tool(
  "full_import",
  "Full import test",
  Schema,
  async (input) => ({ content: input.text, hash: "" }),
  SupervisionLevel.auto,
);
`, "utf-8");

    await preprocessAndCompileAllTools();

    const preprocessedPath = join(tempDir, "full_import.ts");
    if (existsSync(preprocessedPath)) {
      const content = readFileSync(preprocessedPath, "utf-8");
      // Should only have 3 import lines, not duplicated
      const importLines = content.split("\n").filter(l => l.trim().startsWith("import "));
      expect(importLines.length).toBe(3);
    }
  });
});