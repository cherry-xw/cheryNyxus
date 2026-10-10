import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import { Drain } from './drain'
import { DrainUpdateType } from './drainBase'
import { LogCluster, Node } from './node'
import { PersistenceHandler } from './persistenceHandler'
import type {
  ChangeType,
  DrainState,
  LogClusterInterface,
  NodeInterface,
  SerializedCluster,
  SerializedNode,
  TemplateMinerResult,
} from './types'
import { TemplateMinerConfig } from './templateMinerConfig'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

export class TemplateMiner {
  private drain: Drain
  private readonly config: TemplateMinerConfig
  private readonly persistence: PersistenceHandler | null
  private lastSaveTime: number
  private initialized: boolean

  /**
   * Creates a template miner instance.
   *
   * @param config Optional miner configuration.
   * @param persistence Optional persistence backend for snapshots.
   */
  constructor(config?: TemplateMinerConfig, persistence?: PersistenceHandler) {
    this.config = config ?? new TemplateMinerConfig()
    this.persistence = persistence ?? null
    this.drain = new Drain(
      this.config.drainDepth,
      this.config.drainSimTh,
      this.config.drainMaxChildren,
      this.config.drainMaxClusters,
      this.config.drainExtraDelimiters,
      undefined,
      '<*>',
      this.config.parametrizeNumericTokens,
    )
    this.lastSaveTime = Date.now()
    this.initialized = false
  }

  /**
   * Loads a previously saved snapshot from persistence, if configured.
   */
  async initialize(): Promise<void> {
    if (this.persistence) {
      await this.loadState()
    }

    this.initialized = true
  }

  /**
   * Ingests a log message into the Drain model.
   *
   * @param logMessage Raw log line.
   * @returns Result metadata describing the updated or created cluster.
   */
  async addLogMessage(logMessage: string): Promise<TemplateMinerResult> {
    this.ensureInitialized()
    const startTime = performance.now()
    const preprocessed = this.preprocessMessage(logMessage)
    const [cluster, updateType] = this.drain.addLogMessage(preprocessed)

    await this.snapshotIfNeeded()

    return {
      logCluster: cluster,
      isNewTemplate: updateType === DrainUpdateType.CLUSTER_CREATED,
      changeType: this.toChangeType(updateType),
      processingTime: performance.now() - startTime,
    }
  }

  /**
   * Matches a message against existing templates without updating state.
   *
   * @param logMessage Raw log line.
   * @returns Matching template string or `null` if no match was found.
   */
  getTemplate(logMessage: string): string | null {
    this.ensureInitialized()
    const preprocessed = this.preprocessMessage(logMessage)
    const cluster = this.drain.match(preprocessed)
    if (!cluster) {
      return null
    }

    return cluster.template.join(' ')
  }

  /**
   * Returns all known clusters.
   *
   * @returns Current cluster collection.
   */
  getClusters(): LogClusterInterface[] {
    this.ensureInitialized()
    return this.drain.clusters
  }

  /**
   * Looks up a cluster by id.
   *
   * @param id Cluster id.
   * @returns Cluster instance when found, otherwise `null`.
   */
  getClusterById(id: number): LogClusterInterface | null {
    this.ensureInitialized()
    return this.drain.idToCluster.get(id) ?? null
  }

  /**
   * Returns the number of known clusters.
   *
   * @returns Current cluster count.
   */
  clusterCount(): number {
    this.ensureInitialized()
    return this.drain.clusters.length
  }

  /**
   * Saves an immediate snapshot regardless of interval settings.
   */
  async saveSnapshot(): Promise<void> {
    this.ensureInitialized()
    if (!this.persistence) {
      return
    }

    await this.saveState()
    this.lastSaveTime = Date.now()
  }

  /**
   * Flushes state and closes the persistence backend.
   */
  async close(): Promise<void> {
    if (!this.initialized) {
      return
    }

    await this.saveSnapshot()
    if (!this.persistence) {
      return
    }

    await this.persistence.close()
  }

  /**
   * Applies delimiter normalization and optional numeric token parameterization.
   *
   * @param message Raw message.
   * @returns Preprocessed message safe for Drain ingestion/matching.
   */
  private preprocessMessage(message: string): string {
    let normalized = message.trim()
    for (const delimiter of this.config.drainExtraDelimiters) {
      normalized = normalized.split(delimiter).join(' ')
    }

    const tokens = normalized.split(/\s+/).filter(Boolean)
    if (!this.config.parametrizeNumericTokens) {
      return tokens.join(' ')
    }

    return tokens.map((token) => (/^\d+$/.test(token) ? '<*>' : token)).join(' ')
  }

