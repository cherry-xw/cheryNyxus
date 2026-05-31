import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, basename, extname } from "path";
import { build } from "vite";
import config from "./config.js";

/**
 * 外部 tool 文件必须的导入语句
 */
const REQUIRED_IMPORTS = [
  'import { z } from "zod";',
  'import { tool, type ToolResult } from "@/core/tool";',
  'import { SupervisionLevel } from "@/core/config";',
];

/**
 * 检测文件是否已包含某个导入语句
 * 只检测真正的 import 行，忽略注释中的内容
 */
function hasImport(content: string, importStmt: string): boolean {
  const sourceMatch = importStmt.match(/from\s+"([^"]+)"/);
  if (!sourceMatch || !sourceMatch[1]) return false;

  const source = sourceMatch[1];
  const lines = content.split('\n');

  // 只检测以 import 开头的行（排除注释）
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
 * 注入缺少的导入语句
 */
function injectImports(content: string): string {
  const lines = content.split('\n');
  let lastImportIndex = -1;

  // 找到最后一个 import 语句的位置
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line && line.trim().startsWith('import ') && !line.trim().startsWith('import type')) {
      lastImportIndex = i;
    }
  }

  // 收集缺少的导入语句
  const missingImports = REQUIRED_IMPORTS.filter(stmt => !hasImport(content, stmt));

  if (missingImports.length === 0) {
    return content; // 无需注入
  }

  // 如果文件没有 import，在文件开头注入
  if (lastImportIndex === -1) {
    return [...missingImports, '', ...lines].join('\n');
  }

  // 在最后一个 import 后注入缺少的导入
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

  // 确保输出目录存在
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // 写入注入后的 TS 文件
  writeFileSync(outputPath, injectedContent, 'utf-8');

  return outputPath;
}

/**
 * 编译预处理后的 TS 文件为 JS
 * 使用 Vite build 编译单个文件
 */
async function compileToolFile(tsPath: string, outputDir: string): Promise<string> {
  const fileName = basename(tsPath, extname(tsPath));
  const projectRoot = config.global.chery_dir || process.cwd();

  try {
    // 使用 Vite 编译单个文件
    await build({
      configFile: false,
      build: {
        emptyOutDir: false,
        outDir: outputDir,
        lib: {
          entry: tsPath,
          formats: ['es'],
          fileName: () => `${fileName}.js`,
        },
        rollupOptions: {
          // zod 和 @/core/* 作为 external
          external: ['zod', '@/core/tool', '@/core/config'],
        },
        minify: false,
        sourcemap: false,
      },
      resolve: {
        alias: {
          // 路径别名指向 src 目录（用于编译时类型检查）
          '@': join(projectRoot, 'src'),
        },
      },
      // 自定义插件：替换导入路径为 ../index.js
      plugins: [{
        name: 'rewrite-imports',
        enforce: 'post',
        generateBundle(_options, bundle) {
          for (const chunk of Object.values(bundle)) {
            if (chunk.type === 'chunk' && chunk.code) {
              // 替换 @/core/tool 和 @/core/config 为 ../index.js
              chunk.code = chunk.code
                .replace(/from\s+"@\/core\/tool"/g, 'from "../index.js"')
                .replace(/from\s+"@\/core\/config"/g, 'from "../index.js"')
                .replace(/from\s+'@\/core\/tool'/g, 'from "../index.js"')
                .replace(/from\s+'@\/core\/config'/g, 'from "../index.js"');
            }
          }
        },
      }],
    });

    return join(outputDir, `${fileName}.js`);
  } catch (err) {
    // Vite 编译失败时使用简易转译
    return transpileToolFile(tsPath, outputDir);
  }
}

/**
 * 简易转译：替换路径别名 + 移除 TypeScript 类型语法
 */
function transpileToolFile(tsPath: string, outputDir: string): string {
  const content = readFileSync(tsPath, 'utf-8');
  const fileName = basename(tsPath, extname(tsPath));
  const outputPath = join(outputDir, `${fileName}.js`);

  // 替换路径别名 @/ 为相对路径（指向 dist/index.js 同级）
  // dist/custom/xxx.js 需要 import from ../index.js 中的导出
  const transpiled = content
    .replace(/from\s+"@\/core\/tool"/g, 'from "../index.js"')
    .replace(/from\s+"@\/core\/config"/g, 'from "../index.js"')
    .replace(/: Promise<ToolResult>/g, '')
    .replace(/: z\.infer<[^>]+>/g, '')
    .replace(/as Tool<[^>]+>/g, '');

  writeFileSync(outputPath, transpiled, 'utf-8');
  return outputPath;
}

/**
 * 预处理并编译所有外部 tool 文件
 * 输出到 dist/custom/ 目录（打包产物同级）
 */
export async function preprocessAndCompileAllTools(): Promise<string[]> {
  const toolsDir = config.global.tools_dir;
  const cheryDir = config.global.chery_dir || process.cwd();

  // 输出到 dist/custom/ 目录
  const distDir = join(cheryDir, 'dist');
  const outputDir = join(distDir, 'custom');
  const tempDir = join(cheryDir, '.chery', 'tools', 'temp');

  if (!existsSync(toolsDir)) {
    return [];
  }

  const files = readdirSync(toolsDir);
  const tsFiles = files.filter(f => f.endsWith('.ts') && !f.startsWith('.'));

  if (tsFiles.length === 0) {
    return [];
  }

  // 确保目录存在
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const compiledPaths: string[] = [];

  for (const file of tsFiles) {
    const sourcePath = join(toolsDir, file);
    try {
      // Step 1: 预处理（注入导入语句）
      const preprocessedPath = preprocessToolFile(sourcePath, tempDir);
      console.log(`✓ 工具预处理成功: ${file}`);

      // Step 2: 编译为 JS
      const compiledPath = await compileToolFile(preprocessedPath, outputDir);
      compiledPaths.push(compiledPath);
      console.log(`✓ 工具编译成功: ${file} -> ${compiledPath}`);
    } catch (err) {
      console.warn(`⚠ 工具编译失败: ${file}`, (err as Error).message);
    }
  }

  return compiledPaths;
}