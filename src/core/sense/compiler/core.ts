import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join, basename, extname, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import config from '@/utils/config.js'
import { hashGenerator } from '@/utils/hash.js'
import type { TestCase, SenseCompileSummary } from './types.js'

function loadSwcWasm(): { transformSync: (code: string, opts: unknown) => { code: string } } {
  const require = createRequire(import.meta.url)
  const here = dirname(fileURLToPath(import.meta.url))
  const vendored = join(here, 'lib', '@swc', 'wasm', 'wasm.js')

  if (existsSync(vendored)) {
    return require(vendored)
  }
  return require('@swc/wasm')
}

const { transformSync } = loadSwcWasm()
const COMPILED_FORMAT_VERSION = 'function-body-v1'

// 不再注入外部依赖，编译产物为纯代码
// 运行时通过 new Function() 在当前上下文执行，z/sense/SupervisionLevel 由上下文提供。
// P2-6 安全评估：new Function 在主进程执行编译产物，信任边界 = .chery/senses/*.ts
//   （本地用户配置，与项目代码同级可信）。当前可接受；未来若支持远程 senses 再升级为 vm 隔离。

function stripImports(content: string): string {
  // 移除所有 import 语句，只保留代码
  const lines = content.split('\n')
  const codeLines: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    // 保留非 import 行
    if (!trimmed.startsWith('import ')) {
      codeLines.push(line)
    }
  }

  return codeLines.join('\n')
}

function preprocessSenseFile(sourcePath: string, outputDir: string): string {
  const sourceContent = readFileSync(sourcePath, 'utf-8')
  const strippedContent = stripImports(sourceContent)

  const fileName = basename(sourcePath, extname(sourcePath))
  const outputPath = join(outputDir, `${fileName}.ts`)

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true })
  }

  writeFileSync(outputPath, strippedContent, 'utf-8')
  return outputPath
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return JSON.stringify(err)
}

async function compileSenseFile(
  tsPath: string,
  outputDir: string,
  sourceHash: string,
): Promise<string> {
  const fileName = basename(tsPath, extname(tsPath))
  const outputPath = join(outputDir, `${fileName}.js`)

  try {
    const sourceContent = readFileSync(tsPath, 'utf-8')

    const result = transformSync(sourceContent, {
      jsc: {
        parser: { syntax: 'typescript' },
        target: 'es2022',
      },
      module: { type: 'es6' },
    })

    const exportPattern = /^export default\s+/m
    if (!exportPattern.test(result.code)) {
      throw new Error('自定义感官必须使用 export default 导出 sense(...)')
    }
    // Compiled senses are function bodies evaluated with the runtime z/sense context. Converting
    // the default export to a return keeps tests and runtime loading on the same executable format.
    const executableCode = result.code.replace(exportPattern, 'return ')
    const outputContent = `// hash:${sourceHash}\n${executableCode}`
    writeFileSync(outputPath, outputContent, 'utf-8')
    return outputPath
  } catch (err) {
    throw new Error(`感官编译失败 ${fileName}: ${formatErrorMessage(err)}`)
  }
}

function computeSourceHash(sourceContent: string, fileName: string): string {
  return hashGenerator('sense', COMPILED_FORMAT_VERSION, sourceContent, fileName)
}

function readEmbeddedHash(jsPath: string): string | null {
  if (!existsSync(jsPath)) return null
  const firstLine = readFileSync(jsPath, 'utf-8').split('\n')[0]
  if (!firstLine) return null
  const match = firstLine.match(/^\/\/ hash:([a-f0-9]+)$/)
  return match ? (match[1] ?? null) : null
}

export function parseTestCases(sourceContent: string): TestCase[] {
  const matches = sourceContent.matchAll(/^\/\*\s*@test\s+([\s\S]*?)\s*\*\//gm)
  for (const match of matches) {
    if (!match[1]) continue
    try {
      const parsed = JSON.parse(match[1])
      if (!Array.isArray(parsed)) continue
      return parsed.filter(
        (tc): tc is TestCase =>
          tc &&
          typeof tc === 'object' &&
          tc.input &&
          tc.output &&
          typeof tc.output.content === 'string' &&
          typeof tc.output.hash === 'string',
      )
    } catch {
      continue
    }
  }
  return []
}

export async function compileSenses(): Promise<SenseCompileSummary> {
  const sensesDir = config.global.senses_dir

  const outputDir = join(process.cwd(), 'dist', 'senses')
  const tempDir = join(process.cwd(), 'dist', '.sense-temp')

  if (!existsSync(sensesDir)) {
    return { succeeded: [], failed: [] }
  }

  const files = readdirSync(sensesDir)
  const tsFiles = files.filter((f) => f.endsWith('.ts') && !f.startsWith('.'))

  if (tsFiles.length === 0) {
    return { succeeded: [], failed: [] }
  }

  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true })
  }
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true })
  }

  const summary: SenseCompileSummary = { succeeded: [], failed: [] }

  try {
    for (const file of tsFiles) {
      const sourcePath = join(sensesDir, file)
      const sourceContent = readFileSync(sourcePath, 'utf-8')
      const sourceHash = computeSourceHash(sourceContent, file)
      const fileName = basename(file, extname(file))
      const expectedJsPath = join(outputDir, `${fileName}.js`)
      const testCases = parseTestCases(sourceContent)

      if (readEmbeddedHash(expectedJsPath) === sourceHash) {
        summary.succeeded.push({ compiledPath: expectedJsPath, sourcePath, testCases })
        continue
      }

      try {
        const preprocessedPath = preprocessSenseFile(sourcePath, tempDir)

        const compiledPath = await compileSenseFile(preprocessedPath, outputDir, sourceHash)
        summary.succeeded.push({ compiledPath, sourcePath, testCases })
      } catch (err) {
        const failure = {
          sourcePath,
          fileName: file,
          type: 'syntax' as const,
          message: (err as Error).message,
        }
        summary.failed.push(failure)
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }

  return summary
}
