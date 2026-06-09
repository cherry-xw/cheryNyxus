import { Writable } from "node:stream";
import type { LogClusterInterface, NodeInterface } from "./types";
import { LogCluster, Node } from "./node";
import { logger } from "@/utils/logger/index.js";

export interface Profiler {
  /** Starts timing/profiling for a named section. */
  startSection(sectionName: string): void;
  /** Ends the currently active profiling section. */
  endSection(): void;
}

export class NullProfiler implements Profiler {
  startSection(_sectionName: string): void {}
  endSection(): void {}
}

class LogClusterCache extends Map<number, LogClusterInterface> {
  private readonly maxsize: number;

  constructor(maxsize: number) {
    super();
    this.maxsize = maxsize;
  }

  override get(key: number): LogClusterInterface | undefined {
    const value = super.get(key);
    if (value !== undefined) {
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }

  override set(key: number, value: LogClusterInterface): this {
    if (super.has(key)) {
      super.delete(key);
    }

    super.set(key, value);

    while (this.size > this.maxsize) {
      const oldestKey = this.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      super.delete(oldestKey);
    }

    return this;
  }
}

export enum DrainUpdateType {
  CLUSTER_CREATED = "cluster_created",
  CLUSTER_TEMPLATE_CHANGED = "cluster_template_changed",
  NONE = "none",
}
export abstract class DrainBase {
  logClusterDepth: number;
  maxNodeDepth: number;
  simTh: number;
  maxChildren: number;
  rootNode: NodeInterface;
  profiler: Profiler;
  extraDelimiters: string[];
  maxClusters: number | null;
  paramStr: string;
  parametrizeNumericTokens: boolean;
  idToCluster: Map<number, LogClusterInterface>;
  clustersCounter: number;

  /**
   * Creates a new Drain base instance.
   *
   * Depth must be at least 3:
   * - 1: root
   * - 2: token-count bucket
   * - 3+: token nodes
   *
   * @param depth Maximum depth levels of log clusters.
   * @param simTh Similarity threshold below which a new cluster is created.
   * @param maxChildren Maximum number of children for an internal node.
   * @param maxClusters Maximum number of tracked clusters. `null` means unlimited.
   * @param extraDelimiters Extra delimiters used in addition to whitespace tokenization.
   * @param profiler Profiler implementation used around major operations.
   * @param paramStr Wildcard parameter token used in templates.
   * @param parametrizeNumericTokens Whether tokens containing digits are treated as parameters.
   */
  constructor(
    depth = 4,
    simTh = 0.4,
    maxChildren = 100,
    maxClusters: number | null = null,
    extraDelimiters: string[] = [],
    profiler: Profiler = new NullProfiler(),
    paramStr = "<*>",
    parametrizeNumericTokens = true,
  ) {
    if (depth < 3) {
      throw new Error("depth argument must be at least 3");
    }

    this.rootNode = new Node();
    this.logClusterDepth = depth;
    this.maxNodeDepth = depth - 2;
    this.simTh = simTh;
    this.maxChildren = maxChildren;
    this.profiler = profiler;
    this.extraDelimiters = extraDelimiters;
    this.maxClusters = maxClusters;
    this.paramStr = paramStr;
    this.parametrizeNumericTokens = parametrizeNumericTokens;
    this.idToCluster =
      maxClusters === null ? new Map() : new LogClusterCache(maxClusters);
    this.clustersCounter = 0;
  }

  /** Returns all currently tracked clusters. */
  get clusters(): LogClusterInterface[] {
    return Array.from(this.idToCluster.values()).filter(
      (cluster): cluster is LogClusterInterface => cluster !== undefined,
    );
  }

