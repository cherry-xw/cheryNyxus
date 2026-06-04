import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join, basename, extname, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import config from "@/utils/config.js";
import { hashGenerator } from "@/utils/hash.js";
import type { TestCase, ToolCompileOptions, ToolCompileSummary } from "./types.js";

function loadSwcWasm(): { transformSync: (code: string, opts: unknown) => { code: string } } {
  const require = createRequire(import.meta.url);
  const here = dirname(fileURLToPath(import.meta.url));
  const vendored = join(here, "lib", "@swc", "wasm", "wasm.js");

  if (existsSync(vendored)) {
    return require(vendored);
  }
  return require("@swc/wasm");
}

const { transformSync } = loadSwcWasm();

// 不再注入外部依赖，编译产物为纯代码
// 运行时通过 new Function() 在当前上下文执行，z/tool/SupervisionLevel 由上下文提供

function stripImports(content: string): string {
  // 移除所有 import 语句，只保留代码
  const lines = content.split("\n");
  const codeLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // 保留非 import 行
    if (!trimmed.startsWith("import ")) {
      codeLines.push(line);
    }
  }

  return codeLines.join("\n");
}

function preprocessToolFile(sourcePath: string, outputDir: string): string {
  const sourceContent = readFileSync(sourcePath, "utf-8");
  const strippedContent = stripImports(sourceContent);

  const fileName = basename(sourcePath, extname(sourcePath));
  const outputPath = join(outputDir, `${fileName}.ts`);

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  writeFileSync(outputPath, strippedContent, "utf-8");
  return outputPath;
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}

async function compileToolFile(tsPath: string, outputDir: string, sourceHash: string): Promise<string> {
  const fileName = basename(tsPath, extname(tsPath));
  const outputPath = join(outputDir, `${fileName}.js`);

  try {
    const sourceContent = readFileSync(tsPath, "utf-8");

    const result = transformSync(sourceContent, {
      jsc: {
        parser: { syntax: "typescript" },
        target: "es2022",
      },
      module: { type: "es6" },
    });

    const outputContent = `// hash:${sourceHash}\n${result.code}`;
    writeFileSync(outputPath, outputContent, "utf-8");
    return outputPath;
  } catch (err) {
    throw new Error(`工具编译失败 ${fileName}: ${formatErrorMessage(err)}`);
  }
}

function computeSourceHash(sourceContent: string, fileName: string): string {
  return hashGenerator("tool", sourceContent, fileName);
}

function readEmbeddedHash(jsPath: string): string | null {
  if (!existsSync(jsPath)) return null;
  const firstLine = readFileSync(jsPath, "utf-8").split("\n")[0];
  if (!firstLine) return null;
  const match = firstLine.match(/^\/\/ hash:([a-f0-9]+)$/);
  return match ? (match[1] ?? null) : null;
}

export function parseTestCases(sourceContent: string): TestCase[] {
  const matches = sourceContent.matchAll(/^\/\*\s*@test\s+([\s\S]*?)\s*\*\//gm);
  for (const match of matches) {
    if (!match[1]) continue;
    try {
      const parsed = JSON.parse(match[1]);
      if (!Array.isArray(parsed)) continue;
      return parsed.filter(
        (tc): tc is TestCase =>
          tc && typeof tc === "object" && tc.input && tc.output
          && typeof tc.output.content === "string"
          && typeof tc.output.hash === "string",
      );
    } catch {
      continue;
    }
  }
  return [];
}

export async function compileTools(options: ToolCompileOptions = {}): Promise<ToolCompileSummary> {
  const toolsDir = config.global.tools_dir;

  const outputDir = join(process.cwd(), "dist", "tools");
  const tempDir = join(process.cwd(), "dist", ".tool-temp");

  if (!existsSync(toolsDir)) {
    return { succeeded: [], failed: [] };
  }

  const files = readdirSync(toolsDir);
  const tsFiles = files.filter(f => f.endsWith(".ts") && !f.startsWith("."));

  if (tsFiles.length === 0) {
    return { succeeded: [], failed: [] };
  }

  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const summary: ToolCompileSummary = { succeeded: [], failed: [] };

  try {
    for (const file of tsFiles) {
      const sourcePath = join(toolsDir, file);
      const sourceContent = readFileSync(sourcePath, "utf-8");
      const sourceHash = computeSourceHash(sourceContent, file);
      const fileName = basename(file, extname(file));
      const expectedJsPath = join(outputDir, `${fileName}.js`);
      const testCases = parseTestCases(sourceContent);

      if (readEmbeddedHash(expectedJsPath) === sourceHash) {
        summary.succeeded.push({ compiledPath: expectedJsPath, sourcePath, testCases });
        options.onEvent?.({ type: "skipped", fileName: file, sourcePath, compiledPath: expectedJsPath });
        continue;
      }

      try {
        const preprocessedPath = preprocessToolFile(sourcePath, tempDir);
        options.onEvent?.({ type: "preprocessed", fileName: file, sourcePath });

        const compiledPath = await compileToolFile(preprocessedPath, outputDir, sourceHash);
        summary.succeeded.push({ compiledPath, sourcePath, testCases });
        options.onEvent?.({ type: "compiled", fileName: file, sourcePath, compiledPath });
      } catch (err) {
        const failure = {
          sourcePath,
          fileName: file,
          type: "syntax" as const,
          message: (err as Error).message,
        };
        summary.failed.push(failure);
        options.onEvent?.({ type: "failed", failure });
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return summary;
}
