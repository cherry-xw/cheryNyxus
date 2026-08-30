# Sense Compiler（外部感官编译器）

> 源码 [src/core/sense/compiler/](../../src/core/sense/compiler/) ｜ 上级 [core/README.md](./README.md) ｜ 相关 [sense.md](./sense.md)

## 职责

把用户写在 `.chery/senses/*.ts` 的**外部感官源码**编译为可在主进程执行的 JS 产物，供 [`agent/sense/index.ts`](../../src/agent/sense/index.ts) `loadCustomSenses` 通过 `new Function()` 动态加载。它是 core/ 中**唯一带文件系统 I/O** 的子模块。

核心机制：用 `@swc/wasm` 把 TypeScript 转 ES2022，**剥离所有 import 语句**（编译产物是纯代码体），运行时再由 `new Function("z","sense","SupervisionLevel","registerSenses", code)` 把这些标识符作为函数参数注入——这样用户源码可正常写 `import { z } from "zod"` 享受 IDE 类型检查，而编译产物不依赖打包器解析 ESM。编译产物首行嵌入“源码 + 文件名 + 产物格式版本”的 hash，**均未变动时跳过重编**（增量缓存）；加载协议升级会自动失效旧缓存。

## 文件清单

| 文件 | 职责 |
|------|------|
| [core.ts](../../src/core/sense/compiler/core.ts) | `compileSenses()` 主流程、`parseTestCases()`、swc 调用、hash 缓存、import 剥离 |
| [types.ts](../../src/core/sense/compiler/types.ts) | `TestCase`、`CompiledSenseInfo`、`SenseCompileFailure`、`SenseCompileSummary` |
| [utils.ts](../../src/core/sense/compiler/utils.ts) | `buildBaseSenseFunction()`（provider 构造 SenseFunction 的共享 helper） |
| [index.ts](../../src/core/sense/compiler/index.ts) | barrel：聚合导出 core.ts / types.ts |

## 核心概念 / 导出

### SenseCompileSummary（编译产出）

```ts
export interface SenseCompileSummary {
  succeeded: CompiledSenseInfo[];   // 成功：含产物路径、源码路径、自测用例
  failed: SenseCompileFailure[];    // 失败：仅语法错误（type:"syntax"）
}

export interface CompiledSenseInfo {
  compiledPath: string;   // dist/senses/<name>.js
  sourcePath: string;     // .chery/senses/<name>.ts
  testCases: TestCase[];  // 源码 /* @test [...] */ 注释解析出的自测用例
}

export interface TestCase {
  input: Record<string, unknown>;
  output: { content: string; hash: string };
}
```

### compileSenses()（编译入口）

```ts
export async function compileSenses(): Promise<SenseCompileSummary>;
```

流程：

1. 读 `config.global.senses_dir`（=`$CHERY_DIR/.chery/senses`）下所有 `.ts`（跳过 `.` 开头）。
2. 对每个文件算源码 hash（`hashGenerator("sense", content, fileName)`）。
3. 若产物 `dist/senses/<name>.js` 首行 `// hash:<hash>` 与当前一致 → 跳过（增量缓存）。
4. 否则：`preprocessSenseFile`（写 stripped 副本到 `dist/.sense-temp/`）→ `compileSenseFile`（swc transform，产物写 `dist/senses/<name>.js`，首行注入 hash）。
5. `finally` 清理 `dist/.sense-temp/`。

### parseTestCases()

```ts
export function parseTestCases(sourceContent: string): TestCase[];
```

正则匹配源码中的 `/* @test [...] */` 注释块（`gm` 多行），解析为 JSON 数组，过滤出 `input` / `output.content` / `output.hash` 结构合法的项。供 [`agent/sense/index.ts` `runSenseTests`](../../src/agent/sense/index.ts) 跑感官自测。

### buildBaseSenseFunction()（共享 helper）

```ts
export function buildBaseSenseFunction(sense: Sense<ZodType>): SenseFunction["function"];
```

provider（openai/ollama/mock）构造自家工具声明时复用：直接取 `sense.definition.function` 的 name/description/parameters。三者 import 此函数避免重复字段映射。

## 关键流程 / 数据流

