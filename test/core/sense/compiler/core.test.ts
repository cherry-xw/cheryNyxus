import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { compileSenses, parseTestCases } from "@/core/sense/compiler/index.js";
import { loadCompiledSense, runSenseTests } from "@/agent/sense/index.js";
import { sense } from "@/core/sense/index.js";
import { SupervisionLevel } from "@/core/config.js";
import { hashGenerator } from "@/utils/hash.js";
import { z } from "zod";
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

// 隔离输入目录，避免污染项目实际 .chery/senses
const testDir = join(process.cwd(), ".chery", "_compiler_test_senses");
// 编译器硬编码输出路径（compileSenses 内部）
const distDir = join(process.cwd(), "dist", "senses");
const tempDir = join(process.cwd(), "dist", ".sense-temp");

// mock config：仅 senses_dir 由 beforeAll 注入，避免 hoisting TDZ
// 同时提供 prompts_dir / roles / llm.brain 防止 agent/sense → spawn → builder → prompt/index 链崩溃
vi.mock("@/utils/config", () => ({
  default: {
    global: { senses_dir: "", prompts_dir: "/tmp/test-prompts" },
    roles: {},
    llm: { brain: {} },
  },
}));

describe("toolCompiler", () => {
  const createdBasenames: string[] = [];
  let config: any;

  function writeSense(fileName: string, content: string): string {
    const srcPath = join(testDir, `${fileName}.ts`);
    writeFileSync(srcPath, content, "utf-8");
    createdBasenames.push(fileName);
    return srcPath;
  }

  beforeAll(async () => {
    config = (await import("@/utils/config")).default;
    config.global.senses_dir = testDir;
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    for (const name of createdBasenames) {
      const src = join(testDir, `${name}.ts`);
      if (existsSync(src)) rmSync(src, { force: true });
      const dist = join(distDir, `${name}.js`);
      if (existsSync(dist)) rmSync(dist, { force: true });
    }
    createdBasenames.length = 0;
  });

  afterAll(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  it("compiles sense file to JS in dist/senses", async () => {
    writeSense("compile_test", `
const Schema = z.object({ text: z.string() });
export default sense(
  "compile_test",
  "编译测试",
  Schema,
  async (input) => ({ content: input.text, hash: "" }),
  SupervisionLevel.confirm,
);
`);

    const succeeded = (await compileSenses()).succeeded;
    const info = succeeded.find((r) => r.compiledPath.endsWith("compile_test.js"));
    expect(info).toBeDefined();

    const jsPath = join(distDir, "compile_test.js");
    expect(existsSync(jsPath)).toBe(true);
    const jsContent = readFileSync(jsPath, "utf-8");
    expect(jsContent).not.toContain("export default sense(");
    expect(jsContent).toContain("return sense(");

    const compiledSense = loadCompiledSense(jsPath);
    expect(compiledSense.definition.function.name).toBe("compile_test");
    const testResult = await runSenseTests(compiledSense, [
      { input: { text: "works" }, output: { content: "works", hash: "" } },
    ]);
    expect(testResult.passed).toBe(true);
  });

  it("returns empty succeeded when senses_dir does not exist", async () => {
    const orig = config.global.senses_dir;
    config.global.senses_dir = "/nonexistent/path/senses";

    const result = (await compileSenses()).succeeded;
    expect(result).toEqual([]);

    config.global.senses_dir = orig;
  });

  it("returns empty succeeded when no .ts files found", async () => {
    const emptyDir = join(process.cwd(), ".chery", "_compiler_empty");
    if (!existsSync(emptyDir)) mkdirSync(emptyDir, { recursive: true });
    const orig = config.global.senses_dir;
    config.global.senses_dir = emptyDir;

    const result = (await compileSenses()).succeeded;
    expect(result).toEqual([]);

    config.global.senses_dir = orig;
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("collects syntax failures and continues compiling other senses", async () => {
    writeSense("bad_syntax_collect", `const x = ;`);
    writeSense("good_after_bad", `
const Schema = z.object({ text: z.string() });
export default sense("good_after_bad", "good", Schema, async (input) => ({ content: input.text, hash: "" }));
`);

    const summary = await compileSenses();

    expect(
      summary.failed.some(
        (f) => f.fileName === "bad_syntax_collect.ts" && f.type === "syntax",
      ),
    ).toBe(true);
    expect(
      summary.succeeded.some((info) =>
        info.compiledPath.endsWith("good_after_bad.js"),
      ),
    ).toBe(true);
  });

  it("syntax failure message includes 感官编译失败", async () => {
    writeSense("bad_syntax", `const x = ;`);

    const summary = await compileSenses();
    expect(
      summary.failed.some(
        (f) => f.fileName === "bad_syntax.ts" && f.message.includes("感官编译失败"),
      ),
    ).toBe(true);
  });

  it("strips source-path imports in compiled output", async () => {
    writeSense("source_import", `
import { z } from "zod";
import { sense } from "@/core/sense";
import { SupervisionLevel } from "@/core/config";

const Schema = z.object({ text: z.string() });
export default sense(
  "source_import",
  "Source import test",
  Schema,
  async (input) => ({ content: input.text, hash: "" }),
  SupervisionLevel.auto,
);
`);

    (await compileSenses()).succeeded;

    const jsPath = join(distDir, "source_import.js");
    expect(existsSync(jsPath)).toBe(true);
    const jsContent = readFileSync(jsPath, "utf-8");
    expect(jsContent).not.toContain('import { z }');
    expect(jsContent).not.toContain('import { sense }');
    expect(jsContent).not.toContain("export default sense(");
    expect(jsContent).toContain("return sense(");
  });

  describe("parseTestCases", () => {
    it("parses @test annotation from source", () => {
      const source = `
/* @test [
  { "input": { "text": "hello" }, "output": { "content": "Echo: hello", "hash": "" } }
] */
const Schema = z.object({ text: z.string() });
export default sense("test", "test", Schema, async (input) => ({ content: input.text, hash: "" }));
`;
      const cases = parseTestCases(source);
      expect(cases).toHaveLength(1);
      expect(cases[0]!.input).toEqual({ text: "hello" });
      expect(cases[0]!.output).toEqual({ content: "Echo: hello", hash: "" });
    });

    it("returns empty array when no @test annotation", () => {
      expect(parseTestCases("const x = 1;")).toEqual([]);
    });

    it("returns empty array for malformed @test JSON", () => {
      expect(parseTestCases("/* @test { invalid json } */")).toEqual([]);
    });

    it("parses multiple test cases", () => {
      const source = `/* @test [
  { "input": { "a": "1" }, "output": { "content": "r1", "hash": "h1" } },
  { "input": { "a": "2" }, "output": { "content": "r2", "hash": "h2" } }
] */`;
      expect(parseTestCases(source)).toHaveLength(2);
    });

    it("filters out invalid test case entries", () => {
      const source = `/* @test [
  { "input": { "a": "1" }, "output": { "content": "r1", "hash": "h1" } },
  { "input": { "a": "2" } },
  "not an object",
  null
] */`;
      expect(parseTestCases(source)).toHaveLength(1);
    });
  });

  describe("runSenseTests", () => {
    it("passes when output matches test cases", async () => {
      const s = sense(
        "runtime_pass",
        "runtime pass",
        z.object({ text: z.string() }),
        async (input) => ({ content: input.text, hash: "" }),
      );

      const result = await runSenseTests(s, [
        { input: { text: "ok" }, output: { content: "ok", hash: "" } },
      ]);
      expect(result.passed).toBe(true);
      expect(result.passedCount).toBe(1);
      expect(result.totalCount).toBe(1);
    });

    it("fails when output mismatches", async () => {
      const s = sense(
        "runtime_mismatch",
        "runtime mismatch",
        z.object({ text: z.string() }),
        async (input) => ({ content: input.text, hash: "" }),
      );

      const result = await runSenseTests(s, [
        { input: { text: "ok" }, output: { content: "wrong", hash: "" } },
      ]);
      expect(result.passed).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);
    });

    it("fails with error when execution throws", async () => {
      const s = sense(
        "runtime_throw",
        "runtime throw",
        z.object({ text: z.string() }),
        async () => {
          throw new Error("boom");
        },
      );

      const result = await runSenseTests(s, [
        { input: { text: "ok" }, output: { content: "ok", hash: "" } },
      ]);
      expect(result.passed).toBe(false);
      expect(result.error).toBe("boom");
    });
  });

  describe("hash incremental compilation", () => {
    it("invalidates artifacts created by the legacy ESM format", async () => {
      const source = `
const Schema = z.object({ text: z.string() });
export default sense("format_upgrade", "format", Schema, async (input) => ({ content: input.text, hash: "" }));
`;
      writeSense("format_upgrade", source);
      mkdirSync(distDir, { recursive: true });
      const legacyHash = hashGenerator("sense", source, "format_upgrade.ts");
      writeFileSync(
        join(distDir, "format_upgrade.js"),
        `// hash:${legacyHash}\nexport default sense("legacy");`,
        "utf-8",
      );

      const info = (await compileSenses()).succeeded.find((item) =>
        item.compiledPath.endsWith("format_upgrade.js"),
      );
      const compiled = readFileSync(info!.compiledPath, "utf-8");

      expect(compiled).toContain('return sense("format_upgrade"');
      expect(compiled).not.toContain(`// hash:${legacyHash}\n`);
    });

    it("embeds hash as first line of compiled JS", async () => {
      writeSense("hash_embed", `
const Schema = z.object({ text: z.string() });
export default sense("hash_embed", "hash test", Schema, async (input) => ({ content: input.text, hash: "" }));
`);

      const infos = (await compileSenses()).succeeded;
      const info = infos.find((r) => r.compiledPath.endsWith("hash_embed.js"));
      expect(info).toBeDefined();

      const jsContent = readFileSync(info!.compiledPath, "utf-8");
      expect(jsContent).toMatch(/^\/\/ hash:[a-f0-9]+/);
    });

    it("skips compilation when source hash matches", async () => {
      writeSense("hash_skip", `
const Schema = z.object({ text: z.string() });
export default sense("hash_skip", "hash skip", Schema, async (input) => ({ content: input.text, hash: "" }));
`);

      const first = (await compileSenses()).succeeded;
      const firstInfo = first.find((r) => r.compiledPath.endsWith("hash_skip.js"));
      expect(firstInfo).toBeDefined();

      const jsPath = firstInfo!.compiledPath;
      const firstContent = readFileSync(jsPath, "utf-8");
      const firstMtime = readFileSync(jsPath).byteLength;

      const second = (await compileSenses()).succeeded;
      const secondInfo = second.find((r) => r.compiledPath.endsWith("hash_skip.js"));
      expect(secondInfo).toBeDefined();
      expect(secondInfo!.compiledPath).toBe(jsPath);

      const secondContent = readFileSync(jsPath, "utf-8");
      expect(secondContent).toBe(firstContent);
      expect(readFileSync(jsPath).byteLength).toBe(firstMtime);
    });

    it("recompiles when source changes", async () => {
      writeSense("hash_change", `
const Schema = z.object({ text: z.string() });
export default sense("hash_change", "v1", Schema, async (input) => ({ content: input.text, hash: "" }));
`);

      const first = (await compileSenses()).succeeded;
      const firstInfo = first.find((r) =>
        r.compiledPath.endsWith("hash_change.js"),
      );
      const firstHash = readFileSync(firstInfo!.compiledPath, "utf-8").split("\n")[0];

      // Modify source (description v1 → v2)
      writeSense("hash_change", `
const Schema = z.object({ text: z.string() });
export default sense("hash_change", "v2", Schema, async (input) => ({ content: input.text, hash: "" }));
`);

      const second = (await compileSenses()).succeeded;
      const secondInfo = second.find((r) =>
        r.compiledPath.endsWith("hash_change.js"),
      );
      const secondHash = readFileSync(secondInfo!.compiledPath, "utf-8").split("\n")[0];

      expect(secondHash).not.toBe(firstHash);
    });
  });

  it("includes parsed test cases in compilation result", async () => {
    writeSense("with_tests", `
/* @test [
  { "input": { "msg": "hi" }, "output": { "content": "hi", "hash": "" } },
  { "input": { "msg": "bye" }, "output": { "content": "bye", "hash": "" } }
] */
const Schema = z.object({ msg: z.string() });
export default sense("with_tests", "test cases sense", Schema, async (input) => ({ content: input.msg, hash: "" }));
`);

    const results = (await compileSenses()).succeeded;
    const info = results.find((r) => r.compiledPath.endsWith("with_tests.js"));
    expect(info).toBeDefined();
    expect(info!.testCases).toHaveLength(2);
    expect(info!.testCases[0]!.input).toEqual({ msg: "hi" });
    expect(info!.testCases[1]!.output).toEqual({ content: "bye", hash: "" });
  });
});
