import { describe, it, expect, beforeEach } from "vitest";
import { createHistoryProxy } from "@/core/middleware/utils";
import type { LLMResponse } from "@/core/message/index";

describe("createHistoryProxy", () => {
  describe("basic array operations", () => {
    it("supports push operation", () => {
      const history = createHistoryProxy();

      history.push({
        id: "msg-1",
        role: "user",
        content: "hello",
        createdAt: Date.now(),
        updateAt: Date.now(),
        raw: null,
      });

      expect(history.length).toBe(1);
    });

    it("supports multiple push operations", () => {
      const history = createHistoryProxy();

      history.push({
        id: "1",
        role: "user",
        content: "u1",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      });

      history.push({
        id: "2",
        role: "assistant",
        content: "a1",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      });

      expect(history.length).toBe(2);
    });
  });

  describe("_lastAStagedIndex tracking", () => {
    it("tracks last assistant message index", () => {
      const history = createHistoryProxy();

      history.push({
        id: "1",
        role: "user",
        content: "u",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      });

      history.push({
        id: "2",
        role: "assistant",
        content: "a",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      });

      expect(history._lastAssistantIndex).toBe(1);
    });

    it("updates index on new assistant message", () => {
      const history = createHistoryProxy();

      history.push({
        id: "1",
        role: "assistant",
        content: "a1",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      });

      expect(history._lastAssistantIndex).toBe(0);

      history.push({
        id: "2",
        role: "assistant",
        content: "a2",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      });

      expect(history._lastAssistantIndex).toBe(1);
    });

    it("does not update for non-assistant messages", () => {
      const history = createHistoryProxy();

      history.push({
        id: "1",
        role: "assistant",
        content: "a",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      });

      history.push({
        id: "2",
        role: "user",
        content: "u",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      });

      expect(history._lastAssistantIndex).toBe(0);
    });

    it("returns -1 when no assistant messages", () => {
      const history = createHistoryProxy();

      history.push({
        id: "1",
        role: "user",
        content: "u",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      });

      expect(history._lastAssistantIndex).toBe(-1);
    });
  });

  describe("lastAssistant property", () => {
    it("returns last assistant message", () => {
      const history = createHistoryProxy();

      const msg1: LLMResponse = {
        id: "1",
        role: "assistant",
        content: "first",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      };

      const msg2: LLMResponse = {
        id: "2",
        role: "assistant",
        content: "second",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      };

      history.push(msg1);
      history.push(msg2);

      expect(history.lastAssistant).toBe(msg2);
    });

    it("returns undefined when no assistant messages", () => {
      const history = createHistoryProxy();

      expect(history.lastAssistant).toBeUndefined();

      history.push({
        id: "1",
        role: "user",
        content: "u",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      });

      expect(history.lastAssistant).toBeUndefined();
    });
  });

  describe("array method access", () => {
    it("supports map", () => {
      const history = createHistoryProxy();

      history.push({
        id: "1",
        role: "user",
        content: "hello",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      });

      history.push({
        id: "2",
        role: "assistant",
        content: "world",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      });

      const contents = history.map((m) => m.content);
      expect(contents).toEqual(["hello", "world"]);
    });

    it("supports filter", () => {
      const history = createHistoryProxy();

      history.push({
        id: "1",
        role: "user",
        content: "u1",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      });

      history.push({
        id: "2",
        role: "assistant",
        content: "a1",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      });

      const assistantMsgs = history.filter((m) => m.role === "assistant");
      expect(assistantMsgs).toHaveLength(1);
      expect(assistantMsgs[0]?.content).toBe("a1");
    });

    it("supports forEach", () => {
      const history = createHistoryProxy();
      const contents: string[] = [];

      history.push({
        id: "1",
        role: "user",
        content: "test",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      });

      history.forEach((m) => contents.push(m.content));
      expect(contents).toEqual(["test"]);
    });

    it("supports indexOf", () => {
      const history = createHistoryProxy();

      const msg: LLMResponse = {
        id: "1",
        role: "user",
        content: "test",
        createdAt: 0,
        updateAt: 0,
        raw: null,
      };

      history.push(msg);
      expect(history.indexOf(msg)).toBe(0);
    });
  });
});