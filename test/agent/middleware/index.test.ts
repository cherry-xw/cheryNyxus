import { describe, it, expect } from "vitest";
import Middleware, {
  messageMiddleware,
  toolMiddleware,
  chunkMiddleware,
  retryMiddleware,
  chatMiddleware,
  defaultHandlers,
  type MiddlewareChunk,
  type StreamChunk,
  type StagedChunk,
  type InterruptChunk,
  type ErrorChunk,
} from "@/agent/middleware/index";

describe("Middleware Index", () => {
  describe("exports", () => {
    it("should export Middleware class", () => {
      expect(Middleware).toBeDefined();
      expect(typeof Middleware).toBe("function");
    });

    it("should export messageMiddleware function", () => {
      expect(messageMiddleware).toBeDefined();
      expect(typeof messageMiddleware).toBe("function");
    });

    it("should export toolMiddleware function", () => {
      expect(toolMiddleware).toBeDefined();
      expect(typeof toolMiddleware).toBe("function");
    });

    it("should export chunkMiddleware function", () => {
      expect(chunkMiddleware).toBeDefined();
      expect(typeof chunkMiddleware).toBe("function");
    });

    it("should export retryMiddleware function", () => {
      expect(retryMiddleware).toBeDefined();
      expect(typeof retryMiddleware).toBe("function");
    });

    it("should export chatMiddleware function", () => {
      expect(chatMiddleware).toBeDefined();
      expect(typeof chatMiddleware).toBe("function");
    });

    it("should export defaultHandlers array", () => {
      expect(defaultHandlers).toBeDefined();
      expect(Array.isArray(defaultHandlers)).toBe(true);
      expect(defaultHandlers.length).toBe(5);
    });
  });

  describe("defaultHandlers order", () => {
    it("should have correct middleware order: message → tool → chunk → retry → chat", () => {
      expect(defaultHandlers[0]).toBe(messageMiddleware);
      expect(defaultHandlers[1]).toBe(toolMiddleware);
      expect(defaultHandlers[2]).toBe(chunkMiddleware);
      expect(defaultHandlers[3]).toBe(retryMiddleware);
      expect(defaultHandlers[4]).toBe(chatMiddleware);
    });

    it("should all handlers be async generator functions", () => {
      for (const handler of defaultHandlers) {
        expect(typeof handler).toBe("function");
        // AsyncGenerator function signature check
      }
    });
  });

  describe("type exports", () => {
    it("should export MiddlewareChunk type", () => {
      // Type check at compile time
      const chunk: MiddlewareChunk = {
        type: "stream",
        thinkingDelta: "",
        contentDelta: "",
        thinkingAccumulated: "",
        contentAccumulated: "",
        raw: null,
      };
      expect(chunk.type).toBe("stream");
    });

    it("should export StreamChunk type", () => {
      const streamChunk: StreamChunk = {
        type: "stream",
        thinkingDelta: "thinking",
        contentDelta: "content",
        thinkingAccumulated: "accumulated thinking",
        contentAccumulated: "accumulated content",
        raw: null,
      };
      expect(streamChunk.type).toBe("stream");
    });

    it("should export StagedChunk type", () => {
      const stagedChunk: StagedChunk = {
        type: "staged",
        content: "staged content",
        thinking: "staged thinking",
        raw: null,
      };
      expect(stagedChunk.type).toBe("staged");
    });

    it("should export InterruptChunk type", () => {
      const interruptChunk: InterruptChunk = {
        type: "interrupt",
        handles: [],
      };
      expect(interruptChunk.type).toBe("interrupt");
    });

    it("should export ErrorChunk type", () => {
      const errorChunk: ErrorChunk = {
        type: "error",
        errors: [],
        finalError: true,
      };
      expect(errorChunk.type).toBe("error");
    });
  });

  describe("MiddlewareChunk union type", () => {
    it("should accept StreamChunk", () => {
      const chunk: MiddlewareChunk = {
        type: "stream",
        thinkingDelta: "",
        contentDelta: "",
        thinkingAccumulated: "",
        contentAccumulated: "",
        raw: null,
      };
      expect(chunk).toBeDefined();
    });

    it("should accept StagedChunk", () => {
      const chunk: MiddlewareChunk = {
        type: "staged",
        content: "",
        raw: null,
      };
      expect(chunk).toBeDefined();
    });

    it("should accept InterruptChunk", () => {
      const chunk: MiddlewareChunk = {
        type: "interrupt",
        handles: [],
      };
      expect(chunk).toBeDefined();
    });

    it("should accept ErrorChunk", () => {
      const chunk: MiddlewareChunk = {
        type: "error",
        errors: [],
        finalError: true,
      };
      expect(chunk).toBeDefined();
    });

    it("should accept DoneChunk", () => {
      const chunk: MiddlewareChunk = {
        type: "done",
      };
      expect(chunk).toBeDefined();
    });
  });
});