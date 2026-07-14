# 错误信息分层规范（Error Conventions）

> 横切规范：所有面向用户的错误提示（前端 toast/banner、WS 错误帧、HTTP 错误响应、provider/middleware 抛错、控制台 warn）都应遵循此约定。
>
> **Why**：用户看到的应是"是什么 + 改哪里"的人话，不是机读 ID 或技术栈；开发者排查则需要完整上下文。两者各居其位，**互不污染**。
>
> **How to apply**：抛错前调 `throwUserFacing(scope, userMessage, context)`，message 自动追加 `tracingId`，详细上下文走 `logger.event` 落盘。

## 核心原则：用户面 vs 日志面分离

错误信息**分两层**展示：

| 层级 | 形态 | 用途 |
|------|------|------|
| **用户面**（throw / 推送给前端） | 直白可读中文，1 行，末尾含 8 位 `tracingId` | 用户自助修复 / 报问题时提供 id |
| **日志面**（`logger.event`） | 结构化 JSON 事件，含完整上下文 | 开发者凭 `tracingId` 全文检索日志还原 |

## 用户面规则

1. **中文**（项目 [规范](../.claude/CLAUDE.md)）
2. **一行**（不堆栈、不 trace、不内嵌多行）
3. **指出"是什么 + 改哪里"**——不展开技术细节、不暴露机读 ID
4. **末尾追加 `[tracingId]`** —— 8 位 hex（UUID 前 8 位），便于口头/工单抄录
5. **避开 retry 可恢复关键词**（`api` / `invalid` / `timeout` / `network` / `connection` / `schema`），落到 [retry 中间件](./agent/middleware.md) 的 `unknown` 分类 → **不重试**、直接响应前端
6. **不暴露后端机读字段**（如 OpenAI 返回的 `request id`、HTTP `status`、栈帧）—— 这些只进日志，不进 message

## 日志面规则

1. **类型**：`logger.event("<scope>", { ... }, LogLevel.error)`；scope 用模块前缀（`llm.*` / `sense.*` / `mcp.*` / `compose.*` / `app.*`）
2. **必含字段**：
   - `tracingId`：8 位 hex
   - `error`：完整 message
   - 1~3 个上下文锚定字段（`model` / `senseName` / `component` / `chatId`）
3. **扩展字段**：`reason`（细分原因枚举，如 `placeholder_unresolved` / `key_empty` / `network_refused`）、`url` / `envName` / `attempt` 等自由扩展
4. **栈**：`cause` 链由 Error.cause 传递，不在 data 里重复

## 反例 vs 正例

| 形态 | 例子 | 评价 |
|------|------|------|
| ❌ 反例 | `[compose] handler at index 3 threw: 401 Invalid token (request id: 202607131304151821714278268d9d6Ik7M6LwN)` | 技术层细节、不可读、机读 ID 暴露、无修复指引 |
| ❌ 反例 | `Error: connect ECONNREFUSED 127.0.0.1:11411` | 英文栈、用户不可操作 |
| ❌ 反例 | `Brain key 未配置（glm-5.2@https://yz.xcherry.top:11411/v1），请在 .env 设置对应环境变量` | URL 噪音、`(model@url)` 长尾巴 |
| ✓ 正例 | `glm-5.2 缺少 key。请在 .env 或环境变量中设置 API_KEY 后重启 [1c538629]` | 哪个脑 / 缺什么 / 改哪里 / 追踪 id 全有 |
| ✓ 正例 | `mock_test 缺少 key。请在 .chery/config.yaml 的 llm.brain 段检查 key 字段 [7d0ff4a1]` | 同上，但修复路径指向 config |

## 实施工具

### newTracingId()

```ts
import { randomUUID } from "node:crypto";

/**
 * 8 位 hex tracingId：UUID v4 前 8 位，理论 16^8 ≈ 42 亿组合，足够全局唯一。
 * 实际唯一性由 ALS scope + model/url/envName 锚定共同保证；此处仅作"可抄录标识"。
 */
export function newTracingId(): string {
  return randomUUID().slice(0, 8);
}
```

### throwUserFacing()

