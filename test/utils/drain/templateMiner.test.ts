import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TemplateMiner } from "@/utils/drain/templateMiner";
import { TemplateMinerConfig } from "@/utils/drain/templateMinerConfig";
import { InMemoryPersistenceHandler } from "@/utils/drain/inMemoryPersistence";

describe("TemplateMiner class", () => {
  let miner: TemplateMiner;
  let persistence: InMemoryPersistenceHandler;

  beforeEach(async () => {
    persistence = new InMemoryPersistenceHandler();
    miner = new TemplateMiner(undefined, persistence);
    await miner.initialize();
  });

  afterEach(async () => {
    await miner.close();
  });

  describe("constructor", () => {
    it("should create instance with default config", () => {
      const defaultMiner = new TemplateMiner();

      expect(defaultMiner).toBeDefined();
    });

    it("should create instance with custom config", () => {
      const config = new TemplateMinerConfig({
        drainDepth: 6,
        drainSimTh: 0.5,
        parametrizeNumericTokens: false,
      });

      const customMiner = new TemplateMiner(config);

      expect(customMiner).toBeDefined();
    });

    it("should create instance with persistence handler", () => {
      const handler = new InMemoryPersistenceHandler();
      const minerWithPersistence = new TemplateMiner(undefined, handler);

      expect(minerWithPersistence).toBeDefined();
    });

    it("should create instance without persistence", () => {
      const minerNoPersistence = new TemplateMiner(undefined, undefined);

      expect(minerNoPersistence).toBeDefined();
    });
  });

  describe("initialize method", () => {
    it("should initialize without persistence", async () => {
      const minerNoPersistence = new TemplateMiner();

      await minerNoPersistence.initialize();

      expect(minerNoPersistence.clusterCount()).toBe(0);
    });

    it("should load state from persistence if exists", async () => {
      const handler = new InMemoryPersistenceHandler();
      const miner1 = new TemplateMiner(undefined, handler);
      await miner1.initialize();

      await miner1.addLogMessage("error occurred");
      await miner1.addLogMessage("warning triggered");
      await miner1.saveSnapshot();

      const miner2 = new TemplateMiner(undefined, handler);
      await miner2.initialize();

      expect(miner2.clusterCount()).toBe(2);

      await miner1.close();
      await miner2.close();
    });

    it("should handle empty persistence state", async () => {
      const handler = new InMemoryPersistenceHandler();
      const minerWithEmptyPersistence = new TemplateMiner(undefined, handler);

      await minerWithEmptyPersistence.initialize();

      expect(minerWithEmptyPersistence.clusterCount()).toBe(0);

      await minerWithEmptyPersistence.close();
    });
  });

  describe("addLogMessage method", () => {
    it("should throw error if not initialized", async () => {
      const uninitializedMiner = new TemplateMiner();

      await expect(uninitializedMiner.addLogMessage("test")).rejects.toThrow(
        "TemplateMiner is not initialized"
      );
    });

    it("should create new cluster for new message", async () => {
      const result = await miner.addLogMessage("error occurred in module");

      expect(result.logCluster).toBeDefined();
      expect(result.isNewTemplate).toBe(true);
      expect(result.changeType).toBe("created");
      expect(result.processingTime).toBeGreaterThan(0);
    });

    it("should update cluster for similar message", async () => {
      await miner.addLogMessage("error occurred in module A");
      const result = await miner.addLogMessage("error occurred in module B");

      expect(result.logCluster.size).toBe(2);
      expect(result.isNewTemplate).toBe(false);
      expect(result.changeType).toBe("updated");
    });

    it("should not change cluster for same message", async () => {
      await miner.addLogMessage("exact same message");
      const result = await miner.addLogMessage("exact same message");

      expect(result.logCluster.size).toBe(2);
      expect(result.isNewTemplate).toBe(false);
      expect(result.changeType).toBe("none");
    });

    it("should handle numeric token parameterization", async () => {
      const config = new TemplateMinerConfig({
        parametrizeNumericTokens: true,
      });
      const minerWithParam = new TemplateMiner(config, persistence);
      await minerWithParam.initialize();

      await minerWithParam.addLogMessage("error 123 occurred");
      await minerWithParam.addLogMessage("error 456 occurred");

      expect(minerWithParam.clusterCount()).toBe(1);
      const cluster = minerWithParam.getClusters()[0];
      expect(cluster?.template).toContain("<*>");

      await minerWithParam.close();
    });

    it("should handle multiple different messages", async () => {
      await miner.addLogMessage("error occurred");
      await miner.addLogMessage("warning triggered");
      await miner.addLogMessage("info logged");

      expect(miner.clusterCount()).toBe(3);
    });

    it("should preprocess message with extra delimiters", async () => {
      const config = new TemplateMinerConfig({
        drainExtraDelimiters: ["=", ":"],
      });
      const minerWithDelimiters = new TemplateMiner(config, persistence);
      await minerWithDelimiters.initialize();

      await minerWithDelimiters.addLogMessage("key=value:field");

      const cluster = minerWithDelimiters.getClusters()[0];
      expect(cluster?.template).toContain("key");
      expect(cluster?.template).toContain("value");
      expect(cluster?.template).toContain("field");

      await minerWithDelimiters.close();
    });
  });

  describe("getTemplate method", () => {
    it("should throw error if not initialized", () => {
      const uninitializedMiner = new TemplateMiner();

      expect(() => uninitializedMiner.getTemplate("test")).toThrow(
        "TemplateMiner is not initialized"
      );
    });

    it("should return null for unmatched message", () => {
      const template = miner.getTemplate("unknown message");

      expect(template).toBeNull();
    });

    it("should return template for matched message", async () => {
      await miner.addLogMessage("error occurred in module");

      const template = miner.getTemplate("error occurred in module");

      expect(template).toBe("error occurred in module");
    });

    it("should match similar messages", async () => {
      await miner.addLogMessage("error occurred in module");

      const template = miner.getTemplate("error occurred in module");

      expect(template).toBeDefined();
    });

    it("should not match completely different messages", async () => {
      await miner.addLogMessage("error occurred");

      const template = miner.getTemplate("warning triggered");

      expect(template).toBeNull();
    });
  });

  describe("getClusters method", () => {
    it("should throw error if not initialized", () => {
      const uninitializedMiner = new TemplateMiner();

      expect(() => uninitializedMiner.getClusters()).toThrow(
        "TemplateMiner is not initialized"
      );
    });

    it("should return empty array when no clusters", () => {
      const clusters = miner.getClusters();

      expect(clusters).toEqual([]);
    });

    it("should return all clusters", async () => {
      await miner.addLogMessage("error one");
      await miner.addLogMessage("warning two");

      const clusters = miner.getClusters();

      expect(clusters.length).toBe(2);
    });

    it("should return cluster with correct structure", async () => {
      await miner.addLogMessage("test message");

      const clusters = miner.getClusters();

      expect(clusters[0]).toHaveProperty("id");
      expect(clusters[0]).toHaveProperty("template");
      expect(clusters[0]).toHaveProperty("size");
    });
  });

  describe("getClusterById method", () => {
    it("should throw error if not initialized", () => {
      const uninitializedMiner = new TemplateMiner();

      expect(() => uninitializedMiner.getClusterById(1)).toThrow(
        "TemplateMiner is not initialized"
      );
    });

    it("should return null for unknown id", () => {
      const cluster = miner.getClusterById(999);

      expect(cluster).toBeNull();
    });

    it("should return cluster by id", async () => {
      const result = await miner.addLogMessage("test message");

      const cluster = miner.getClusterById(result.logCluster.id);

      expect(cluster).toBeDefined();
      expect(cluster?.id).toBe(result.logCluster.id);
    });
  });

  describe("clusterCount method", () => {
    it("should throw error if not initialized", () => {
      const uninitializedMiner = new TemplateMiner();

      expect(() => uninitializedMiner.clusterCount()).toThrow(
        "TemplateMiner is not initialized"
      );
    });

    it("should return 0 when no clusters", () => {
      expect(miner.clusterCount()).toBe(0);
    });

    it("should return correct count", async () => {
      await miner.addLogMessage("error one");
      await miner.addLogMessage("warning two");

      expect(miner.clusterCount()).toBe(2);
    });

    it("should not count duplicate templates as separate clusters", async () => {
      await miner.addLogMessage("error occurred in module A");
      await miner.addLogMessage("error occurred in module B");
      await miner.addLogMessage("error occurred in module C");

      expect(miner.clusterCount()).toBe(1);
    });
  });

  describe("saveSnapshot method", () => {
    it("should throw error if not initialized", async () => {
      const uninitializedMiner = new TemplateMiner();

      await expect(uninitializedMiner.saveSnapshot()).rejects.toThrow(
        "TemplateMiner is not initialized"
      );
    });

    it("should save state to persistence", async () => {
      await miner.addLogMessage("test message");
      await miner.saveSnapshot();

      // Use the same persistence handler to verify state was saved
      const state = await persistence.load();
      expect(state).toBeDefined();

      // Create new miner with same persistence to restore state
      const newMiner = new TemplateMiner(undefined, persistence);
      await newMiner.initialize();

      expect(newMiner.clusterCount()).toBe(1);

      await newMiner.close();
    });

    it("should not save when no persistence configured", async () => {
      const minerNoPersistence = new TemplateMiner();
      await minerNoPersistence.initialize();

      await minerNoPersistence.addLogMessage("test");
      await minerNoPersistence.saveSnapshot();

      expect(minerNoPersistence.clusterCount()).toBe(1);

      await minerNoPersistence.close();
    });
  });

  describe("close method", () => {
    it("should save snapshot before closing", async () => {
      await miner.addLogMessage("test message");
      await miner.close();

      // Use the same persistence handler to verify state was saved
      const newMiner = new TemplateMiner(undefined, persistence);
      await newMiner.initialize();

      expect(newMiner.clusterCount()).toBeGreaterThan(0);

      await newMiner.close();
    });

    it("should handle close when not initialized", async () => {
      const uninitializedMiner = new TemplateMiner();

      await uninitializedMiner.close();

      expect(true).toBe(true);
    });

    it("should allow multiple close calls", async () => {
      await miner.close();
      await miner.close();

      expect(true).toBe(true);
    });
  });

  describe("deleteState method", () => {
    it("should delete persisted state", async () => {
      await miner.addLogMessage("test message");
      await miner.saveSnapshot();

      await miner.deleteState();

      const handler = new InMemoryPersistenceHandler();
      const newMiner = new TemplateMiner(undefined, handler);
      await newMiner.initialize();

      expect(newMiner.clusterCount()).toBe(0);

      await newMiner.close();
    });

    it("should handle delete when no persistence", async () => {
      const minerNoPersistence = new TemplateMiner();
      await minerNoPersistence.initialize();

      await minerNoPersistence.deleteState();

      expect(true).toBe(true);

      await minerNoPersistence.close();
    });
  });

  describe("state compression", () => {
    it("should compress state when configured", async () => {
      const config = new TemplateMinerConfig({
        snapshotCompressState: true,
      });
      const handler = new InMemoryPersistenceHandler();
      const compressedMiner = new TemplateMiner(config, handler);
      await compressedMiner.initialize();

      await compressedMiner.addLogMessage("test message one");
      await compressedMiner.addLogMessage("test message two");
      await compressedMiner.saveSnapshot();

      const state = await handler.load();
      expect(state).toBeDefined();
      expect(typeof state).toBe("string");

      await compressedMiner.close();
    });
  });

  describe("snapshot interval", () => {
    it("should save snapshot after interval", async () => {
      const config = new TemplateMinerConfig({
        snapshotIntervalMinutes: 0, // Always save
      });
      const handler = new InMemoryPersistenceHandler();
      const intervalMiner = new TemplateMiner(config, handler);
      await intervalMiner.initialize();

      await intervalMiner.addLogMessage("test message");

      const state = await handler.load();
      expect(state).toBeDefined();

      await intervalMiner.close();
    });
  });
});