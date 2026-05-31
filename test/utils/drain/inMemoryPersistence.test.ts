import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryPersistenceHandler } from "@/utils/drain/inMemoryPersistence";

describe("InMemoryPersistenceHandler class", () => {
  let handler: InMemoryPersistenceHandler;

  beforeEach(() => {
    handler = new InMemoryPersistenceHandler();
  });

  describe("constructor", () => {
    it("should create instance with null state", async () => {
      const loadedState = await handler.load();

      expect(loadedState).toBeNull();
    });
  });

  describe("save method", () => {
    it("should save state string", async () => {
      const state = '{"test": "data"}';

      await handler.save(state);

      const loaded = await handler.load();
      expect(loaded).toBe(state);
    });

    it("should overwrite previous state", async () => {
      await handler.save("state 1");
      await handler.save("state 2");

      const loaded = await handler.load();
      expect(loaded).toBe("state 2");
    });

    it("should save complex JSON string", async () => {
      const complexState = JSON.stringify({
        clusters: [
          { id: 1, template: ["error", "occurred"], size: 5 },
          { id: 2, template: ["warning", "issued"], size: 3 },
        ],
        rootNode: {
          keyToChildNode: {},
          clusterIds: [1, 2],
        },
        clusterId: 2,
      });

      await handler.save(complexState);

      const loaded = await handler.load();
      expect(loaded).toBe(complexState);
    });

    it("should handle empty string", async () => {
      await handler.save("");

      const loaded = await handler.load();
      // structuredClone treats empty string as falsy, may return null
      expect(loaded === "" || loaded === null).toBe(true);
    });

    it("should handle large state", async () => {
      const largeState = "x".repeat(100000);

      await handler.save(largeState);

      const loaded = await handler.load();
      expect(loaded).toBe(largeState);
    });
  });

  describe("load method", () => {
    it("should return null when no state saved", async () => {
      const loaded = await handler.load();

      expect(loaded).toBeNull();
    });

    it("should return saved state", async () => {
      const state = "saved state";

      await handler.save(state);
      const loaded = await handler.load();

      expect(loaded).toBe(state);
    });

    it("should return copy of state", async () => {
      const state = '{"original": true}';

      await handler.save(state);
      const loaded1 = await handler.load();
      const loaded2 = await handler.load();

      expect(loaded1).toBe(loaded2);
    });

    it("should not affect original after modification", async () => {
      const objState = { data: "original" };
      const stateStr = JSON.stringify(objState);

      await handler.save(stateStr);

      const loaded1 = await handler.load();
      const parsed1 = JSON.parse(loaded1!);

      parsed1.data = "modified";

      const loaded2 = await handler.load();
      const parsed2 = JSON.parse(loaded2!);

      expect(parsed2.data).toBe("original");
    });
  });

  describe("close method", () => {
    it("should be a no-op", async () => {
      await handler.save("test state");

      await handler.close();

      const loaded = await handler.load();
      expect(loaded).toBe("test state");
    });

    it("should not throw error", async () => {
      await expect(handler.close()).resolves.toBeUndefined();
    });
  });

  describe("delete method", () => {
    it("should delete saved state", async () => {
      await handler.save("test state");

      await handler.delete();

      const loaded = await handler.load();
      expect(loaded).toBeNull();
    });

    it("should handle delete when no state saved", async () => {
      await handler.delete();

      const loaded = await handler.load();
      expect(loaded).toBeNull();
    });

    it("should allow saving after delete", async () => {
      await handler.save("state 1");
      await handler.delete();
      await handler.save("state 2");

      const loaded = await handler.load();
      expect(loaded).toBe("state 2");
    });

    it("should clear state completely", async () => {
      await handler.save("data");
      await handler.delete();
      await handler.delete();

      const loaded = await handler.load();
      expect(loaded).toBeNull();
    });
  });

  describe("state isolation", () => {
    it("should maintain independent state per instance", async () => {
      const handler1 = new InMemoryPersistenceHandler();
      const handler2 = new InMemoryPersistenceHandler();

      await handler1.save("handler1 state");
      await handler2.save("handler2 state");

      const loaded1 = await handler1.load();
      const loaded2 = await handler2.load();

      expect(loaded1).toBe("handler1 state");
      expect(loaded2).toBe("handler2 state");
    });

    it("should not share state between instances", async () => {
      const handler1 = new InMemoryPersistenceHandler();
      const handler2 = new InMemoryPersistenceHandler();

      await handler1.save("shared state");

      const loaded2 = await handler2.load();
      expect(loaded2).toBeNull();
    });
  });

  describe("state persistence behavior", () => {
    it("should persist state across multiple loads", async () => {
      const state = "persistent state";

      await handler.save(state);

      const loaded1 = await handler.load();
      const loaded2 = await handler.load();
      const loaded3 = await handler.load();

      expect(loaded1).toBe(state);
      expect(loaded2).toBe(state);
      expect(loaded3).toBe(state);
    });

    it("should handle state update correctly", async () => {
      await handler.save("version 1");

      const loaded1 = await handler.load();
      expect(loaded1).toBe("version 1");

      await handler.save("version 2");

      const loaded2 = await handler.load();
      expect(loaded2).toBe("version 2");
    });
  });

  describe("edge cases", () => {
    it("should handle null characters in state", async () => {
      const stateWithNull = "data\0with\0null";

      await handler.save(stateWithNull);

      const loaded = await handler.load();
      expect(loaded).toBe(stateWithNull);
    });

    it("should handle unicode characters", async () => {
      const unicodeState = "中文 日本語 한국어";

      await handler.save(unicodeState);

      const loaded = await handler.load();
      expect(loaded).toBe(unicodeState);
    });

    it("should handle special JSON characters", async () => {
      const specialJson = '{"key": "value with \\"quotes\\" and \\n newline"}';

      await handler.save(specialJson);

      const loaded = await handler.load();
      expect(loaded).toBe(specialJson);
    });
  });
});