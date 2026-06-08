import { describe, it, expect } from "vitest";
import Middleware, {
  checkpointMiddleware,
  senseMiddleware,
  retryMiddleware,
  chatMiddleware,
  createLoopHandler,
  defaultHandlers,
  type MiddlewareChunk,
  type StreamChunk,
  type StagedChunk,
  type SenseTriggerChunk,
  type SenseCompleteChunk,
  type ErrorChunk,
  type DoneChunk,
} from "@/agent/middleware/index.js";

describe("Middleware Index", () => {
  describe("exports", () => {
    it("should export Middleware class", () => {
      expect(Middleware).toBeDefined();
      expect(typeof Middleware).toBe("function");
    });

    it("should export checkpointMiddleware function", () => {
      expect(checkpointMiddleware).toBeDefined();
      expect(typeof checkpointMiddleware).toBe("function");
    });

    it("should export senseMiddleware function", () => {
      expect(senseMiddleware).toBeDefined();
      expect(typeof senseMiddleware).toBe("function");
    });

    it("should export retryMiddleware function", () => {
      expect(retryMiddleware).toBeDefined();
      expect(typeof retryMiddleware).toBe("function");
    });

    it("should export chatMiddleware function", () => {
      expect(chatMiddleware).toBeDefined();
      expect(typeof chatMiddleware).toBe("function");
    });

    it("should export createLoopHandler function", () => {
      expect(createLoopHandler).toBeDefined();
      expect(typeof createLoopHandler).toBe("function");
    });

    it("should export defaultHandlers array", () => {
      expect(defaultHandlers).toBeDefined();
      expect(Array.isArray(defaultHandlers)).toBe(true);
      expect(defaultHandlers.length).toBe(4);
    });
  });

  describe("defaultHandlers order", () => {
    it("should have correct middleware order: checkpoint → sense → retry → chat", () => {
      expect(defaultHandlers[0]).toBe(checkpointMiddleware);
      expect(defaultHandlers[1]).toBe(senseMiddleware);
      expect(defaultHandlers[2]).toBe(retryMiddleware);
      expect(defaultHandlers[3]).toBe(chatMiddleware);
    });

    it("should all handlers be async generator functions", () => {
      for (const handler of defaultHandlers) {
        expect(typeof handler).toBe("function");
      }
    });
  });

  describe("type exports", () => {
    it("should export MiddlewareChunk type", () => {
      const chunk: MiddlewareChunk = {
        type: "stream",
        thinkingDelta: "",
        contentDelta: "",
      };
      expect(chunk.type).toBe("stream");
    });

    it("should export StreamChunk type", () => {
      const streamChunk: StreamChunk = {
        type: "stream",
        thinkingDelta: "thinking",
        contentDelta: "content",
      };
      expect(streamChunk.type).toBe("stream");
    });

    it("should export StagedChunk type", () => {
      const stagedChunk: StagedChunk = {
        type: "staged",
        stagedType: "content_end",
        content: "staged content",
        thinking: "staged thinking",
      };
      expect(stagedChunk.type).toBe("staged");
    });

    it("should export SenseTriggerChunk type", () => {
      const triggerChunk: SenseTriggerChunk = {
        type: "sense_trigger",
        id: "test-id",
        name: "test_sense",
        arguments: "{}",
        supervisionLevel: 0,
      };
      expect(triggerChunk.type).toBe("sense_trigger");
    });

    it("should export SenseCompleteChunk type", () => {
      const completeChunk: SenseCompleteChunk = {
        type: "sense_complete",
        id: "test-id",
        name: "test_sense",
        result: "success",
      };
      expect(completeChunk.type).toBe("sense_complete");
    });

    it("should export ErrorChunk type", () => {
      const errorChunk: ErrorChunk = {
        type: "error",
        errors: [],
      };
      expect(errorChunk.type).toBe("error");
    });

    it("should export DoneChunk type", () => {
      const doneChunk: DoneChunk = {
        type: "done",
      };
      expect(doneChunk.type).toBe("done");
    });
  });

  describe("MiddlewareChunk union type", () => {
    it("should accept StreamChunk", () => {
      const chunk: MiddlewareChunk = {
        type: "stream",
        thinkingDelta: "",
        contentDelta: "",
      };
      expect(chunk).toBeDefined();
    });

    it("should accept StagedChunk", () => {
      const chunk: MiddlewareChunk = {
        type: "staged",
        stagedType: "content_end",
        content: "",
        thinking: "",
      };
      expect(chunk).toBeDefined();
    });

    it("should accept SenseTriggerChunk", () => {
      const chunk: MiddlewareChunk = {
        type: "sense_trigger",
        id: "test-id",
        name: "test_sense",
        arguments: "{}",
        supervisionLevel: 0,
      };
      expect(chunk).toBeDefined();
    });

    it("should accept SenseCompleteChunk", () => {
      const chunk: MiddlewareChunk = {
        type: "sense_complete",
        id: "test-id",
        name: "test_sense",
        result: "success",
      };
      expect(chunk).toBeDefined();
    });

    it("should accept ErrorChunk", () => {
      const chunk: MiddlewareChunk = {
        type: "error",
        errors: [],
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