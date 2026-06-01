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

const IMPORT_MAP: Record<string, string> = {
  zod: "import { z } from \"../index.js\";",
  "@/core/tool": "import { tool } from \"../index.js\";",
  "@/core/config": "import { SupervisionLevel } from \"../index.js\";",
};

function hasImportFrom(content: string, source: string): boolean {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("import ") && !trimmed.startsWith("//") && !trimmed.startsWith("*")) {
      if (trimmed.includes(`from \"${source}\"`) || trimmed.includes(`from '${source}'`)) {
        return true;
      }
    }
  }
  return false;
}

function injectImports(content: string): string {
  const lines = content.split("\n");
  let lastImportIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line && line.trim().startsWith("import ") && !line.trim().startsWith("import type")) {
      lastImportIndex = i;
    }
  }

  const missingImports = Object.entries(IMPORT_MAP)
    .filter(([source]) => !hasImportFrom(content, source))
    .map(([, stmt]) => stmt);

  if (missingImports.length === 0) return content;
  if (lastImportIndex === -1) return [...missingImports, "", ...lines].join("\n");

  const injectPosition = lastImportIndex + 1;
  return [
    ...lines.slice(0, injectPosition),
    ...missingImports,
    ...lines.slice(injectPosition),
  ].join("\n");
}

function preprocessToolFile(sourcePath: string, outputDir: string): string {
  const sourceContent = readFileSync(sourcePath, "utf-8");
  const injectedContent = injectImports(sourceContent);

  const fileName = basename(sourcePath, extname(sourcePath));
  const outputPath = join(outputDir, `${fileName}.ts`);

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  writeFileSync(outputPath, injectedContent, "utf-8");
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
