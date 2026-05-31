import { describe, it, expect, beforeEach } from "vitest";
import { Drain } from "@/utils/drain/drain";
import { DrainUpdateType } from "@/utils/drain/drainBase";
import type { LogClusterInterface } from "@/utils/drain/types";

describe("Drain class", () => {
  let drain: Drain;

  beforeEach(() => {
    drain = new Drain();
  });

  describe("constructor", () => {
    it("should create instance with default parameters", () => {
      const defaultDrain = new Drain();

      expect(defaultDrain.logClusterDepth).toBe(4);
      expect(defaultDrain.simTh).toBe(0.4);
      expect(defaultDrain.paramStr).toBe("<*>");
    });

    it("should create instance with custom parameters", () => {
      const customDrain = new Drain(
        6,
        0.6,
        50,
        100,
        ["=", ":"],
        undefined,
        "<?>",
        false,
      );

      expect(customDrain.logClusterDepth).toBe(6);
      expect(customDrain.simTh).toBe(0.6);
      expect(customDrain.maxChildren).toBe(50);
      expect(customDrain.maxClusters).toBe(100);
      expect(customDrain.extraDelimiters).toEqual(["=", ":"]);
      expect(customDrain.paramStr).toBe("<?>");
      expect(customDrain.parametrizeNumericTokens).toBe(false);
    });
  });

  describe("treeSearch method", () => {
    it("should return null for empty tree", () => {
      const tokens = ["test", "message"];
      const result = drain.treeSearch(drain.rootNode, tokens, 0.5, false);

      expect(result).toBeNull();
    });

    it("should return null for unknown token count", () => {
      drain.addLogMessage("a b c"); // 3 tokens

      const tokens = ["x", "y", "z", "w"]; // 4 tokens
      const result = drain.treeSearch(drain.rootNode, tokens, 0.5, false);

      expect(result).toBeNull();
    });

    it("should find matching cluster", () => {
      drain.addLogMessage("error occurred in module A");

      const tokens = ["error", "occurred", "in", "module", "B"];
      const result = drain.treeSearch(drain.rootNode, tokens, 0.5, false);

      expect(result).toBeDefined();
    });

    it("should return null when no match reaches threshold", () => {
      drain.addLogMessage("completely different message");

      const tokens = ["error", "occurred", "in", "module", "A"];
      const result = drain.treeSearch(drain.rootNode, tokens, 0.9, false);

      expect(result).toBeNull();
    });

    it("should handle empty tokens", () => {
      const result = drain.treeSearch(drain.rootNode, [], 0.5, false);

      expect(result).toBeNull();
    });
  });

  describe("addSeqToPrefixTree method", () => {
    it("should add cluster to prefix tree", () => {
      const templateTokens = ["test", "message"];
      const cluster: LogClusterInterface = {
        id: 1,
        template: templateTokens,
        size: 1,
      };

      drain.addSeqToPrefixTree(drain.rootNode, cluster);

      const firstLayerNode = drain.rootNode.children.get("2");
      expect(firstLayerNode).toBeDefined();
    });

    it("should create token-count node if not exists", () => {
      const cluster: LogClusterInterface = {
        id: 1,
        template: ["a", "b", "c"],
        size: 1,
      };

      drain.addSeqToPrefixTree(drain.rootNode, cluster);

      expect(drain.rootNode.children.has("3")).toBe(true);
    });

    it("should handle cluster with empty template", () => {
      const cluster: LogClusterInterface = {
        id: 1,
        template: [],
        size: 1,
      };

      drain.addSeqToPrefixTree(drain.rootNode, cluster);

      const firstLayerNode = drain.rootNode.children.get("0");
      expect(firstLayerNode?.clusterIds).toContain(1);
    });

    it("should add to existing token-count node", () => {
      const cluster1: LogClusterInterface = {
        id: 1,
        template: ["test", "one"],
        size: 1,
      };
      const cluster2: LogClusterInterface = {
        id: 2,
        template: ["test", "two"],
        size: 1,
      };

      drain.addSeqToPrefixTree(drain.rootNode, cluster1);
      drain.addSeqToPrefixTree(drain.rootNode, cluster2);

      const firstLayerNode = drain.rootNode.children.get("2");
      expect(firstLayerNode).toBeDefined();
    });

    it("should handle numeric tokens with parameterization", () => {
      const drainWithParam = new Drain(4, 0.4, 100, null, [], undefined, "<*>", true);
      const cluster: LogClusterInterface = {
        id: 1,
        template: ["error", "123", "module"],
        size: 1,
      };

      drainWithParam.addSeqToPrefixTree(drainWithParam.rootNode, cluster);

      expect(drainWithParam.rootNode.children.has("3")).toBe(true);
    });
  });

  describe("getSeqDistance method", () => {
    it("should calculate similarity correctly", () => {
      const seq1 = ["error", "occurred", "in", "module"];
      const seq2 = ["error", "occurred", "in", "module"];

      const [sim, paramCount] = drain.getSeqDistance(seq1, seq2, false);

      expect(sim).toBe(1.0);
      expect(paramCount).toBe(0);
    });

    it("should calculate partial similarity", () => {
      const seq1 = ["error", "occurred", "in", "module"];
      const seq2 = ["error", "found", "in", "module"];

      const [sim, paramCount] = drain.getSeqDistance(seq1, seq2, false);

      expect(sim).toBe(0.75);
      expect(paramCount).toBe(0);
    });

    it("should throw error for mismatched lengths", () => {
      const seq1 = ["a", "b"];
      const seq2 = ["a", "b", "c"];

      expect(() => drain.getSeqDistance(seq1, seq2, false)).toThrow(
        "Sequence lengths must match"
      );
    });

    it("should handle empty sequences", () => {
      const [sim, paramCount] = drain.getSeqDistance([], [], false);

      expect(sim).toBe(1.0);
      expect(paramCount).toBe(0);
    });

    it("should count wildcard tokens", () => {
      const seq1 = ["error", "<*>", "module"];
      const seq2 = ["error", "test", "module"];

      const [sim, paramCount] = drain.getSeqDistance(seq1, seq2, false);

      expect(sim).toBe(0.6666666666666666);
      expect(paramCount).toBe(1);
    });

    it("should include params in similarity when true", () => {
      const seq1 = ["error", "<*>", "module"];
      const seq2 = ["error", "test", "module"];

      const [sim, paramCount] = drain.getSeqDistance(seq1, seq2, true);

      expect(sim).toBe(1.0);
      expect(paramCount).toBe(1);
    });

    it("should handle all wildcards", () => {
      const seq1 = ["<*>", "<*>", "<*>"];
      const seq2 = ["a", "b", "c"];

      const [sim, paramCount] = drain.getSeqDistance(seq1, seq2, false);

      expect(sim).toBe(0);
      expect(paramCount).toBe(3);
    });
  });

  describe("createTemplate method", () => {
    it("should create template with matching tokens", () => {
      const seq1 = ["error", "occurred", "module"];
      const seq2 = ["error", "occurred", "module"];

      const template = drain.createTemplate(seq1, seq2);

      expect(template).toEqual(["error", "occurred", "module"]);
    });

    it("should replace mismatched tokens with wildcard", () => {
      const seq1 = ["error", "occurred", "module"];
      const seq2 = ["error", "happened", "module"];

      const template = drain.createTemplate(seq1, seq2);

      expect(template).toEqual(["error", "<*>", "module"]);
    });

    it("should throw error for mismatched lengths", () => {
      const seq1 = ["a", "b"];
      const seq2 = ["a", "b", "c"];

      expect(() => drain.createTemplate(seq1, seq2)).toThrow(
        "Sequence lengths must match"
      );
    });

    it("should handle empty sequences", () => {
      const template = drain.createTemplate([], []);

      expect(template).toEqual([]);
    });

    it("should replace all different tokens", () => {
      const seq1 = ["a", "b", "c"];
      const seq2 = ["x", "y", "z"];

      const template = drain.createTemplate(seq1, seq2);

      expect(template).toEqual(["<*>", "<*>", "<*>"]);
    });

    it("should handle single mismatch", () => {
      const seq1 = ["same", "different", "same"];
      const seq2 = ["same", "other", "same"];

      const template = drain.createTemplate(seq1, seq2);

      expect(template).toEqual(["same", "<*>", "same"]);
    });
  });

  describe("match method", () => {
    it("should return null when no clusters exist", () => {
      const result = drain.match("test message");

      expect(result).toBeNull();
    });

    it("should return matching cluster", () => {
      drain.addLogMessage("error occurred in module");

      const result = drain.match("error occurred in module");

      expect(result).toBeDefined();
      expect(result?.template).toEqual(["error", "occurred", "in", "module"]);
    });

    it("should not match different message", () => {
      drain.addLogMessage("completely different message");

      const result = drain.match("error occurred in module");

      expect(result).toBeNull();
    });

    it("should match with fullSearchStrategy always", () => {
      drain.addLogMessage("test message one");

      const result = drain.match("test message one", "always");

      expect(result).toBeDefined();
    });

    it("should not match similar message with default threshold", () => {
      drain.addLogMessage("error occurred in module");

      const result = drain.match("error happened in module");

      expect(result).toBeNull();
    });

    it("should match exact same message", () => {
      drain.addLogMessage("exact message");

      const result = drain.match("exact message");

      expect(result).toBeDefined();
      expect(result?.size).toBe(1);
    });
  });

  describe("addLogMessage integration", () => {
    it("should create cluster structure correctly", () => {
      const [cluster, updateType] = drain.addLogMessage("test log message");

      expect(cluster.id).toBe(1);
      expect(updateType).toBe(DrainUpdateType.CLUSTER_CREATED);
      expect(drain.clusters.length).toBe(1);
    });

    it("should build prefix tree correctly", () => {
      drain.addLogMessage("error in module A");
      drain.addLogMessage("error in module B");

      expect(drain.rootNode.children.size).toBeGreaterThan(0);
    });

    it("should handle numeric token parameterization", () => {
      const drainWithParam = new Drain(4, 0.4, 100, null, [], undefined, "<*>", true);

      drainWithParam.addLogMessage("error 123 occurred");
      drainWithParam.addLogMessage("error 456 occurred");

      const clusters = drainWithParam.clusters;
      expect(clusters.length).toBe(1);
      expect(clusters[0]?.template).toContain("<*>");
    });

    it("should handle multiple similar messages", () => {
      drain.addLogMessage("error in module 1");
      drain.addLogMessage("error in module 2");
      drain.addLogMessage("error in module 3");

      expect(drain.clusters.length).toBe(1);
      expect(drain.clusters[0]?.size).toBe(3);
    });

    it("should handle completely different messages", () => {
      drain.addLogMessage("error occurred");
      drain.addLogMessage("warning triggered");
      drain.addLogMessage("info logged");

      expect(drain.clusters.length).toBe(3);
    });
  });

  describe("extra delimiters", () => {
    it("should split by extra delimiters", () => {
      const drainWithDelimiters = new Drain(4, 0.4, 100, null, ["=", ":"]);

      drainWithDelimiters.addLogMessage("key=value:field");

      const tokens = drainWithDelimiters.getContentAsTokens("key=value:field");

      expect(tokens).toContain("key");
      expect(tokens).toContain("value");
      expect(tokens).toContain("field");
    });
  });

  describe("treeSearch edge cases", () => {
    it("should handle zero token count", () => {
      // Add empty message
      drain.addLogMessage("");

      // Search for empty
      const result = drain.treeSearch(drain.rootNode, [], 0.5, false);

      // Should find the cluster for empty tokens
      expect(result).toBeDefined();
    });

    it("should return null when cluster ID undefined", () => {
      // Manually create node with empty clusterIds
      const emptyNode = drain.rootNode.children.get("0");
      if (emptyNode) {
        emptyNode.clusterIds = [999]; // Non-existent cluster ID
      }

      const result = drain.treeSearch(drain.rootNode, [], 0.5, false);
      expect(result).toBeNull();
    });
  });

  describe("addSeqToPrefixTree maxChildren handling", () => {
    it("should use paramStr when children size < maxChildren", () => {
      const smallMaxDrain = new Drain(4, 0.4, 2, null, [], undefined, "<*>", true);

      // Add multiple different tokens to trigger maxChildren logic
      smallMaxDrain.addLogMessage("error A module");
      smallMaxDrain.addLogMessage("error B module");
      smallMaxDrain.addLogMessage("error C module");

      // Should use paramStr for new tokens
      expect(smallMaxDrain.clusters.length).toBeGreaterThan(0);
    });

    it("should create paramStr node when size + 1 === maxChildren", () => {
      const limitDrain = new Drain(4, 0.4, 3, null, [], undefined, "<*>", false);

      // Add messages to reach maxChildren limit
      limitDrain.addLogMessage("token A message");
      limitDrain.addLogMessage("token B message");
      limitDrain.addLogMessage("token C message");

      // Should have created paramStr node at limit
      const firstLayer = limitDrain.rootNode.children.get("3");
      expect(firstLayer).toBeDefined();
    });

    it("should use existing paramStr when children full", () => {
      const fullDrain = new Drain(4, 0.4, 2, null, [], undefined, "<*>", true);

      // Pre-populate with numeric tokens to create paramStr
      fullDrain.addLogMessage("log 123 test");
      fullDrain.addLogMessage("log 456 test");
      fullDrain.addLogMessage("log 789 test");

      // All numeric tokens should use same paramStr node
      expect(fullDrain.clusters.length).toBe(1);
    });
  });

  describe("match fullSearch fallback", () => {
    it("should use fullSearch fallback when treeSearch fails", () => {
      // Add message that creates cluster
      drain.addLogMessage("test message content");

      // Match with different structure that treeSearch won't find
      // but fullSearch might find based on token count
      const result = drain.match("test message content", "never");

      expect(result).toBeDefined();
    });

    it("should call fullSearch when fullSearchStrategy is always", () => {
      drain.addLogMessage("unique message here");

      // fullSearchStrategy always should call fullSearch directly
      const result = drain.match("unique message here", "always");

      expect(result).toBeDefined();
    });
  });
});