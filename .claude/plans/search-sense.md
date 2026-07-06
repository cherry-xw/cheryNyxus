# 基于 fff 实现文本搜索 Sense

## 决策与约束

- **必须做成内置感官**：外部感官（`.chery/senses/*.ts`）编译时剥离所有 import，运行时仅注入 `z`/`sense`/`SupervisionLevel`/`registerSenses` 4 个标识符，**无法使用 `@ff-labs/fff-node`**。故按 bash/read/write/skill 惯例做成内置感官 `src/agent/sense/search.ts`。
- **范围（已与用户确认）**：单 sense + `mode` 字段。`mode: "content"`（grep 内容搜索，默认）/ `mode: "filename"`（fileSearch 文件名模糊搜索）。一个 `FileFinder` 单例服务两种查询。
- **监管等级**：`auto`（只读，同 read_file）。
- **hash**：恒返回 `hash: ""`（搜索结果依赖实时索引、非确定性，同 bash 不参与历史去重）。
- **basePath**：`process.cwd()`（匹配用户片段；服务进程根 = 项目代码库根）。不引入 config 项（Rule 2 简洁优先，后续易加）。
- **包管理器**：pnpm（pnpm-lock.yaml + `packageManager` 字段为准；CLAUDE.md 的 `yarn` 命令为过时文档，冲突点已记录，用 pnpm）。

## fff API 要点（v0.9.6，已核对 .d.ts）

- `FileFinder.create({ basePath, aiMode }): Result<FileFinder>`（同步）
- `finder.waitForScan(timeoutMs): Promise<Result<boolean>>`（首次扫描，非阻塞轮询）
- `finder.grep(query, opts): Result<GrepResult>`（同步）；`GrepOptions.mode` `"plain"|"regex"|"fuzzy"`、`pageSize`、`beforeContext`/`afterContext`、`smartCase`（默认 true=全小写不敏感）；`GrepMatch.{relativePath, lineNumber, lineContent, contextBefore?, contextAfter?}`；`GrepResult.{items, totalMatched, totalFilesSearched, totalFiles, nextCursor}`。`nextCursor` 是不透明 branded 类型→**不暴露给 LLM**（无法序列化回传），仅用 `nextCursor !== null` 判断"是否还有更多"。
- `finder.fileSearch(query, { pageSize }): Result<SearchResult>`（同步）；`FileItem.{relativePath, fileName, gitStatus}`；`SearchResult.{items, totalMatched, totalFiles}`。
- query 约束语法（content）：`"*.ts TODO"` 只搜 TS 文件、`"src/ TODO"` 只搜 src 目录。
- 内置实时文件 watcher，扫描后自动跟进变更，无需手动 rescan。
- `FileFinder.isAvailable()` 静态检查原生库是否可加载。

## 实现步骤

### 1. 安装依赖

`pnpm add @ff-labs/fff-node`（自动装平台 optionalDependency `@ff-labs/fff-bin-linux-x64-gnu`，含 `libfff_c.so`）。

### 2. 新建 `src/agent/sense/search.ts`

**Finder 单例（模块级懒加载，缓存 Promise，避免每次调用重扫）：**

```ts
let finderPromise: Promise<FileFinder | null> | null = null;
function getFinder(): Promise<FileFinder | null> {
  if (finderPromise) return finderPromise;
  finderPromise = (async () => {
    if (!FileFinder.isAvailable()) {
      logger.warn("⚠ fff 原生库不可用，search_codebase 感官无法工作");
      return null;
    }
    const created = FileFinder.create({ basePath: process.cwd(), aiMode: true });
    if (!created.ok) { logger.warn(`⚠ fff FileFinder.create 失败: ${created.error}`); return null; }
    const scan = await created.value.waitForScan(10_000);
    if (!scan.ok || !scan.value) logger.warn("⚠ fff 初始扫描超时(10s)，搜索结果可能不完整");
    return created.value;
  })();
  return finderPromise;
}
```

**Schema（仿 read.ts 风格）：**

