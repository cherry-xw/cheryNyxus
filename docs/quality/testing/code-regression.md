# 代码质量回归操作

> 定位：大型任务收尾时执行的代码质量回归检查操作手册。它只说明「怎么跑、怎么判读、怎么维护基线」，不含一次性分析结论；未执行的重构目标如需登记，另行按计划或已知问题流程维护。
>
> 回归范围：扫描 `apps/backend/src/`、`apps/web/src/`、`packages/`、`apps/manager/`、`apps/relay/`（配置见根 [`.jscpd.json`](../../../.jscpd.json)，排除测试与产物）。

## 何时运行

每次大型任务收尾时统一执行一次综合回归：

```bash
pnpm regression:code
```

它依次运行重复门禁、死代码报告、复杂度报告。任一门禁失败时整体退出码非 0。

## 命令清单

脚本定义在根 [`package.json`](../../../package.json)（`jscpd:*` 与 `regression:code`）。

| 命令 | 作用 | 退出码含义 |
| --- | --- | --- |
| `pnpm jscpd:dup` | 全量重复扫描（报告） | 0：完成（不区分旧/新重复） |
| `pnpm jscpd:dup:check` | **回归门禁**：对比基线，只拦新增重复 | 0：无新增；1：有新增（阻断） |
| `pnpm jscpd:baseline` | 刷新重复基线（确认接受当前状态时手动执行并提交） | 0：完成 |
| `pnpm jscpd:deadcode` | 死代码扫描（basta 引擎） | 0：完成（报告） |
| `pnpm jscpd:complexity` | 复杂度排名（top 20） | 0：完成（报告） |
| `pnpm jscpd:health` | 健康评分 + 项目/Duplication/Complexity/Dead code 一屏总览 | 0：完成（报告） |
| `pnpm regression:code` | 一键综合回归：`dup:check`（硬门禁）+ `deadcode` + `complexity` | 任一门禁失败即非 0 |

后端死代码另有独立交叉扫描：`pnpm deadcode:scan`（见 [`scripts/deadcode-scan.mjs`](../../../scripts/deadcode-scan.mjs)，knip∩CodeGraph）。

## 判读要点

1. **重复门禁为硬性**：`dup:check` 失败说明引入了新的复制粘贴，应先合并；仅在确认新重复合理时才用 `pnpm jscpd:baseline` 刷新并提交。
2. **`.vue` 未用符号多为误报**：basta 不解析 Vue 模板，`ref`/计算属性在 `<template>` 中被使用也会被报为「未用符号」。删除前必须核实模板引用（搜索符号名是否出现在模板区域）。
3. **协议注册的 handler 不是死代码**：`router.register(方法名, handler)` 按方法名字符串注册、前端按方法名调用，会被工具误报为未用导出。删除前必须核对注册表与前端调用方，不得按报告直接删。
4. **复杂度与死代码当前不做硬门禁**（集中开发期误伤风险高），作报告对照；仅重复门禁为硬性阻断。
5. **health 徽章的 duplication 子项**存在工具口径差异（显示 0.0%），不作为重复率依据；以 `pnpm jscpd:dup` 与 dashboard Duplication 区的实际百分比为准。

## 基线维护

- 根 [`.jscpd.json`](../../../.jscpd.json) 与 [`.jscpd-baseline.json`](../../../.jscpd-baseline.json) 一同入库；后者记录「已接受」的重复指纹，是 `dup:check` 的判定依据。
- 改动 `.jscpd.json` 的扫描路径、`minTokens`/`minLines` 等配置后，基线指纹会失配，需用 `pnpm jscpd:baseline` 重新生成并提交。
- 大规模清理/重构后，若确认当前状态可接受，执行 `pnpm jscpd:baseline` 刷新基线并提交。

## 当前结果判定

规模、重复率、复杂度和测试结果均从当前代码重新检查，不保留旧测量快照作为现状。新增功能可能合理增加规模；不能仅凭行数增加认定回归，也不能以固定历史失败数量判定通过。测试执行及失败分类遵守[测试范围与结果判定](baseline.md)。

本文件拥有质量工具的运行和基线维护方法；结构、引用和职责判断见[代码结构核对与回归](refactor-baseline.md)。原始报告保存在仓库外的运行记录中，本文不宣称这些工具已在当前工作区执行通过。

测量命令（PowerShell，排除 `node_modules`/`dist`/`.d.ts`）：

```powershell
foreach($d in @('src','apps/web/src','packages','manager','relay')){
  $files=Get-ChildItem -Recurse -File -Include *.ts,*.tsx,*.vue -Path $d |
    Where-Object { $_.FullName -notmatch 'node_modules|dist|\.d\.ts$' }
  $sum=($files | ForEach-Object { (Get-Content $_.FullName).Count } | Measure-Object -Sum).Sum
  "{0}: files={1} lines={2}" -f $d, $files.Count, $sum
}
```
