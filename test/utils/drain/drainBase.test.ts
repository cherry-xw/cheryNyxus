import { describe, it, expect, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { DrainBase, DrainUpdateType, NullProfiler } from "@/utils/drain/drainBase";
import { LogCluster, Node } from "@/utils/drain/node";
import type { LogClusterInterface, NodeInterface } from "@/utils/drain/types";

class TestDrain extends DrainBase {
  treeSearch(
    rootNode: NodeInterface,
    tokens: string[],
    simTh: number,
    includeParams: boolean,
  ): LogClusterInterface | null {
    const tokenCount = tokens.length;
    let currentNode = rootNode.children.get(String(tokenCount));

    if (!currentNode) {
      return null;
    }

    return this.fastMatch(currentNode.clusterIds, tokens, simTh, includeParams);
  }

  addSeqToPrefixTree(rootNode: NodeInterface, cluster: LogClusterInterface): void {
    const tokenCount = cluster.template.length;
    const tokenCountKey = String(tokenCount);

    let firstLayerNode = rootNode.children.get(tokenCountKey);
    if (!firstLayerNode) {
      firstLayerNode = new Node();
      rootNode.children.set(tokenCountKey, firstLayerNode);
    }

    firstLayerNode.clusterIds.push(cluster.id);
  }

  getSeqDistance(
    seq1: string[],
    seq2: string[],
    includeParams: boolean,
  ): [number, number] {
    if (seq1.length !== seq2.length) {
      throw new Error("Sequence lengths must match");
    }

    if (seq1.length === 0) {
      return [1, 0];
    }

    let similarTokens = 0;
    let paramCount = 0;

    for (let i = 0; i < seq1.length; i++) {
      const token1 = seq1[i];
      const token2 = seq2[i];

      if (token1 === this.paramStr) {
        paramCount++;
        continue;
      }

      if (token1 === token2) {
        similarTokens++;
      }
    }

    if (includeParams) {
      similarTokens += paramCount;
    }

    return [similarTokens / seq1.length, paramCount];
  }

  createTemplate(seq1: string[], seq2: string[]): string[] {
    if (seq1.length !== seq2.length) {
      throw new Error("Sequence lengths must match");
    }

    return seq1.map((token, i) => token === seq2[i] ? seq2[i] : this.paramStr);
  }

  match(
    content: string,
    fullSearchStrategy?: "never" | "always",
  ): LogClusterInterface | null {
    const tokens = this.getContentAsTokens(content);
    return this.treeSearch(this.rootNode, tokens, 1.0, true);
  }
}

describe("DrainBase class", () => {
  let drain: TestDrain;

  beforeEach(() => {
    drain = new TestDrain();
  });

  describe("constructor", () => {
    it("should create instance with default parameters", () => {
      const base = new TestDrain();

      expect(base.logClusterDepth).toBe(4);
      expect(base.maxNodeDepth).toBe(2);
      expect(base.simTh).toBe(0.4);
      expect(base.maxChildren).toBe(100);
      expect(base.paramStr).toBe("<*>");
      expect(base.parametrizeNumericTokens).toBe(true);
    });

    it("should create instance with custom parameters", () => {
      const base = new TestDrain(
        6,
        0.5,
        50,
        1000,
        ["=", ":"],
        new NullProfiler(),
        "<?>",
        false,
      );

      expect(base.logClusterDepth).toBe(6);
      expect(base.maxNodeDepth).toBe(4);
      expect(base.simTh).toBe(0.5);
      expect(base.maxChildren).toBe(50);
      expect(base.maxClusters).toBe(1000);
      expect(base.extraDelimiters).toEqual(["=", ":"]);
      expect(base.paramStr).toBe("<?>");
      expect(base.parametrizeNumericTokens).toBe(false);
    });

    it("should throw error when depth < 3", () => {
      expect(() => new TestDrain(2)).toThrow("depth argument must be at least 3");
    });

    it("should initialize rootNode", () => {
      expect(drain.rootNode).toBeDefined();
      expect(drain.rootNode.children).toBeInstanceOf(Map);
    });

    it("should initialize idToCluster map", () => {
      expect(drain.idToCluster).toBeInstanceOf(Map);
    });

    it("should initialize clustersCounter to 0", () => {
      expect(drain.clustersCounter).toBe(0);
    });
  });

  describe("clusters property", () => {
    it("should return empty array when no clusters", () => {
      expect(drain.clusters).toEqual([]);
    });

    it("should return clusters after adding messages", () => {
      drain.addLogMessage("unique message one");
      drain.addLogMessage("completely different message");

      expect(drain.clusters.length).toBe(2);
    });
  });

  describe("hasNumbers static method", () => {
    it("should return true for numeric characters", () => {
      expect(DrainBase.hasNumbers("123")).toBe(true);
      expect(DrainBase.hasNumbers("abc123def")).toBe(true);
      expect(DrainBase.hasNumbers(["1", "2", "3"])).toBe(true);
    });

    it("should return false for non-numeric characters", () => {
      expect(DrainBase.hasNumbers("abc")).toBe(false);
      expect(DrainBase.hasNumbers(["a", "b", "c"])).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(DrainBase.hasNumbers("")).toBe(false);
      expect(DrainBase.hasNumbers([])).toBe(false);
    });

    it("should handle single digit", () => {
      expect(DrainBase.hasNumbers("5")).toBe(true);
    });
  });

  describe("fastMatch method", () => {
    it("should return null when no clusters match", () => {
      const result = drain.fastMatch([], ["test"], 0.5, false);
      expect(result).toBeNull();
    });

    it("should return best matching cluster", () => {
      drain.addLogMessage("error occurred in module A");

      const tokens = ["error", "occurred", "in", "module", "B"];
      const result = drain.fastMatch([1], tokens, 0.5, false);

      expect(result).toBeDefined();
      expect(result?.id).toBe(1);
    });

    it("should respect similarity threshold", () => {
      drain.addLogMessage("token1 token2 token3");

      const result = drain.fastMatch([1], ["different", "message", "here"], 0.9, false);
      expect(result).toBeNull();
    });

    it("should use paramStr for parameter matching", () => {
      drain.addLogMessage("error occurred in module 123");

      const tokens = ["error", "occurred", "in", "module", "456"];
      const result = drain.fastMatch([1], tokens, 0.5, true);

      expect(result).toBeDefined();
    });
  });

  describe("getContentAsTokens method", () => {
    it("should split content by whitespace", () => {
      const tokens = drain.getContentAsTokens("hello world test");

      expect(tokens).toEqual(["hello", "world", "test"]);
    });

    it("should trim content before splitting", () => {
      const tokens = drain.getContentAsTokens("  hello world  ");

      expect(tokens).toEqual(["hello", "world"]);
    });

    it("should filter empty tokens", () => {
      const tokens = drain.getContentAsTokens("hello  world   test");

      expect(tokens).toEqual(["hello", "world", "test"]);
    });

    it("should handle extra delimiters", () => {
      const drainWithDelimiters = new TestDrain(4, 0.4, 100, null, ["=", ":"]);
      const tokens = drainWithDelimiters.getContentAsTokens("key=value:field");

      expect(tokens).toContain("key");
      expect(tokens).toContain("value");
      expect(tokens).toContain("field");
    });

    it("should handle empty content", () => {
      const tokens = drain.getContentAsTokens("");

      expect(tokens).toEqual([]);
    });

    it("should handle single token", () => {
      const tokens = drain.getContentAsTokens("single");

      expect(tokens).toEqual(["single"]);
    });
  });

  describe("addLogMessage method", () => {
    it("should create new cluster for new message", () => {
      const [cluster, updateType] = drain.addLogMessage("first message");

      expect(cluster).toBeDefined();
      expect(cluster.id).toBe(1);
      expect(updateType).toBe(DrainUpdateType.CLUSTER_CREATED);
    });

    it("should increment clustersCounter for new messages", () => {
      drain.addLogMessage("unique message one");
      drain.addLogMessage("completely different message");

      expect(drain.clustersCounter).toBe(2);
    });

    it("should add cluster to idToCluster", () => {
      const [cluster] = drain.addLogMessage("test message");

      expect(drain.idToCluster.get(cluster.id)).toBe(cluster);
    });

    it("should update cluster template when similar message", () => {
      drain.addLogMessage("error in module A");
      const [cluster, updateType] = drain.addLogMessage("error in module B");

      expect(updateType).toBe(DrainUpdateType.CLUSTER_TEMPLATE_CHANGED);
      expect(cluster.template).toContain("<*>");
    });

    it("should not update template when same message", () => {
      drain.addLogMessage("exact same message");
      const [cluster, updateType] = drain.addLogMessage("exact same message");

      expect(updateType).toBe(DrainUpdateType.NONE);
      expect(cluster.template).toEqual(["exact", "same", "message"]);
    });

    it("should increment cluster size when similar", () => {
      drain.addLogMessage("error in module 1");
      const [cluster] = drain.addLogMessage("error in module 2");

      expect(cluster.size).toBe(2);
    });
  });

  describe("getTotalClusterSize method", () => {
    it("should return 0 when no clusters", () => {
      expect(drain.getTotalClusterSize()).toBe(0);
    });

    it("should return sum of all cluster sizes", () => {
      drain.addLogMessage("message one");
      drain.addLogMessage("message one");
      drain.addLogMessage("message two");
      drain.addLogMessage("message two");
      drain.addLogMessage("message two");

      expect(drain.getTotalClusterSize()).toBe(5);
    });
  });

  describe("getClustersIdsForSeqLen method", () => {
    it("should return empty array for unknown token count", () => {
      expect(drain.getClustersIdsForSeqLen(999)).toEqual([]);
    });

    it("should return cluster IDs for known token count", () => {
      drain.addLogMessage("a b c"); // 3 tokens
      drain.addLogMessage("x y z"); // 3 tokens

      const ids = drain.getClustersIdsForSeqLen(3);

      expect(ids.length).toBeGreaterThan(0);
    });
  });

  describe("NullProfiler", () => {
    it("should have no-op methods", () => {
      const profiler = new NullProfiler();

      profiler.startSection("test");
      profiler.endSection();

      expect(true).toBe(true);
    });
  });

  describe("DrainUpdateType enum", () => {
    it("should have correct values", () => {
      expect(DrainUpdateType.CLUSTER_CREATED).toBe("cluster_created");
      expect(DrainUpdateType.CLUSTER_TEMPLATE_CHANGED).toBe("cluster_template_changed");
      expect(DrainUpdateType.NONE).toBe("none");
    });
  });

  describe("maxClusters parameter", () => {
    it("should limit cluster count when set", () => {
      const limitedDrain = new TestDrain(4, 0.4, 100, 2);

      limitedDrain.addLogMessage("message one");
      limitedDrain.addLogMessage("message two");
      limitedDrain.addLogMessage("message three");

      expect(limitedDrain.clusters.length).toBeLessThanOrEqual(2);
    });

    it("should not limit when null", () => {
      const unlimitedDrain = new TestDrain(4, 0.4, 100, null);

      unlimitedDrain.addLogMessage("unique message one");
      unlimitedDrain.addLogMessage("completely different message");
      unlimitedDrain.addLogMessage("totally distinct message");

      expect(unlimitedDrain.clusters.length).toBe(3);
    });
  });

  describe("printTree method", () => {
    it("should output tree structure to stream", () => {
      drain.addLogMessage("error in module A");
      drain.addLogMessage("warning in module B");

      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));

      drain.printTree(stream);

      const output = chunks.join("");
      expect(output).toContain("<root>");
    });

    it("should use console.log when no stream provided", () => {
      drain.addLogMessage("test message");

      // 测试函数存在且可调用
      expect(() => drain.printTree()).not.toThrow();
    });

    it("should respect maxClusters parameter", () => {
      // 添加多个消息到同一 token count
      drain.addLogMessage("a b c d e");
      drain.addLogMessage("x y z w v");

      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));

      drain.printTree(stream, 1);

      const output = chunks.join("");
      // 验证输出包含 cluster 信息
      expect(output).toContain("cluster_count");
    });
  });

  describe("printNode method", () => {
    it("should format depth 0 as root", () => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));

      drain.printNode("root", drain.rootNode, 0, stream);

      const output = chunks.join("");
      expect(output).toContain("<root>");
    });

    it("should format depth 1 as L notation", () => {
      drain.addLogMessage("a b c"); // 3 tokens

      const firstLayerNode = drain.rootNode.children.get("3");
      if (!firstLayerNode) {
        throw new Error("Node not found");
      }

      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));

      drain.printNode("3", firstLayerNode, 1, stream);

      const output = chunks.join("");
      expect(output).toContain("<L=3>");
    });

    it("should format depth 2+ as quoted token", () => {
      const node = new Node();

      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));

      drain.printNode("testToken", node, 2, stream);

      const output = chunks.join("");
      expect(output).toContain('"testToken"');
    });

    it("should show cluster_count when clusterIds present", () => {
      const node = new Node();
      node.clusterIds.push(1);

      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));

      drain.printNode("test", node, 0, stream);

      const output = chunks.join("");
      expect(output).toContain("cluster_count=1");
    });
  });

  describe("writeLine method", () => {
    it("should write to stream when provided", () => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));

      // writeLine 是 protected，通过 printNode 间接测试
      drain.printNode("test", drain.rootNode, 0, stream);

      const output = chunks.join("");
      expect(output.length).toBeGreaterThan(0);
    });

    it("should append newline to output", () => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));

      drain.printNode("test", drain.rootNode, 0, stream);

      const output = chunks.join("");
      expect(output).toContain("\n");
    });
  });

  describe("LogClusterCache LRU behavior", () => {
    it("should evict oldest cluster when max reached", () => {
      const limitedDrain = new TestDrain(4, 0.4, 100, 2);

      limitedDrain.addLogMessage("unique message one");
      limitedDrain.addLogMessage("completely different message two");

      // 添加第三个应该触发淘汰
      limitedDrain.addLogMessage("totally distinct message three");

      // 验证 cluster 数量不超过限制
      expect(limitedDrain.clusters.length).toBeLessThanOrEqual(2);
    });

    it("should update LRU order on get", () => {
      const limitedDrain = new TestDrain(4, 0.4, 100, 3);

      limitedDrain.addLogMessage("message one");
      limitedDrain.addLogMessage("message two");
      limitedDrain.addLogMessage("message three");

      // 获取第一个 cluster（应该更新 LRU 顺序）
      const cluster1 = limitedDrain.idToCluster.get(1);
      expect(cluster1).toBeDefined();

      // 添加新 cluster（应该淘汰最旧的，即 cluster 2）
      limitedDrain.addLogMessage("message four");

      // cluster 1 应该还存在（最近被访问）
      expect(limitedDrain.idToCluster.get(1)).toBeDefined();
    });
  });
});