```ts
const SearchSchema = z.object({
  mode: z.enum(["content", "filename"])
    .describe("搜索模式：content=按文件内容grep搜索文本（默认）；filename=按文件名模糊搜索")
    .optional().default("content"),
  query: z.string().describe("搜索查询。content模式支持约束语法 '*.ts TODO'(仅搜TS文件)、'src/ TODO'(仅搜src目录)；filename模式支持模糊匹配与 'file.ts:42' 行定位"),
  regex: z.boolean().describe("content模式：是否正则匹配，默认false纯文本").optional(),
  maxResults: z.number().int().min(1).max(200).describe("返回结果上限，默认50").optional(),
  contextLines: z.number().int().min(0).max(10).describe("content模式：匹配行前后各显示的上下文行数，默认0").optional(),
});
```

**Handler：** `mode==="filename"` → `finder.fileSearch`；否则 `finder.grep`。结果格式化：
- content：每条 `relativePath:lineNumber: lineContent`，`contextLines>0` 时上下文行带行号缩进；头部汇总 `找到 N 个匹配（搜索 K 文件，共索引 L 文件）` + `nextCursor` 非空时附"仍有更多结果，请缩小查询范围"。
- filename：每条 `relativePath [gitStatus]`（clean 省略）；头部 `找到 N 个匹配文件（共索引 M 文件）`。
- 空结果、错误（`!result.ok`）、finder 未就绪：返回 `{ content: "错误说明", hash: "" }`（错误显性化，不抛异常，同 read.ts 惯例）。

### 3. 注册（`src/agent/sense/index.ts`）

- 加 `import searchSense from "./search";`
- `registerBuiltinSenses()` 的 `registerSenses([...])` 末尾加 `searchSense`。

### 4. config（`.chery/config.yaml`）

- `sense_groups.all_senses` 加 `- search_codebase`
- `sense_groups.safe_senses` 加 `- search_codebase`（只读，归入安全组）

### 5. 文档同步（`docs/agent/sense.md`，遵循"docs 镜像 src"约定）

- 职责行（L7）：内置列表加 `search_codebase`
- 文件清单表：加 `search.ts` 行
- 内置感官注册表：加 `search_codebase | search.ts | auto | mode、query、regex?、maxResults?、contextLines?`
- 关键流程：加 `F. search_codebase` 小节（finder 单例 + content/filename 两路）
- 依赖表"第三方"行：加 `@ff-labs/fff-node`

## 验证

1. `pnpm type-check` — TSC 通过（CLAUDE.md 指明开发期以类型检查为准）。
2. `pnpm build` — SSR 打包通过，确认 fff/ffi-rs 原生模块被 `vite-plugin-native-modules` 正确外置 `.node`、`postBuildFix` 复制到 `dist/lib/`。
3. 运行时冒烟：临时脚本 / vitest 用例创建 finder，`waitForScan` 后 `grep("cheryClaw")` 与 `fileSearch("config.yaml")` 各跑一次，确认 `.so` 加载、索引扫描、结果返回。验证后删除临时脚本。

## 风险与回退

- **fff 原生打包**：`ssr.noExternal: true` 打包 fff JS。`findBinary()` 用 `import.meta.url`+`createRequire` 定位平台 `.so`，打包后 `import.meta.url` 指向项目 `dist/`，但 fallback 仍能从项目 node_modules 解析 `@ff-labs/fff-bin-linux-x64-gnu`（已推演）。`ffi-rs` 是 N-API addon，`nativeModules()` 插件 + `postBuildFix` 应同 better-sqlite3 机制处理其 `.node`。
  - **回退**：若 `pnpm build` 或运行期 ffi-rs addon 加载失败，在 `vite.config.ts` 加 `ssr: { noExternal: true, external: ["@ff-labs/fff-node", "ffi-rs"] }`，让两者从 node_modules 原样加载（fff 自身 `import.meta.url` 正确，绕过打包副作用）。此为 contingency，先按惯例打包验证。
- **Electron ABI**：此 sense 仅在后端 Node 进程运行，不进 web/Electron 包，无 [[web-native-abi-todo]] 的跨 ABI 问题。
