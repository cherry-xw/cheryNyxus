import { describe, it, expect, beforeEach, vi } from "vitest";
import Middleware from "@/core/middleware/index";
import type {
  MiddlewareContext,
  MiddlewareHandler,
  LoopHandler,
  RuntimeConfig,
} from "@/core/middleware/types";
import type { LLMResponse } from "@/core/message/adapter";
import { SupervisionLevel } from "@/core/config";
import type { GlobalConfig, BrainConfig } from "@/utils/config";

// MAX_USER_INPUTS（背压上限，module-private，值 16）
const MAX_USER_INPUTS = 16;

function createMockGlobal(): GlobalConfig {
  return {
    thinking: false,
    supervision: SupervisionLevel.auto,
    stream: true,
  };
}

function createMockBrain(): BrainConfig {
  return { model: "test-model", provider: "test" };
}

function createMockRuntime(): RuntimeConfig {
  return {
    brain: createMockBrain(),
    adapters: {
      llmAdapter: {} as any,
      messageAdapter: {} as any,
      senseAdapter: {} as any,
    },
    builtSenses: [],
    senseTable: new Map(),
  };
}

function msg(partial: Partial<LLMResponse> & Pick<LLMResponse, "id" | "role">): LLMResponse {
  return {
    content: "",
    createdAt: 0,
    updateAt: 0,
    ...partial,
  } as LLMResponse;
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("Middleware", () => {
  describe("exports", () => {
    it("exports Middleware class (default)", () => {
      expect(Middleware).toBeDefined();
      expect(typeof Middleware).toBe("function");
    });
  });

  describe("init", () => {
    it("binds chatId and injects initial messages", () => {
      const mw = new Middleware(createMockGlobal(), []);
      const sys = msg({ id: "sys", role: "system", content: "system prompt" });
      const chatId = mw.init("chat-1", [sys]);

      expect(chatId).toBe("chat-1");
      expect(mw.getMessages()).toHaveLength(1);
      expect(mw.getMessages()[0]).toBe(sys);
    });

    it("is idempotent (second init no-op)", () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("chat-1", [msg({ id: "m1", role: "user", content: "a" })]);
      mw.init("chat-2", [msg({ id: "m2", role: "user", content: "b" })]);

      expect(mw.getMessages()).toHaveLength(1);
      expect(mw.getMessages()[0]!.id).toBe("m1");
    });
  });

  describe("requireRuntime / requireInitialized", () => {
    it("send throws before init", async () => {
      const mw = new Middleware(createMockGlobal(), []);
      await expect(async () => {
        for await (const _ of mw.send("x")) {
          // drain
        }
      }).rejects.toThrow("Chat not initialized");
    });

    it("send throws after init but before configureRuntime", async () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("c1", []);
      await expect(async () => {
        for await (const _ of mw.send("x")) {
          // drain
        }
      }).rejects.toThrow("Runtime not fully configured");
    });
  });

  describe("configureRuntime", () => {
    it("allows send after runtime configured", async () => {
      const handler: MiddlewareHandler = async function* () {
        yield { type: "done" } as any;
      };
      const mw = new Middleware(createMockGlobal(), [handler]);
      mw.init("c1", []);
      mw.configureRuntime(createMockRuntime());

      const chunks: any[] = [];
      for await (const c of mw.send("hi")) chunks.push(c);

      expect(chunks.some((c) => c.type === "done")).toBe(true);
    });
  });

  describe("getMessages", () => {
    it("returns injected messages", () => {
      const mw = new Middleware(createMockGlobal(), []);
      const msgs = [
        msg({ id: "m1", role: "user", content: "q" }),
        msg({ id: "m2", role: "assistant", content: "a" }),
      ];
      mw.init("c1", msgs);
      expect(mw.getMessages()).toEqual(msgs);
    });

    it("returns empty array before init", () => {
      const mw = new Middleware(createMockGlobal(), []);
      expect(mw.getMessages()).toEqual([]);
    });
  });

  describe("revokeTrailingCycle", () => {
    it("returns [] for empty messages", () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("c1", []);
      expect(mw.revokeTrailingCycle()).toEqual([]);
    });

    it("returns [] when trailing message is not sense", () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("c1", [
        msg({ id: "u1", role: "user", content: "q" }),
        msg({ id: "a1", role: "assistant", content: "a", createdAt: 0, updateAt: 0 }),
      ]);
      expect(mw.revokeTrailingCycle()).toEqual([]);
    });

    it("returns [] when sense group not preceded by assistant with senseCalls", () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("c1", [
        msg({ id: "u1", role: "user", content: "q" }),
        msg({ id: "s1", role: "sense", content: "r" }),
      ]);
      expect(mw.revokeTrailingCycle()).toEqual([]);
    });

    it("revokes assistant(senseCalls) + entire trailing sense group", () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("c1", [
        msg({ id: "u1", role: "user", content: "q" }),
        msg({
          id: "a1",
          role: "assistant",
          content: "thinking...",
          senseCalls: [{ id: "sc1", name: "t", arguments: "{}" }],
        }),
        msg({ id: "s1", role: "sense", content: "" }),
        msg({ id: "s2", role: "sense", content: "done result" }),
      ]);

      const revoked = mw.revokeTrailingCycle();
      expect(revoked).toEqual(["a1", "s1", "s2"]);

      const msgs = mw.getMessages();
      expect(msgs.find((m) => m.id === "u1")!.revoked).toBeUndefined();
      expect(msgs.find((m) => m.id === "a1")!.revoked).toBe(true);
      expect(msgs.find((m) => m.id === "s1")!.revoked).toBe(true);
      expect(msgs.find((m) => m.id === "s2")!.revoked).toBe(true);
    });
  });

  describe("hasPendingTrailingSense", () => {
    it("returns false when last message is not sense", () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("c1", [
        msg({ id: "a1", role: "assistant", content: "a" }),
      ]);
      expect(mw.hasPendingTrailingSense()).toBe(false);
    });

    it("returns true when trailing sense has empty content (pending)", () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("c1", [
        msg({
          id: "a1",
          role: "assistant",
          content: "",
          senseCalls: [{ id: "sc1", name: "t", arguments: "{}" }],
        }),
        msg({ id: "s1", role: "sense", content: "" }),
      ]);
      expect(mw.hasPendingTrailingSense()).toBe(true);
    });

    it("returns false when trailing sense group all done", () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("c1", [
        msg({
          id: "a1",
          role: "assistant",
          content: "",
          senseCalls: [{ id: "sc1", name: "t", arguments: "{}" }],
        }),
        msg({ id: "s1", role: "sense", content: "result" }),
      ]);
      expect(mw.hasPendingTrailingSense()).toBe(false);
    });

    it("stops scanning at first non-sense from the end", () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("c1", [
        msg({ id: "s0", role: "sense", content: "" }), // not trailing → ignored
        msg({ id: "a1", role: "assistant", content: "a" }),
        msg({ id: "s1", role: "sense", content: "done" }),
      ]);
      expect(mw.hasPendingTrailingSense()).toBe(false);
    });
  });

  describe("setResumePending", () => {
    it("does not throw and does not affect requireRuntime", () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("c1", []);
      expect(() => mw.setResumePending(true)).not.toThrow();
      expect(() => mw.setResumePending(false)).not.toThrow();
    });
  });

  describe("isRunning", () => {
    it("is false initially", () => {
      const mw = new Middleware(createMockGlobal(), []);
      expect(mw.isRunning()).toBe(false);
    });

    it("reflects loop state during send", async () => {
      let release!: () => void;
      const hang = new Promise<void>((r) => {
        release = r;
      });
      const handler: MiddlewareHandler = async function* () {
        await hang;
        yield { type: "done" } as any;
      };
      const mw = new Middleware(createMockGlobal(), [handler]);
      mw.init("c1", []);
      mw.configureRuntime(createMockRuntime());

      expect(mw.isRunning()).toBe(false);

      const gen = mw.send("x");
      const consume = (async () => {
        for await (const _ of gen) {
          // drain
        }
      })();
      await flush();
      expect(mw.isRunning()).toBe(true);

      release();
      await consume;
      expect(mw.isRunning()).toBe(false);
    });
  });

  describe("send (input queue + execution)", () => {
    it("does not enqueue empty/whitespace input", async () => {
      let captured: any;
      const handler: MiddlewareHandler = async function* (ctx) {
        captured = ctx.soul.userInputs;
        yield { type: "done" } as any;
      };
      const mw = new Middleware(createMockGlobal(), [handler]);
      mw.init("c1", []);
      mw.configureRuntime(createMockRuntime());

      for await (const _ of mw.send("   ")) {
        // drain
      }

      expect(captured).toHaveLength(0);
    });

    it("enqueues trimmed non-empty input", async () => {
      let captured: any;
      const handler: MiddlewareHandler = async function* (ctx) {
        captured = ctx.soul.userInputs;
        yield { type: "done" } as any;
      };
      const mw = new Middleware(createMockGlobal(), [handler]);
      mw.init("c1", []);
      mw.configureRuntime(createMockRuntime());

      for await (const _ of mw.send("  hello  ")) {
        // drain
      }

      expect(captured).toHaveLength(1);
      expect(captured[0].content).toBe("hello");
    });

    it("back-pressure: drops oldest beyond MAX_USER_INPUTS", async () => {
      let captured: any;
      let release!: () => void;
      const hang = new Promise<void>((r) => {
        release = r;
      });
      const handler: MiddlewareHandler = async function* (ctx) {
        captured = ctx.soul.userInputs;
        await hang;
        yield { type: "done" } as any;
      };
      const mw = new Middleware(createMockGlobal(), [handler]);
      mw.init("c1", []);
      mw.configureRuntime(createMockRuntime());

      // 启动 loop（挂起在 hang，isRunning 保持 true）
      const gen = mw.send("seed");
      const consume = (async () => {
        for await (const _ of gen) {
          // drain
        }
      })();
      await flush();

      // loop 运行中：后续 send 只入队
      for (let i = 0; i < 20; i++) {
        for await (const _ of mw.send(`u${i}`)) {
          // drain (empty: isRunning → return)
        }
      }

      expect(captured.length).toBeLessThanOrEqual(MAX_USER_INPUTS);

      release();
      await consume;
    });
  });

  describe("abort", () => {
    it("does not throw when no generator running", () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("c1", []);
      expect(() => mw.abort()).not.toThrow();
    });
  });

  describe("isSenseTableStale", () => {
    it("returns false when registry version unchanged", () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("c1", []);
      mw.configureRuntime(createMockRuntime());
      expect(mw.isSenseTableStale()).toBe(false);
    });
  });

  describe("appendRoleReply", () => {
    it("appends role reply and returns message id", () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("c1", []);
      const id = mw.appendRoleReply("role response");
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
      const msgs = mw.getMessages();
      const last = msgs[msgs.length - 1];
      expect(last).toBeDefined();
      expect(last!.content).toBe("role response");
    });
  });

  describe("completeSenseResult", () => {
    it("returns false when sense message does not exist", () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("c1", []);
      const result = mw.completeSenseResult("nonexistent", "updated content");
      expect(result).toBe(false);
    });

    it("returns true when sense message exists and is updated in-place", () => {
      const mw = new Middleware(createMockGlobal(), []);
      mw.init("c1", [
        msg({ id: "s1", role: "sense", content: "" }),
      ]);
      const result = mw.completeSenseResult("s1", "filled result");
      expect(result).toBe(true);
      const msgs = mw.getMessages();
      const sense = msgs.find((m) => m.id === "s1");
      expect(sense!.content).toBe("filled result");
    });
  });

  describe("send with extraUserMessages", () => {
    it("enqueues extra messages before main input", async () => {
      const captured: string[] = [];
      const handler: MiddlewareHandler = async function* (ctx) {
        for (const ui of ctx.soul.userInputs) {
          captured.push(ui.content);
        }
        yield { type: "done" } as any;
      };
      const mw = new Middleware(createMockGlobal(), [handler]);
      mw.init("c1", []);
      mw.configureRuntime(createMockRuntime());

      for await (const _ of mw.send("main input", { extraUserMessages: ["extra1", "extra2"] })) {
        // drain
      }

      expect(captured).toEqual(["extra1", "extra2", "main input"]);
    });
  });

  describe("send with compact command", () => {
    it("triggers compactToLatestSummary after loop", async () => {
      const handler: MiddlewareHandler = async function* (ctx) {
        ctx.soul.messages!.push(
          msg({ id: "a1", role: "assistant", content: "summary text" }),
        );
        yield { type: "done" } as any;
      };
      const mw = new Middleware(createMockGlobal(), [handler]);
      mw.init("c1", [
        msg({ id: "sys", role: "system", content: "system prompt" }),
      ]);
      mw.configureRuntime(createMockRuntime());

      for await (const _ of mw.send("[[command:/compact]]")) {
        // drain
      }

      // After compact, messages should be reduced
      const msgs = mw.getMessages();
      // compactToLatestSummary replaces history with system + compact summary
      expect(msgs.length).toBeLessThanOrEqual(2);
    });
  });

  describe("loopHandler integration", () => {
    it("loops until assistant has no senseCalls, bounded by loopHandler", async () => {
      let iterations = 0;
      const handler: MiddlewareHandler = async function* (ctx) {
        iterations++;
        if (iterations === 1) {
          ctx.soul.messages!.push(
            msg({
              id: "a1",
              role: "assistant",
              content: "c",
              senseCalls: [{ id: "sc1", name: "t", arguments: "{}" }],
            }),
          );
          yield { type: "stream" } as any;
        } else {
          ctx.soul.messages!.push(
            msg({ id: "a2", role: "assistant", content: "done" }),
          );
          yield { type: "done" } as any;
        }
      };

      const loopHandler: LoopHandler = async function* (ctx, runChain) {
        let times = 0;
        while (times < 5) {
          times++;
          yield* runChain();
          const last = ctx.soul.messages![ctx.soul.messages!.length - 1]!;
          if (last.role === "assistant" && !last.senseCalls?.length) break;
        }
      };

      const mw = new Middleware(createMockGlobal(), [handler], loopHandler);
      mw.init("c1", []);
      mw.configureRuntime(createMockRuntime());

      const chunks: any[] = [];
      for await (const c of mw.send("x")) chunks.push(c);

      expect(iterations).toBeGreaterThanOrEqual(2);
      expect(chunks.some((c) => c.type === "done")).toBe(true);
    });
  });
});
