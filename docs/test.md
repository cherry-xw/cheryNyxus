# 测试基线与门控索引

> 状态：test/ 模块当前**整体推迟**（用户 2026-07-12 指令，重构前不碰）。本文档作为 P1-P6 修复的**回归判定索引**：哪些错误属基线/非回归，哪些必须转绿。

## 测试门控：src 走 TSC，test/ 跳过

按 memory「test 模块推迟」：

- **不**新增 / 修改 / 跑 `test/` 下任何文件
- **不**引用测试结果做回归门判定
- src 端门控 = `pnpm type-check`（exit 0 = 通过；新增错误非基线 = 回归）
- P1-P6 修复**不**写测试兜底

## TSC 基线预存错误

按 [[tsc-baseline-preexisting-errors]]：以下文件 / 行号有预存 TSC 错误，**非回归**，跑 `pnpm type-check` 时排除：

| 文件 | 备注 |
|------|------|
| `src/service/brain/proxy/list.ts` | 行号随新增函数漂移 |
| `src/db/chat.ts` | `parseMessageRow` cast 缺类型，行号随上方新增漂移（504→520→538） |
| `web/src/features/agent/HistoryDrawer.vue` | 第 149 行附近 |
| `web/src/services/agentApi.ts` | 第 261 行附近 |

跑 TSC 时以上错误**不计入回归**。其余文件 TSC 0 错 = 通过。

## test/ 套件预存失败

按 [[test-suite-baseline-preexisting-failures]]：~86 个预存失败分四类，**非回归**，跑 `pnpm test` 时排除：

| 类别 | 性质 |
|------|------|
| `mcpServers.*` | MCP server 测试与 src MCP 实现脱节 |
| `send-runtime.*` | chat.send runtime 链路测试与重构后 src 不对齐 |
| `startService.*` | 启动服务测试与重构后 index.ts 不对齐 |
| `provider-router desync` | provider router 测试与重构后 registry 不对齐 |

测试失败数 ≤ 86 = 不增不减 = 通过；新增失败 = 回归。

## 既有的 P6 测试（保留不删）

P6 阶段已写三组测试（按 [[test-module-deferred]] 保留不删、不扩展、不跑）：

- `test/agent/middleware/retry.test.ts`：14 用例，含 3 个 P6a auth 分类测试（401/403/invalid api key → 1 次后 yield error，不重试）
- `test/service/chat/send.test.ts`：16 用例，含 3 个 P2 回归门用例（streamAgentChunks onError → failureResponse success:false，done notification 抑制）
- `test/service/media/index.test.ts`：16 用例，覆盖 mediaKindForMime/understandMediaReference/saveMediaAsset/readMediaAsset

## 回归判定流程

```bash
# 1. src 门控（必跑）
pnpm type-check
# 期望：除基线 4 处外 0 错，exit 0

# 2. test/ 不跑（按推迟指令）
# pnpm test  # 跳过

# 3. 前端验证（按 [[frontend-verification-user-only]]）
# 用户自验 vue-tsc / vite build / vitest，不在 Claude 流程内
```

## 重构时机

由用户决定，本索引解除前一律不碰 test/。

## 依赖与关联

- **关联记忆**：[[test-module-deferred]]、[[test-suite-baseline-preexisting-failures]]、[[tsc-baseline-preexisting-errors]]、[[frontend-verification-user-only]]
- **关联文档**：[docs/mock.md](./mock.md)（mock provider 脚本化离线测试，可手动跑 mock brain 验证修复）