# 文档能力扩展与统一检查：自动验证原始输出

**执行日期：** 2026-09-25

**执行目录：** 仓库根目录

以下为最终收口前重新执行 A1-A8 的原始输出。全部命令退出码均为 0。

## A1：文档检查器测试

命令：`node --test scripts/docs/tests/*.test.mjs`

```text
TAP version 13
# Subtest: checks local links and anchors in a temporary documentation root
ok 1 - checks local links and anchors in a temporary documentation root
  ---
  duration_ms: 27.2684
  type: 'test'
  ...
# Subtest: parses supported front matter fields
ok 2 - parses supported front matter fields
  ---
  duration_ms: 4.8063
  type: 'test'
  ...
# Subtest: rejects front matter while project metadata is disabled
ok 3 - rejects front matter while project metadata is disabled
  ---
  duration_ms: 16.9207
  type: 'test'
  ...
# Subtest: checks plan boundaries without requiring the repository plan lint
ok 4 - checks plan boundaries without requiring the repository plan lint
  ---
  duration_ms: 100.7214
  type: 'test'
  ...
# Subtest: checks entries, nested READMEs, and orphan Markdown files
ok 5 - checks entries, nested READMEs, and orphan Markdown files
  ---
  duration_ms: 36.1561
  type: 'test'
  ...
# Subtest: extracts inline and reference links while ignoring code and images
ok 6 - extracts inline and reference links while ignoring code and images
  ---
  duration_ms: 5.686
  type: 'test'
  ...
# Subtest: creates stable duplicate heading anchors
ok 7 - creates stable duplicate heading anchors
  ---
  duration_ms: 6.457
  type: 'test'
  ...
1..7
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 314.5883
Command exited with code 0.
```

## A2：综合文档检查

命令：`pnpm --offline run docs:check`

```text
$ node scripts/docs/check.mjs
Docs links：通过，对象 191
Docs structure：通过，对象 5
Docs plan：通过
Docs metadata：通过
Docs check 通过：全部文档检查通过
Command exited with code 0.
```

## A3：计划边界检查

命令：`node scripts/docs/check-plan.mjs`

```text
Docs plan 通过：计划入口、状态、目录边界和验证产物规则均通过
Command exited with code 0.
```

## A4：来源与元信息检查

命令：`node scripts/docs/check-metadata.mjs`

```text
Docs metadata 通过：未发现未登记的来源或页面元信息
Command exited with code 0.
```

## A5：现有计划工具检查

命令：`node tools/plan-viewer/lint-source.mjs`

```text
Plan Lint 通过：总入口 9 项、计划目录 9 个（规则 R1 链接存在、R2 状态行）
Command exited with code 0.
```

## A6：代码库空白检查

命令：`git diff --check`

```text
(no output)
Command exited with code 0.
```

## A7：文档命令入口检查

命令：`pnpm --offline run docs:test`

```text
$ node --test scripts/docs/tests/*.test.mjs
TAP version 13
# Subtest: checks local links and anchors in a temporary documentation root
ok 1 - checks local links and anchors in a temporary documentation root
  ---
  duration_ms: 24.6332
  type: 'test'
  ...
# Subtest: parses supported front matter fields
ok 2 - parses supported front matter fields
  ---
  duration_ms: 3.3505
  type: 'test'
  ...
# Subtest: rejects front matter while project metadata is disabled
ok 3 - rejects front matter while project metadata is disabled
  ---
  duration_ms: 15.2597
  type: 'test'
  ...
# Subtest: checks plan boundaries without requiring the repository plan lint
ok 4 - checks plan boundaries without requiring the repository plan lint
  ---
  duration_ms: 98.6025
  type: 'test'
  ...
# Subtest: checks entries, nested READMEs, and orphan Markdown files
ok 5 - checks entries, nested READMEs, and orphan Markdown files
  ---
  duration_ms: 30.7088
  type: 'test'
  ...
# Subtest: extracts inline and reference links while ignoring code and images
ok 6 - extracts inline and reference links while ignoring code and images
  ---
  duration_ms: 6.4177
  type: 'test'
  ...
# Subtest: creates stable duplicate heading anchors
ok 7 - creates stable duplicate heading anchors
  ---
  duration_ms: 7.8576
  type: 'test'
  ...
1..7
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 258.0905
Command exited with code 0.
```

## A8：自动工作流引用检查

命令：`Test-Path .github\workflows\docs.yml` 并检查 `pnpm docs:test`、`pnpm docs:check`。

```text
workflow_exists=True
47:run: pnpm docs:test
50:run: pnpm docs:check
Command exited with code 0.
```
