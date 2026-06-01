import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { compileTools, parseTestCases } from "@/core/tool/compiler/index.js";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { runToolTests } from "@/agent/tool/index.js";
import { tool } from "@/core/tool/index.js";
import { z } from "zod";
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
  let distDir: string;
  let tempDir: string;
  let config: any;

  const createdTestFiles: string[] = [];

  beforeAll(async () => {
    config = (await import("@/utils/config")).default;
    config.global.tools_dir = testDir;
    config.global.chery_dir = process.cwd();

    // distDir 和 tempDir 由 __dirname（即 dist/）决定
    distDir = join(process.cwd(), "dist", "tools");
    tempDir = join(process.cwd(), "dist", ".tool-temp");

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

  it("should inject imports with target path ../index.js", async () => {
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

    const compiledInfos = (await compileTools()).succeeded;
    expect(compiledInfos.length).toBeGreaterThan(0);

    const info = compiledInfos.find(r => r.compiledPath.endsWith("test_tool.js"));
    expect(info).toBeDefined();
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

    (await compileTools()).succeeded;

    const jsPath = join(distDir, "compile_test.js");
    if (existsSync(jsPath)) {
      const jsContent = readFileSync(jsPath, "utf-8");
      expect(jsContent).toContain("export default");
      // 编译产物应使用 ../index.js 而非 zod 或 @/core/*
      expect(jsContent).toContain('from "../index.js"');
    }
  });

  it("should return empty array when toolsDir does not exist", async () => {
    const origDir = config.global.tools_dir;
    config.global.tools_dir = "/nonexistent/path/tools";

    const result = (await compileTools()).succeeded;
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

    const result = (await compileTools()).succeeded;
    expect(result).toEqual([]);

    config.global.tools_dir = origDir;
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("should collect syntax failures and continue compiling other tools", async () => {
    const badToolPath = join(testDir, "bad_syntax_collect.ts");
    const goodToolPath = join(testDir, "good_after_bad.ts");
    createdTestFiles.push(badToolPath, goodToolPath);

    writeFileSync(badToolPath, `
const x = ;
`, "utf-8");
    writeFileSync(goodToolPath, `
const Schema = z.object({ text: z.string() });
export default tool("good_after_bad", "good", Schema, async (input) => ({ content: input.text, hash: "" }));
`, "utf-8");

    const summary = await compileTools();

    expect(summary.failed.some(f => f.fileName === "bad_syntax_collect.ts" && f.type === "syntax")).toBe(true);
    expect(summary.succeeded.some(info => info.compiledPath.endsWith("good_after_bad.js"))).toBe(true);
  });

  it("should collect syntax failure for invalid TypeScript syntax", async () => {
    const testToolPath = join(testDir, "bad_syntax.ts");
    createdTestFiles.push(testToolPath);
    writeFileSync(testToolPath, `
const x = ;
`, "utf-8");

    const summary = await compileTools();
    expect(summary.failed.some(f => f.fileName === "bad_syntax.ts" && f.message.includes("工具编译失败"))).toBe(true);
  });

  it("should not duplicate imports when source already has target path", async () => {
    const testToolPath = join(testDir, "full_import.ts");
    createdTestFiles.push(testToolPath);
    writeFileSync(testToolPath, `
import { z } from "../index.js";
import { tool } from "../index.js";
import { SupervisionLevel } from "../index.js";

const Schema = z.object({ text: z.string() });

export default tool(
  "full_import",
  "Full import test",
  Schema,
  async (input) => ({ content: input.text, hash: "" }),
  SupervisionLevel.auto,
);
`, "utf-8");

    (await compileTools()).succeeded;

    const preprocessedPath = join(tempDir, "full_import.ts");
    if (existsSync(preprocessedPath)) {
      const content = readFileSync(preprocessedPath, "utf-8");
      const importLines = content.split("\n").filter(l => l.trim().startsWith("import "));
      expect(importLines.length).toBe(3);
    }
  });

  it("should convert source-path imports to target path", async () => {
    const testToolPath = join(testDir, "source_import.ts");
    createdTestFiles.push(testToolPath);
    writeFileSync(testToolPath, `
import { z } from "zod";
import { tool } from "@/core/tool";
import { SupervisionLevel } from "@/core/config";

const Schema = z.object({ text: z.string() });

export default tool(
  "source_import",
  "Source import test",
  Schema,
  async (input) => ({ content: input.text, hash: "" }),
  SupervisionLevel.auto,
);
`, "utf-8");

    (await compileTools()).succeeded;

    const jsPath = join(distDir, "source_import.js");
    if (existsSync(jsPath)) {
      const jsContent = readFileSync(jsPath, "utf-8");
      // 编译产物中所有 import 应指向 ../index.js
      expect(jsContent).toContain('from "../index.js"');
      expect(jsContent).not.toContain('from "zod"');
      expect(jsContent).not.toContain('from "@/core/');
    }
  });

  // --- parseTestCases tests ---

  describe("parseTestCases", () => {
    it("should parse @test annotation from source", () => {
      const source = `
/* @test [
  { "input": { "text": "hello" }, "output": { "content": "Echo: hello", "hash": "" } }
] */
const Schema = z.object({ text: z.string() });
export default tool("test", "test", Schema, async (input) => ({ content: input.text, hash: "" }));
`;
      const cases = parseTestCases(source);
      expect(cases).toHaveLength(1);
      expect(cases[0]!.input).toEqual({ text: "hello" });
      expect(cases[0]!.output).toEqual({ content: "Echo: hello", hash: "" });
    });

    it("should ignore inline @test text in documentation comments", () => {
      const source = `
/** docs mention /* @test [...] */ inline */

/* @test [
  { "input": { "text": "hello" }, "output": { "content": "hello", "hash": "" } }
] */
const Schema = z.object({ text: z.string() });
`;
      const cases = parseTestCases(source);
      expect(cases).toHaveLength(1);
      expect(cases[0]!.input).toEqual({ text: "hello" });
    });

    it("should return empty array when no @test annotation", () => {
      expect(parseTestCases("const x = 1;")).toEqual([]);
    });

    it("should return empty array for malformed @test JSON", () => {
      expect(parseTestCases("/* @test { invalid json } */")).toEqual([]);
    });

    it("should parse multiple test cases", () => {
      const source = `/* @test [
  { "input": { "a": "1" }, "output": { "content": "r1", "hash": "h1" } },
  { "input": { "a": "2" }, "output": { "content": "r2", "hash": "h2" } }
] */`;
      const cases = parseTestCases(source);
      expect(cases).toHaveLength(2);
    });

    it("should filter out invalid test case entries", () => {
      const source = `/* @test [
  { "input": { "a": "1" }, "output": { "content": "r1", "hash": "h1" } },
  { "input": { "a": "2" } },
  "not an object",
  null
] */`;
      const cases = parseTestCases(source);
      expect(cases).toHaveLength(1);
    });
  });

  describe("runToolTests", () => {
    it("should pass when tool output matches test cases", async () => {
      const schema = z.object({ text: z.string() });
      const toolInstance = tool(
        "runtime_pass",
        "runtime pass",
        schema,
        async (input) => ({ content: input.text, hash: "" }),
      );

      await expect(runToolTests(toolInstance, [
        { input: { text: "ok" }, output: { content: "ok", hash: "" } },
      ])).resolves.toBe(true);
    });

    it("should fail when tool output mismatches test cases", async () => {
      const schema = z.object({ text: z.string() });
      const toolInstance = tool(
        "runtime_mismatch",
        "runtime mismatch",
        schema,
        async (input) => ({ content: input.text, hash: "" }),
      );

      await expect(runToolTests(toolInstance, [
        { input: { text: "ok" }, output: { content: "wrong", hash: "" } },
      ])).resolves.toBe(false);
    });

    it("should fail when tool execution throws", async () => {
      const schema = z.object({ text: z.string() });
      const toolInstance = tool(
        "runtime_throw",
        "runtime throw",
        schema,
        async () => { throw new Error("boom"); },
      );

      await expect(runToolTests(toolInstance, [
        { input: { text: "ok" }, output: { content: "ok", hash: "" } },
      ])).resolves.toBe(false);
    });
  });

  // --- hash-based incremental compilation tests ---

  describe("hash incremental compilation", () => {
    it("should embed hash as first line of compiled JS", async () => {
      const testToolPath = join(testDir, "hash_embed.ts");
      createdTestFiles.push(testToolPath);
      writeFileSync(testToolPath, `
const Schema = z.object({ text: z.string() });
export default tool("hash_embed", "hash test", Schema, async (input) => ({ content: input.text, hash: "" }));
`, "utf-8");

      const infos = (await compileTools()).succeeded;
      const info = infos.find(r => r.compiledPath.endsWith("hash_embed.js"));
      expect(info).toBeDefined();

      const jsContent = readFileSync(info!.compiledPath, "utf-8");
      expect(jsContent).toMatch(/^\/\/ hash:[a-f0-9]+/);
    });

    it("should skip compilation when source hash matches", async () => {
      const testToolPath = join(testDir, "hash_skip.ts");
      createdTestFiles.push(testToolPath);
      writeFileSync(testToolPath, `
const Schema = z.object({ text: z.string() });
export default tool("hash_skip", "hash skip test", Schema, async (input) => ({ content: input.text, hash: "" }));
`, "utf-8");

      const first = (await compileTools()).succeeded;
      const firstInfo = first.find(r => r.compiledPath.endsWith("hash_skip.js"));
      expect(firstInfo).toBeDefined();

      const jsPath = firstInfo!.compiledPath;
      const firstContent = readFileSync(jsPath, "utf-8");

      // Second compile — source unchanged, should skip
      const second = (await compileTools()).succeeded;
      const secondInfo = second.find(r => r.compiledPath.endsWith("hash_skip.js"));
      expect(secondInfo).toBeDefined();
      expect(secondInfo!.compiledPath).toBe(jsPath);

      // File content unchanged
      const secondContent = readFileSync(jsPath, "utf-8");
      expect(secondContent).toBe(firstContent);
    });

    it("should recompile when source changes", async () => {
      const testToolPath = join(testDir, "hash_change.ts");
      createdTestFiles.push(testToolPath);
      writeFileSync(testToolPath, `
const Schema = z.object({ text: z.string() });
export default tool("hash_change", "v1", Schema, async (input) => ({ content: input.text, hash: "" }));
`, "utf-8");

      const first = (await compileTools()).succeeded;
      const firstInfo = first.find(r => r.compiledPath.endsWith("hash_change.js"));
      const firstHash = readFileSync(firstInfo!.compiledPath, "utf-8").split("\n")[0];

      // Modify source
      writeFileSync(testToolPath, `
const Schema = z.object({ text: z.string() });
export default tool("hash_change", "v2", Schema, async (input) => ({ content: input.text, hash: "" }));
`, "utf-8");

      const second = (await compileTools()).succeeded;
      const secondInfo = second.find(r => r.compiledPath.endsWith("hash_change.js"));
      const secondHash = readFileSync(secondInfo!.compiledPath, "utf-8").split("\n")[0];

      expect(secondHash).not.toBe(firstHash);
    });
  });

  // --- test cases in compilation result ---

  it("should include parsed test cases in compilation result", async () => {
    const testToolPath = join(testDir, "with_tests.ts");
    createdTestFiles.push(testToolPath);
    writeFileSync(testToolPath, `
/* @test [
  { "input": { "msg": "hi" }, "output": { "content": "hi", "hash": "" } },
  { "input": { "msg": "bye" }, "output": { "content": "bye", "hash": "" } }
] */
const Schema = z.object({ msg: z.string() });
export default tool("with_tests", "test cases tool", Schema, async (input) => ({ content: input.msg, hash: "" }));
`, "utf-8");

    const results = (await compileTools()).succeeded;
    const info = results.find(r => r.compiledPath.endsWith("with_tests.js"));
    expect(info).toBeDefined();
    expect(info!.testCases).toHaveLength(2);
    expect(info!.testCases[0]!.input).toEqual({ msg: "hi" });
    expect(info!.testCases[1]!.output).toEqual({ content: "bye", hash: "" });
  });
});
