/**
 * retryMiddleware 单元测试（纯单元）。
 *
 * 覆盖：
 * - 成功透传（不重试）
 * - network 错误重试 MAX_RETRIES 次后 yield ErrorChunk
 * - validation 不可恢复 → 首次失败即 yield ErrorChunk（不重试）
 * - auth 错误（401/403）不可恢复 → 首次失败即 yield ErrorChunk（P1 加固：避免 token 失效重试 3x 浪费）
 * - 第 2 次成功 → 透传不 yield error
 * - approval aborted → re-throw（不转 ErrorChunk）
 * - chat 流中途失败：snapshot 回滚半截 message
 * - 错误分类（network/timeout/validation/provider/unknown）
 */
import { describe, it, expect } from "vitest";
import { retryMiddleware } from "@/agent/middleware/retry.js";
import { AgentAbortError } from "@/core/middleware/errors.js";
import type { MiddlewareChunk, ErrorChunk, StreamChunk } from "@/core/middleware/types.js";
import { createMockContext } from "../helpers/fakeContext.js";
import { collectChunks } from "../helpers/chunkAssert.js";

type NextFactory = () => AsyncGenerator<MiddlewareChunk>;

/** 构造按顺序行为的 next：每次调用取下一个 behavior */
function sequenceNext(behaviors: NextFactory[]): NextFactory {
  let i = 0;
  return () => {
    const idx = Math.min(i, behaviors.length - 1);
    const b = behaviors[idx]!;
    i++;
    return b();
  };
}

function yieldsChunks(chunks: MiddlewareChunk[]): NextFactory {
  return async function* gen(): AsyncGenerator<MiddlewareChunk> {
    for (const c of chunks) yield c;
  };
}

function throwsError(message: string): NextFactory {
  return async function* gen(): AsyncGenerator<MiddlewareChunk> {
    throw new Error(message);
  };
}

function firstError(chunks: MiddlewareChunk[]): ErrorChunk | undefined {
  return chunks.find((c) => c.type === "error") as ErrorChunk | undefined;
}

describe("retryMiddleware 成功路径", () => {
  it("成功 → 透传 chunks 不重试不 yield error", async () => {
    const ctx = createMockContext({ messages: [] });
    const stream: StreamChunk = { type: "stream", thinkingDelta: "t", contentDelta: "c" };
    const next = yieldsChunks([stream]);
    const out = await collectChunks(retryMiddleware(ctx, next));
    expect(out.some((c) => c.type === "stream")).toBe(true);
    expect(firstError(out)).toBeUndefined();
  });

  it("第 2 次成功 → 透传不 yield error（重试 1 次后成功）", async () => {
    const ctx = createMockContext({ messages: [] });
    const stream: StreamChunk = { type: "stream", thinkingDelta: "", contentDelta: "ok" };
    const calls: number[] = [];
    const next = sequenceNext([
      async function* () {
        calls.push(1);
        throw new Error("network connection failed");
      },
      async function* () {
        calls.push(2);
        yield stream;
      },
    ]);
    const out = await collectChunks(retryMiddleware(ctx, next));
    expect(calls).toEqual([1, 2]);
    expect(out.some((c) => c.type === "stream")).toBe(true);
    expect(firstError(out)).toBeUndefined();
  });
});

describe("retryMiddleware 重试耗尽", () => {
  it("network 错误重试 3 次后 yield ErrorChunk（attempt 1/2/3）", async () => {
    const ctx = createMockContext({ messages: [] });
    const next = sequenceNext([
      throwsError("network connection refused"),
      throwsError("ECONNREFUSED"),
      throwsError("ENOTFOUND"),
    ]);
    const out = await collectChunks(retryMiddleware(ctx, next));
    const err = firstError(out);
    expect(err).toBeDefined();
    expect(err!.errors.length).toBe(3);
    expect(err!.errors.map((e) => e.attempt)).toEqual([1, 2, 3]);
    expect(err!.errors.every((e) => e.category === "network")).toBe(true);
    expect(err!.errors.every((e) => e.recoverable)).toBe(true);
  });

  it("validation 错误不可恢复 → 首次失败即 yield error（不重试）", async () => {
    const ctx = createMockContext({ messages: [] });
    let callCount = 0;
    const next = sequenceNext([
      async function* () {
        callCount++;
        throw new Error("validation invalid schema");
      },
    ]);
    const out = await collectChunks(retryMiddleware(ctx, next));
    const err = firstError(out);
    expect(err).toBeDefined();
    expect(err!.errors.length).toBe(1);
    expect(err!.errors[0]!.category).toBe("validation");
    expect(err!.errors[0]!.recoverable).toBe(false);
    expect(callCount).toBe(1); // 未重试
  });
});