  /**
   * Maps Drain update events to the public change type contract.
   *
   * @param updateType Internal Drain update type.
   * @returns Public-facing change type.
   */
  private toChangeType(updateType: DrainUpdateType): ChangeType {
    if (updateType === DrainUpdateType.CLUSTER_CREATED) {
      return 'created'
    }

    if (updateType === DrainUpdateType.CLUSTER_TEMPLATE_CHANGED) {
      return 'updated'
    }

    return 'none'
  }

  /**
   * Ensures the miner has been initialized before use.
   */
  private ensureInitialized(): void {
    if (this.initialized) {
      return
    }

    throw new Error(
      'TemplateMiner is not initialized. Call and await initialize() before using it.',
    )
  }

  /**
   * Saves a snapshot when the configured interval has elapsed.
   */
  private async snapshotIfNeeded(): Promise<void> {
    if (!this.persistence) {
      return
    }

    const intervalMs = this.config.snapshotIntervalMinutes * 60 * 1000
    if (Date.now() - this.lastSaveTime < intervalMs) {
      return
    }

    await this.saveState()
    this.lastSaveTime = Date.now()
  }

  /**
   * Serializes the current Drain instance into a plain JSON-compatible state object.
   *
   * @returns Serialized Drain state.
   */
  private getDrainState(): DrainState {
    const clusters: SerializedCluster[] = this.drain.clusters.map((cluster) => ({
      id: cluster.id,
      template: [...cluster.template],
      size: cluster.size,
    }))

    const idToCluster: Record<number, SerializedCluster> = {}
    for (const cluster of clusters) {
      idToCluster[cluster.id] = cluster
    }

    return {
      clusters,
      idToCluster,
      rootNode: this.serializeNode(this.drain.rootNode),
      clusterId: this.drain.clustersCounter,
    }
  }

  /**
   * Restores the active Drain instance from a serialized state snapshot.
   *
   * @param state Serialized state to restore.
   */
  private restoreDrainFromState(state: DrainState): void {
    this.drain = new Drain(
      this.config.drainDepth,
      this.config.drainSimTh,
      this.config.drainMaxChildren,
      this.config.drainMaxClusters,
      this.config.drainExtraDelimiters,
      undefined,
      '<*>',
      this.config.parametrizeNumericTokens,
    )

    const serializedClusters =
      state.clusters.length > 0 ? state.clusters : Object.values(state.idToCluster ?? {})

    for (const sc of serializedClusters) {
      const cluster = new LogCluster([...sc.template], sc.id)
      cluster.size = sc.size
      this.drain.idToCluster.set(cluster.id, cluster)
    }

    this.drain.rootNode = this.deserializeNode(state.rootNode)
    this.drain.clustersCounter = state.clusterId
  }

  /**
   * Recursively serializes a tree node.
   *
   * @param node Node to serialize.
   * @returns Serialized node shape.
   */
  private serializeNode(node: NodeInterface): SerializedNode {
    const keyToChildNode: Record<string, SerializedNode> = {}
    for (const [key, child] of node.children.entries()) {
      keyToChildNode[key] = this.serializeNode(child)
    }

    return {
      keyToChildNode,
      clusterIds: [...node.clusterIds],
    }
  }

  /**
   * Recursively deserializes a serialized tree node.
   *
   * @param node Serialized node payload.
   * @returns Materialized tree node.
   */
  private deserializeNode(node: SerializedNode): NodeInterface {
    const deserializedNode = new Node()
    deserializedNode.clusterIds = [...node.clusterIds]

    for (const [key, childNode] of Object.entries(node.keyToChildNode)) {
      deserializedNode.children.set(key, this.deserializeNode(childNode))
    }

    return deserializedNode
  }

  /**
   * Persists current miner state into the configured persistence backend.
   */
  private async saveState(): Promise<void> {
    if (!this.persistence) {
      return
    }

    const state = this.getDrainState()
    let data = JSON.stringify(state)
    if (this.config.snapshotCompressState) {
      data = (await gzipAsync(Buffer.from(data))).toString('base64')
    }

    await this.persistence.save(data)
  }

  /**
   * Loads miner state from persistence and restores Drain when data exists.
   */
  private async loadState(): Promise<void> {
    if (!this.persistence) {
      return
    }

    let raw = await this.persistence.load()
    if (!raw) {
      return
    }

    if (this.config.snapshotCompressState) {
      raw = (await gunzipAsync(Buffer.from(raw, 'base64'))).toString('utf-8')
    }

    this.restoreDrainFromState(JSON.parse(raw) as DrainState)
  }

  /**
   * Deletes the persisted state from the configured persistence backend, if supported.
   */
  public async deleteState(): Promise<void> {
    if (!this.persistence) {
      return
    }

    await this.persistence.delete()
  }
}