```text
─── 编译期（compile-senses 子命令 / 启动期触发） ─────────────────
$CHERY_DIR/.chery/senses/<name>.ts  （用户源码，含 import 语句 + /* @test [] */）
  │
  ├─ computeSourceHash → "abc123"
  ├─ dist/senses/<name>.js 首行 hash == "abc123"?  ── yes ──► 跳过，复用产物
  │                                         └── no ──┐
  │                                                  ▼
  │  preprocessSenseFile: stripImports()  ──► dist/.sense-temp/<name>.ts
  │  （移除所有以 "import " 开头的行，其余原样保留）
  │                                                  ▼
  │  compileSenseFile: swc.transformSync({
  │      jsc: { parser: {syntax:"typescript"}, target:"es2022" },
  │      module: { type:"es6" }
  │  })  ──► 产物 code ── 将默认导出语句 `export default` 转为 `return`
  │                                                  ▼
  │  写 dist/senses/<name>.js = "// hash:abc123\n" + code
  └─ 返回 SenseCompileSummary { succeeded:[...], failed:[...] }

─── 运行期加载（agent/sense/index.ts loadCustomSenses） ──────────
dist/senses/<name>.js  ── 读全文，移除首行 hash 注释 ──►  pureCode
  │
  └─ new Function("z","sense","SupervisionLevel","registerSenses", pureCode)
        (z, sense, SupervisionLevel, registerSenses)   ← 注入运行时上下文
        │
        └─ 返回值若为 Sense 实例（含 definition.function.name）→ registerSenses([result])
```

> **注入依赖 vs 编译依赖**：用户源码顶部写 `import { z } from "zod"` / `import { sense } from "@/core/sense"` 等仅供 IDE 类型检查；compiler **剥离**所有 import，并把默认导出转换成函数体的 `return`；运行时和自测统一通过 `loadCompiledSense()` / `new Function` 注入 `z`、`sense`、`SupervisionLevel`、`registerSenses` 四个标识符。故外部感官源码只能用这四个标识符 + 纯 JS/TS 语法，不能 import 其他模块。

> **安全边界**：`new Function` 在主进程执行编译产物，信任边界 = `.chery/senses/*.ts`（本地用户配置，与项目代码同级可信）。源码注释标注：未来若支持远程 senses 再升级为 `vm` 模块隔离。

## 依赖与关联

- **依赖**：
  - `@swc/wasm`（TypeScript → JS 转译）—— 优先加载 vendor 路径 `core/sense/compiler/lib/@swc/wasm/wasm.js`，回退到 npm 包。
  - Node 内建：`fs`（`readFileSync` / `writeFileSync` / `existsSync` / `mkdirSync` / `readdirSync` / `rmSync`）、`path`、`url`、`module`（`createRequire`）。
  - [`utils/config.ts`](../../src/utils/config.ts) `default export`（取 `config.global.senses_dir`）。
  - [`utils/hash.ts`](../../src/utils/hash.ts) `hashGenerator`（源码 hash）。
  - 类型：[`Sense` / `SenseFunction`](./sense.md)。
- **被依赖**：
  - [`index.ts`](../../src/index.ts)（项目入口）—— `compile-senses` 子命令调 `compileSenses()`，结束后调 `reloadSenses()` 热重建 registry。
  - [`agent/sense/index.ts`](../../src/agent/sense/index.ts) —— `reloadSenses` 调 `loadCustomSenses` 读 `dist/senses/` 产物；`runSenseTests` 用 `parseTestCases` 的 `TestCase[]`。
  - [`agent/sense/compileToolsReporter.ts`](../../src/agent/sense/compileToolsReporter.ts) —— 渲染 `compileSenses()` 的 `SenseCompileSummary` 为命令行报告。
  - [`agent/provider/{openai,ollama,mock}.ts`](../../src/agent/provider/) —— `buildBaseSenseFunction`（utils.ts）。
- **横切参考**：[sense.md](./sense.md)（感官注册与 reloadSenses 全流程）、[根 README](../../README.md)（`compile-senses` 子命令）。

## 扩展点

### 加外部感官

1. 在 `$CHERY_DIR/.chery/senses/<name>.ts` 创建源码：

   ```ts
   import { z } from "zod";
   import { sense } from "@/core/sense";
   import { SupervisionLevel } from "@/core/config";

   /* @test [{"input":{"path":"a"},"output":{"content":"...","hash":"..."}}] */

   export default sense(
     "my_external_sense",
     "External custom sense",
     z.object({ path: z.string() }),
     async (args) => ({ content: `read ${args.path}`, hash: "..." }),
     SupervisionLevel.auto,
   );
   ```

   > import 语句仅用于 IDE 类型检查，编译时会被剥离；运行时只能用 `z` / `sense` / `SupervisionLevel` / `registerSenses` 这四个注入标识符。

2. 运行 `compile-senses` 子命令（或在启动期由 `bootstrapAgentRuntime` 触发）→ 产物写到 `dist/senses/<name>.js`。
3. `reloadSenses()` 自动加载并 `registerSenses`，无需改 `config.yaml` 的 `sense_groups` 即可被 `senseGroup` 引用。

### 修改编译目标 / 缓存策略

改 [core.ts](../../src/core/sense/compiler/core.ts) 的 swc options（`jsc.target` / `module.type`）或 hash 比对逻辑（`readEmbeddedHash` / `computeSourceHash`）。注意：hash 算法变更会让所有产物失效、触发全量重编。