describe("retryMiddleware abort 传播", () => {
  it("approval aborted → re-throw 不转 ErrorChunk", async () => {
    const ctx = createMockContext({ messages: [] });
    const next = async function* (): AsyncGenerator<MiddlewareChunk> {
      throw new AgentAbortError();
    };
    await expect(collectChunks(retryMiddleware(ctx, next))).rejects.toThrow(AgentAbortError);
  });
});

describe("retryMiddleware messages 回滚", () => {
  it("chat 流中途失败 → 回滚半截 message 到 snapshot", async () => {
    const ctx = createMockContext({
      messages: [{ id: "base", role: "user", content: "hi", createdAt: 0, updateAt: 0 }],
    });
    const next = sequenceNext([
      async function* () {
        // 模拟 checkpoint 中途 push 半截 assistant 后失败
        ctx.soul.messages!.push({ id: "half", role: "assistant", content: "half", createdAt: 0, updateAt: 0 });
        throw new Error("network failed");
      },
      async function* () {
        yield { type: "stream", thinkingDelta: "", contentDelta: "retry-ok" } as StreamChunk;
      },
    ]);
    await collectChunks(retryMiddleware(ctx, next));
    // 半截 assistant 被回滚，仅剩 base + 第2次成功的 assistant（由 checkpoint 构建，这里 next 不构建）
    expect(ctx.soul.messages!.some((m) => m.id === "half")).toBe(false);
    expect(ctx.soul.messages!.some((m) => m.id === "base")).toBe(true);
  });
});

describe("retryMiddleware 错误分类", () => {
  async function classifyOnce(message: string): Promise<string> {
    const ctx = createMockContext({ messages: [] });
    const out = await collectChunks(retryMiddleware(ctx, throwsError(message)));
    const err = firstError(out);
    return err!.errors[0]!.category;
  }

  it("network: connection / econnrefused / enotfound", async () => {
    expect(await classifyOnce("connection reset")).toBe("network");
    expect(await classifyOnce("ECONNREFUSED 127.0.0.1")).toBe("network");
  });

  it("timeout: timed out", async () => {
    expect(await classifyOnce("request timed out")).toBe("timeout");
  });

  it("validation: invalid / schema", async () => {
    expect(await classifyOnce("invalid parameter")).toBe("validation");
  });

  it("provider: api / rate limit", async () => {
    expect(await classifyOnce("rate limit exceeded")).toBe("provider");
  });

  it("unknown: 其他", async () => {
    expect(await classifyOnce("something weird")).toBe("unknown");
  });
});

describe("retryMiddleware auth 错误（401/403 不重试）", () => {
  it("401 invalid access token → 1 次即 yield error，category=auth", async () => {
    const ctx = createMockContext({ messages: [] });
    let callCount = 0;
    const next = sequenceNext([
      async function* () {
        callCount++;
        throw new Error("401 invalid access token");
      },
    ]);
    const out = await collectChunks(retryMiddleware(ctx, next));
    const err = firstError(out);
    expect(err).toBeDefined();
    expect(err!.errors.length).toBe(1);
    expect(err!.errors[0]!.recoverable).toBe(false);
    expect(err!.errors[0]!.category).toBe("auth");
    expect(callCount).toBe(1);
  });

  it("403 forbidden → 1 次即 yield error，category=auth", async () => {
    const ctx = createMockContext({ messages: [] });
    let callCount = 0;
    const next = sequenceNext([
      async function* () {
        callCount++;
        throw new Error("403 Forbidden");
      },
    ]);
    const out = await collectChunks(retryMiddleware(ctx, next));
    const err = firstError(out);
    expect(err).toBeDefined();
    expect(err!.errors.length).toBe(1);
    expect(err!.errors[0]!.recoverable).toBe(false);
    expect(err!.errors[0]!.category).toBe("auth");
    expect(callCount).toBe(1);
  });

  it("invalid api key（与参数 validation 同字段 'invalid'） → category=auth 优先", async () => {
    const ctx = createMockContext({ messages: [] });
    let callCount = 0;
    const next = sequenceNext([
      async function* () {
        callCount++;
        throw new Error("invalid api key");
      },
    ]);
    const out = await collectChunks(retryMiddleware(ctx, next));
    const err = firstError(out);
    expect(err).toBeDefined();
    expect(err!.errors[0]!.category).toBe("auth");
    expect(callCount).toBe(1);
  });
});
