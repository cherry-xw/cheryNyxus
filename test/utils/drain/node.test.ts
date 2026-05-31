import { describe, it, expect } from "vitest";
import { LogCluster, Node } from "@/utils/drain/node";

describe("Node class", () => {
  it("should create node with empty children map", () => {
    const node = new Node();
    expect(node.children).toBeInstanceOf(Map);
    expect(node.children.size).toBe(0);
  });

  it("should create node with empty clusterIds array", () => {
    const node = new Node();
    expect(node.clusterIds).toBeInstanceOf(Array);
    expect(node.clusterIds.length).toBe(0);
  });

  it("should allow adding children", () => {
    const parent = new Node();
    const child = new Node();

    parent.children.set("token1", child);

    expect(parent.children.size).toBe(1);
    expect(parent.children.get("token1")).toBe(child);
  });

  it("should allow multiple children", () => {
    const parent = new Node();
    const child1 = new Node();
    const child2 = new Node();

    parent.children.set("token1", child1);
    parent.children.set("token2", child2);

    expect(parent.children.size).toBe(2);
  });

  it("should allow adding cluster IDs", () => {
    const node = new Node();
    node.clusterIds.push(1);
    node.clusterIds.push(2);

    expect(node.clusterIds).toEqual([1, 2]);
  });

  it("should support nested node structure", () => {
    const root = new Node();
    const level1 = new Node();
    const level2 = new Node();

    root.children.set("key1", level1);
    level1.children.set("key2", level2);

    expect(root.children.get("key1")?.children.get("key2")).toBe(level2);
  });

  it("should be independent instances", () => {
    const node1 = new Node();
    const node2 = new Node();

    node1.clusterIds.push(1);

    expect(node1.clusterIds.length).toBe(1);
    expect(node2.clusterIds.length).toBe(0);
  });
});

describe("LogCluster class", () => {
  it("should create cluster with template and id", () => {
    const templateTokens = ["error", "occurred", "in", "module"];
    const cluster = new LogCluster(templateTokens, 1);

    expect(cluster.id).toBe(1);
    expect(cluster.template).toEqual(templateTokens);
  });

  it("should initialize size to 1", () => {
    const cluster = new LogCluster(["test"], 1);
    expect(cluster.size).toBe(1);
  });

  it("should allow updating size", () => {
    const cluster = new LogCluster(["test"], 1);
    cluster.size = 5;
    expect(cluster.size).toBe(5);
  });

  it("should allow updating template", () => {
    const cluster = new LogCluster(["token1", "token2"], 1);
    cluster.template = ["token1", "<*>", "token2"];

    expect(cluster.template).toEqual(["token1", "<*>", "token2"]);
  });

  it("should handle empty template", () => {
    const cluster = new LogCluster([], 1);
    expect(cluster.template).toEqual([]);
  });

  it("should handle single token template", () => {
    const cluster = new LogCluster(["single"], 1);
    expect(cluster.template).toEqual(["single"]);
  });

  it("should handle template with wildcard", () => {
    const templateTokens = ["error", "<*>", "module"];
    const cluster = new LogCluster(templateTokens, 1);

    expect(cluster.template).toEqual(templateTokens);
  });

  it("should be independent instances", () => {
    const cluster1 = new LogCluster(["test1"], 1);
    const cluster2 = new LogCluster(["test2"], 2);

    cluster1.size = 10;

    expect(cluster1.size).toBe(10);
    expect(cluster2.size).toBe(1);
  });

  it("should preserve template array reference", () => {
    const templateTokens = ["a", "b", "c"];
    const cluster = new LogCluster(templateTokens, 1);

    expect(cluster.template).toBe(templateTokens);
  });

  it("should allow modifying template array", () => {
    const templateTokens = ["a", "b", "c"];
    const cluster = new LogCluster(templateTokens, 1);

    templateTokens[1] = "<*>";

    expect(cluster.template).toEqual(["a", "<*>", "c"]);
  });
});