  /**
   * Returns `true` when the provided iterable contains at least one numeric character.
   *
   * @param value Iterable of characters to inspect.
   */
  static hasNumbers(value: Iterable<string>): boolean {
    for (const char of value) {
      if (/\d/.test(char)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Finds the best matching cluster for tokenized content among candidate cluster IDs.
   *
   * @param clusterIds Candidate cluster IDs to evaluate.
   * @param tokens Tokenized log content.
   * @param simTh Minimum similarity threshold.
   * @param includeParams Whether wildcard parameter matches contribute to similarity.
   * @returns The best matching cluster or `null` if no match reaches `simTh`.
   */
  fastMatch(
    clusterIds: Iterable<number>,
    tokens: string[],
    simTh: number,
    includeParams: boolean,
  ): LogClusterInterface | null {
    let maxSim = -1;
    let maxParamCount = -1;
    let maxCluster: LogClusterInterface | null = null;

    for (const clusterId of clusterIds) {
      const cluster = this.idToCluster.get(clusterId);
      if (!cluster) {
        continue;
      }

      const [currentSim, paramCount] = this.getSeqDistance(
        cluster.template,
        tokens,
        includeParams,
      );
      if (
        currentSim > maxSim ||
        (currentSim === maxSim && paramCount > maxParamCount)
      ) {
        maxSim = currentSim;
        maxParamCount = paramCount;
        maxCluster = cluster;
      }
    }

    if (maxSim >= simTh) {
      return maxCluster;
    }

    return null;
  }

  /**
   * Prints the full prefix tree rooted at `rootNode`.
   *
   * @param file Optional writable stream destination. Defaults to `logger.info`.
   * @param maxClusters Maximum clusters to print per leaf node.
   */
  printTree(file?: Writable, maxClusters = 5): void {
    this.printNode("root", this.rootNode, 0, file, maxClusters);
  }

  /**
   * Recursively prints a tree node and its descendants.
   *
   * @param token Node token label.
   * @param node Node to print.
   * @param depth Current traversal depth.
   * @param file Optional writable stream destination.
   * @param maxClusters Maximum clusters to print for the node.
   */
  printNode(
    token: string,
    node: NodeInterface,
    depth: number,
    file?: Writable,
    maxClusters = 5,
  ): void {
    let out = "\t".repeat(depth);

    if (depth === 0) {
      out += `<${token}>`;
    } else if (depth === 1) {
      out += /^\d+$/.test(token) ? `<L=${token}>` : `<${token}>`;
    } else {
      out += `"${token}"`;
    }

    if (node.clusterIds.length > 0) {
      out += ` (cluster_count=${node.clusterIds.length})`;
    }

    this.writeLine(out, file);

    for (const [childToken, childNode] of node.children.entries()) {
      this.printNode(childToken, childNode, depth + 1, file, maxClusters);
    }

    for (const clusterId of node.clusterIds.slice(0, maxClusters)) {
      const cluster = this.idToCluster.get(clusterId);
      if (!cluster) {
        continue;
      }

      const clusterOut = `${"\t".repeat(depth + 1)}${JSON.stringify(cluster)}`;
      this.writeLine(clusterOut, file);
    }
  }

  /**
   * Normalizes and tokenizes raw log content.
   *
   * @param content Raw log message.
   * @returns Token array after delimiter and whitespace splitting.
   */
  getContentAsTokens(content: string): string[] {
    let normalized = content.trim();
    for (const delimiter of this.extraDelimiters) {
      normalized = normalized.split(delimiter).join(" ");
    }

    return normalized.split(/\s+/).filter((token) => token.length > 0);
  }

  /**
   * Adds a log message to the model, creating or updating a cluster as needed.
   *
   * @param content Raw log message.
   * @returns A tuple containing the matched/created cluster and update type.
   */
  addLogMessage(content: string): [LogClusterInterface, DrainUpdateType] {
    const contentTokens = this.getContentAsTokens(content);

    this.profiler.startSection("tree_search");
    let matchCluster = this.treeSearch(
      this.rootNode,
      contentTokens,
      this.simTh,
      false,
    );
    this.profiler.endSection();

    let updateType: DrainUpdateType;

    if (!matchCluster) {
      this.profiler.startSection("create_cluster");
      this.clustersCounter += 1;
      const clusterId = this.clustersCounter;
      matchCluster = new LogCluster(contentTokens, clusterId);
      this.idToCluster.set(clusterId, matchCluster);
      this.addSeqToPrefixTree(this.rootNode, matchCluster);
      updateType = DrainUpdateType.CLUSTER_CREATED;
    } else {
      this.profiler.startSection("cluster_exist");
      const newTemplateTokens = this.createTemplate(
        contentTokens,
        matchCluster.template,
      );
      const sameTemplate =
        newTemplateTokens.length === matchCluster.template.length &&
        newTemplateTokens.every(
          (token, index) => token === matchCluster?.template[index],
        );

      if (sameTemplate) {
        updateType = DrainUpdateType.NONE;
      } else {
        matchCluster.template = [...newTemplateTokens];
        updateType = DrainUpdateType.CLUSTER_TEMPLATE_CHANGED;
      }

      matchCluster.size += 1;

      if (this.maxClusters !== null) {
        this.idToCluster.get(matchCluster.id);
      }
    }

    this.profiler.endSection();
    return [matchCluster, updateType];
  }

  /** Returns the sum of sizes across all tracked clusters. */
  getTotalClusterSize(): number {
    let size = 0;
    for (const cluster of this.idToCluster.values()) {
      if (!cluster) {
        continue;
      }
      size += cluster.size;
    }
    return size;
  }

  /**
   * Returns all cluster IDs under the token-count branch represented by `seqFirst`.
   *
   * @param seqFirst Token-count key (typically the first-level tree key).
   */
  getClustersIdsForSeqLen(seqFirst: number | string): number[] {
    const appendClustersRecursive = (
      node: NodeInterface,
      target: number[],
    ): void => {
      target.push(...node.clusterIds);
      for (const childNode of node.children.values()) {
        appendClustersRecursive(childNode, target);
      }
    };

    const currentNode = this.rootNode.children.get(String(seqFirst));
    if (!currentNode) {
      return [];
    }

    const target: number[] = [];
    appendClustersRecursive(currentNode, target);
    return target;
  }

  /**
   * Writes one line to the provided stream or to stdout.
   *
   * @param text Text to write.
   * @param file Optional writable stream destination.
   */
  protected writeLine(text: string, file?: Writable): void {
    if (!file) {
      logger.info(text);
      return;
    }

    file.write(`${text}\n`);
  }

  /**
   * Performs tree-based search for the best matching cluster.
   *
   * @param rootNode Tree root node.
   * @param tokens Tokenized content.
   * @param simTh Similarity threshold.
   * @param includeParams Whether wildcard matches count in similarity.
   */
  abstract treeSearch(
    rootNode: NodeInterface,
    tokens: string[],
    simTh: number,
    includeParams: boolean,
  ): LogClusterInterface | null;

  /**
   * Adds a cluster template path to the prefix tree.
   *
   * @param rootNode Tree root node.
   * @param cluster Cluster to insert.
   */
  abstract addSeqToPrefixTree(
    rootNode: NodeInterface,
    cluster: LogClusterInterface,
  ): void;

  /**
   * Computes distance/similarity between two token sequences.
   *
   * @param seq1 First sequence.
   * @param seq2 Second sequence.
   * @param includeParams Whether wildcard parameters contribute to similarity.
   * @returns Tuple of `[similarity, parameterCount]`.
   */
  abstract getSeqDistance(
    seq1: string[],
    seq2: string[],
    includeParams: boolean,
  ): [number, number];

  /**
   * Creates a merged template from two token sequences.
   *
   * @param seq1 First sequence.
   * @param seq2 Second sequence.
   */
  abstract createTemplate(seq1: string[], seq2: string[]): string[];

  /**
   * Matches raw content to a known cluster.
   *
   * @param content Raw log content.
   * @param fullSearchStrategy Search policy for full search behavior.
   */
  abstract match(
    content: string,
    fullSearchStrategy?: "never" | "always",
  ): LogClusterInterface | null;
}