```ts
import { logger } from "@/utils/logger/index.js";
import { LogLevel } from "@/utils/logger/types.js";

/**
 * 抛用户面错误：message 短直白，日志面含完整上下文。
 *
 * @param scope     logger event type（模块前缀，如 "llm.key.missing"）
 * @param userMessage 用户面 message（不含 tracingId，函数自动追加 `[tracingId]`）
 * @param context   日志面额外字段（model/url/envName/reason 等）
 * @throws Error（never return）
 */
export function throwUserFacing(
  scope: string,
  userMessage: string,
  context: Record<string, unknown> = {},
): never {
  const tracingId = newTracingId();
  logger.event(scope, { tracingId, ...context }, LogLevel.error);
  throw new Error(`${userMessage} [${tracingId}]`);
}
```

### 用法示例

```ts
// src/agent/provider/openai.ts
const placeholderMatch = key?.match(/^\$([A-Z_][A-Z0-9_]*)$/);
if (placeholderMatch) {
  const envName = placeholderMatch[1]!;
  throwUserFacing(
    "llm.key.missing",
    `${model} 缺少 key。请在 .env 或环境变量中设置 ${envName} 后重启`,
    { model, url, envName, reason: "placeholder_unresolved" },
  );
}
if (!key) {
  throwUserFacing(
    "llm.key.missing",
    `${model} 缺少 key。请在 .chery/config.yaml 的 llm.brain 段检查 key 字段`,
    { model, url, reason: "key_empty" },
  );
}
```

> **注**：当 `throwUserFacing` 收敛到统一工具后，[openai.ts 的两处重复实现](../src/agent/provider/openai.ts) 应替换为该工具调用，避免散落。

## 适用范围

| 场景 | 实施位置 | 状态 | 备注 |
|------|---------|------|------|
| Provider 抛错（openai 无 key / 占位符） | [src/agent/provider/openai.ts](../src/agent/provider/openai.ts) | ✓ 已实施 | 详见 [agent/provider.md](./agent/provider.md) |
| Provider 抛错（ollama / mock） | [src/agent/provider/](../src/agent/provider/) | 审视 | ollama 不需要 key，mock 一般不抛 401；如有其他错误路径，按需 |
| Middleware 通用错误包装 | [src/core/middleware/compose.ts](../src/core/middleware/compose.ts) | ✓ 已实施 | 合规错误原样上浮，未合规（第三方裸抛）重包为 `内部错误 [tracingId]`，详细走 logger |
| Sense 执行错误 | [src/agent/middleware/](../src/agent/middleware/) | TODO | sense 抛错同样要分层 |
| WebSocket 错误帧（router 结构校验失败） | [src/service/message/router.ts](../src/service/message/router.ts) | ✓ 已实施 | `safeParse` 失败（INVALID_PARAMS）：message 一行中文 + `tracingId`，完整 Zod issues（path/code/expected/received）走 `logger.event("req.invalid_params")` 落盘。handler 业务校验错误（如 `saveRawConfig`）仍各自返回中文 join 串，未走本工具 |
| HTTP 错误响应 | [src/service/http/](../src/service/http/) | TODO | 401/500 等响应 body 同样分层 |
| 前端 toast / banner | [web/src/](../web/src/) | TODO | **消费**后端 tracingId 展示给用户；前端**不重生成** |

## 日志检索约定

用户报 `[tracingId]` 后：

```bash
# 项目根目录
grep "1c538629" .chery/logs/

# 全局更稳（tracingId 出现于日志 JSON 事件 data 字段）
grep -r '"tracingId":"1c538629"' .chery/
```

日志格式与查询详见 [utils/logger.md](./utils/logger.md)。

## 演进原则

- **新增错误出口**（RPC handler、sense、prompt、media gateway）必须遵循本规范——不引技术栈裸抛
- **改造旧错误**：从用户最痛点开始（高频报错 + 信息丢失严重的）逐步改造
- **tracingId 全链路**：同一 chat / 同一 RPC 调用产生的多个错误应共享**同一** tracingId，便于串联整条调用链——目前 `newTracingId()` 每次独立生成，后续如需全链路可改为从 `ctx.soul.chatId` + step 派生
