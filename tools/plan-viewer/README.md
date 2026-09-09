# Plan Viewer（独立开发工具）

仅开发环境使用的计划追踪页面：读取 `docs/plan/` 下的计划文档，可视化展示各计划的状态、任务台账与完成进度。

> **与主项目零关联**：本目录自带独立 `package.json`，不参与主项目的构建、测试与依赖体系；对 `docs/plan` 只读。

## 环境依赖

| 依赖项 | 要求 | 说明 |
|-------|------|------|
| Node.js | **≥ 20**（唯一依赖） | 仅使用内置模块（http / fs / path / zlib 等），无需任何 npm install |
| 操作系统 | 跨平台 | Windows / Linux / macOS 均可（路径处理统一走 `path` 模块） |
| 网络 | 仅 localhost | 页面与服务都在本机，不访问外网 |
| 磁盘 | 对 `docs/plan` 只读 | 任何文件都不写入数据目录 |

安装 = 拷贝文件 + 有 Node，无其他步骤；重新构建（仅改源码时需要）同样只用 Node 内置模块。

## 启动

```bash
# 仓库根快捷指令（推荐；产物缺失时自动构建后启动）
pnpm plan

# 运行单文件产物
node tools/plan-viewer/plan-viewer.mjs
# 或
pnpm --dir tools/plan-viewer start

# 自定义端口（默认 4173）
pnpm plan -- --port=5000
# 指定数据目录（拷贝到其他仓库使用时）
node plan-viewer.mjs --plan-dir=/path/to/repo/docs/plan
```

无需安装任何依赖（仅 Node 内置模块，node ≥ 20）。服务只绑定 IPv4 回环地址 `127.0.0.1`；启动后访问 `http://127.0.0.1:4173`，刷新页面即读取最新文档。

## 双形态结构

```
tools/plan-viewer/
├── public/            # Web 源码（index.html / app.js / style.css）
├── server.mjs         # 服务源码：API + 解析器（源码模式直接读 public/）
├── build.mjs          # 构建：public/ 压缩(gzip+base64)注入 → 单文件产物
├── plan-viewer.mjs    # 单文件产物：可直接 node 启动，可拷贝到任意位置独立使用
├── package.json       # start=产物 / dev=源码 / build
└── README.md
```

- **改页面**：修改 `public/` → `node build.mjs` 重新生成产物（`pnpm --dir tools/plan-viewer build`）。
- **调试**：`pnpm --dir tools/plan-viewer dev` 以源码模式启动（读 `public/`，无需重新构建）。
- **分发**：产物 `plan-viewer.mjs` 是唯一需要的文件；`docs/plan` 定位：`--plan-dir` > 环境变量 `PLAN_DIR` > 从脚本位置向上逐级查找。
- **同步可迁移包**：仓库内构建同时生成本目录及 `docs/standards/documentation/tools/` 的查看器和 lint 单文件产物。`lint-source.mjs`、`server.mjs` 和 `public/` 是源码；不要手改生成脚本。构建不更新 ZIP。

## 功能

- **总览**：对总入口中当前登记的活动计划做状态统计并展示计划卡片（进度条、子任务完成数、范围摘要）；总入口已登记但目录缺失的旧计划灰显提示。查看器仍能兼容历史文档中的 `已完成` 状态，但按当前规范批准完成的计划应从总入口和计划目录删除。
- **任务详情**：渲染计划 README（台账表格带状态徽标、checkbox 勾选态），并列出关联文档。
- **子任务文件**：点开台账/正文中引用的任意 `.md`（含 `verify/` 手册），文档内相对链接可继续跳转。章节定位使用 `#/file/<path>?anchor=<章节>` 或 `#/plan/<dir>?anchor=<章节>`，刷新、前进和后退保留文档与章节；旧请求不得覆盖当前路由。
- 数据每次请求实时读盘，无缓存无构建。

## 进度统计口径

优先级：README 中的 `进度：x/y` 声明行 → 台账表「状态」列统计（已完成/进行中/未开始）→ checkbox 勾选统计。状态和进度元数据兼容普通行、加粗标签（包括 `**进度：**`）和引用块；代码块示例不参与解析。卡片与详情页标注当前采用的口径。

## Plan Lint（文档规则校验）

```bash
pnpm plan:lint        # 仓库根（产物缺失时自动构建；或 node tools/plan-viewer/lint.mjs）
```

规则刻意保持最少，仅检查以下两条，不将通过结果解释为计划完整合规：

- **R1** 总入口 README 任务表格中的每项必须包含可解析、位于计划根内且指向实际任务 README 文件的链接；不允许无链接或无法解析的条目静默跳过
- **R2** 各计划目录的 README 必须有「状态：」行

内联链接、完整/折叠/简写引用式链接使用与查看器相同的解析函数；支持引用定义中的相对路径和可选标题，代码围栏中的示例表格与定义不参与校验。未定义的引用会报错。状态词枚举、台账列结构、进度一致性及创建时间等不在这两条规则的校验范围内；仍须按计划规范审查。违规退出码为 1。

## 实现与验证入口

共享 Markdown 解析位于 [public/markdown.js](public/markdown.js)（`findTables`、`extractLinks`、`metadataValue`）；HTTP 入口为 [server.mjs](server.mjs)，lint 源码为 [lint-source.mjs](lint-source.mjs)。路由和请求有效期由 [public/navigation.js](public/navigation.js) 维护，页面渲染从 [public/app.js](public/app.js) 进入。

修改后运行 `node tools/plan-viewer/build.mjs`（无条件重建；`--if-missing` 仅在产物缺失时构建），再运行 `node --test tools/plan-viewer/tests/*.test.mjs` 和 `pnpm plan:lint`。独立测试只使用 Node 内置模块、隔离临时数据及 HTTP，不启动浏览器，也不使用 DOM/CSS 检查替代界面验收。真实导航与滚动由用户手动验收。

## 边界

- 仅允许读取 `docs/plan/` 内的 `.md` 文件（`/api/file` 做路径越界校验）；指向 `docs/plan` 外部的文档链接以虚线样式提示、不可跳转。
- 解析器对异构台账（列布局不一、状态词不标准、目录缺失）均容错降级，不因个别文档格式差异报错。
- 启动报端口占用时：`pnpm kill:ports`，或换端口 `pnpm plan -- --port=5000`。
