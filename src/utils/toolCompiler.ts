import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join, basename, extname, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import config from "./config.js";
import { hashGenerator } from "./hash.js";

/**
 * 动态加载 @swc/wasm
 * 优先使用 dist/vendor/@swc/wasm（独立部署场景）
 * 回退到 node_modules/@swc/wasm（开发场景）
 */
function loadSwcWasm(): { transformSync: (code: string, opts: any) => { code: string } } {
  const require = createRequire(import.meta.url);
  const here = dirname(fileURLToPath(import.meta.url));
  const vendored = join(here, "lib", "@swc", "wasm", "wasm.js");

  if (existsSync(vendored)) {
    return require(vendored);
  }
  return require("@swc/wasm");
}

const { transformSync } = loadSwcWasm();

/** 源码中的 import source → 需要注入的完整 import 行 */
const IMPORT_MAP: Record<string, string> = {
  zod: 'import { z } from "../index.js";',
  "@/core/tool": 'import { tool } from "../index.js";',
  "@/core/config": 'import { SupervisionLevel } from "../index.js";',
};

/**
 * 检测文件中是否已从某个 source 导入
 */
function hasImportFrom(content: string, source: string): boolean {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('import ') && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
      if (trimmed.includes(`from "${source}"`) || trimmed.includes(`from '${source}'`)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 注入缺少的导入语句（直接使用目标路径 ../index.js）
 */
function injectImports(content: string): string {
  const lines = content.split('\n');
  let lastImportIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line && line.trim().startsWith('import ') && !line.trim().startsWith('import type')) {
      lastImportIndex = i;
    }
  }

  const missingImports = Object.entries(IMPORT_MAP)
    .filter(([source]) => !hasImportFrom(content, source))
    .map(([, stmt]) => stmt);

  if (missingImports.length === 0) {
    return content;
  }

  if (lastImportIndex === -1) {
    return [...missingImports, '', ...lines].join('\n');
  }

  const injectPosition = lastImportIndex + 1;
  return [
    ...lines.slice(0, injectPosition),
    ...missingImports,
    ...lines.slice(injectPosition),
  ].join('\n');
}

/**
 * 预处理单个 tool 文件（注入导入语句）
 */
function preprocessToolFile(sourcePath: string, outputDir: string): string {
  const sourceContent = readFileSync(sourcePath, 'utf-8');
  const injectedContent = injectImports(sourceContent);

  const fileName = basename(sourcePath, extname(sourcePath));
  const outputPath = join(outputDir, `${fileName}.ts`);

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  writeFileSync(outputPath, injectedContent, 'utf-8');
  return outputPath;
}

/**
 * 使用 @swc/wasm 编译 TS 文件为 JS
 * 首行写入 hash 注释用于增量编译
 */
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
    throw new Error(`工具编译失败 ${fileName}: ${(err as Error).message}`);
  }
}

/** 计算 TS 源码 hash */
function computeSourceHash(sourceContent: string, fileName: string): string {
  return hashGenerator("tool", sourceContent, fileName);
}

/** 读取 JS 文件首行嵌入的 hash，无则返回 null */
function readEmbeddedHash(jsPath: string): string | null {
  if (!existsSync(jsPath)) return null;
  const firstLine = readFileSync(jsPath, "utf-8").split("\n")[0];
  if (!firstLine) return null;
  const match = firstLine.match(/^\/\/ hash:([a-f0-9]+)$/);
  return match ? (match[1] ?? null) : null;
}

/** @test 注解中的测试用例 */
export interface TestCase {
  input: Record<string, unknown>;
  output: { content: string; hash: string };
}

/** 编译结果 */
export interface CompiledToolInfo {
  compiledPath: string;
  sourcePath: string;
  testCases: TestCase[];
}

/**
 * 从源码中解析 /* @test [...] *​/ 注解
 */
export function parseTestCases(sourceContent: string): TestCase[] {
  const match = sourceContent.match(/\/\*\s*@test\s+([\s\S]*?)\s*\*\//);
  if (!match || !match[1]) return [];
  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (tc): tc is TestCase =>
        tc && typeof tc === 'object' && tc.input && tc.output
        && typeof tc.output.content === 'string'
        && typeof tc.output.hash === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * 预处理并编译所有外部 tool 文件
 * 输出到 index.js 同级的 tools/ 目录
 */
export async function preprocessAndCompileAllTools(): Promise<CompiledToolInfo[]> {
  const toolsDir = config.global.tools_dir;

  const distDir = dirname(fileURLToPath(import.meta.url));
  const outputDir = join(distDir, 'tools');
  const tempDir = join(distDir, '.tool-temp');

  if (!existsSync(toolsDir)) {
    return [];
  }

  const files = readdirSync(toolsDir);
  const tsFiles = files.filter(f => f.endsWith('.ts') && !f.startsWith('.'));

  if (tsFiles.length === 0) {
    return [];
  }

  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const results: CompiledToolInfo[] = [];

  try {
    for (const file of tsFiles) {
      const sourcePath = join(toolsDir, file);
      const sourceContent = readFileSync(sourcePath, 'utf-8');
      const sourceHash = computeSourceHash(sourceContent, file);
      const fileName = basename(file, extname(file));
      const expectedJsPath = join(outputDir, `${fileName}.js`);
      const testCases = parseTestCases(sourceContent);

      if (readEmbeddedHash(expectedJsPath) === sourceHash) {
        console.log(`✓ 工具未变化，跳过编译: ${file}`);
        results.push({ compiledPath: expectedJsPath, sourcePath, testCases });
        continue;
      }

      const preprocessedPath = preprocessToolFile(sourcePath, tempDir);
      console.log(`✓ 工具预处理成功: ${file}`);

      const compiledPath = await compileToolFile(preprocessedPath, outputDir, sourceHash);
      results.push({ compiledPath, sourcePath, testCases });
      console.log(`✓ 工具编译成功: ${file} -> ${compiledPath}`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return results;
}
