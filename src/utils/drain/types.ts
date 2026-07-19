export interface LogClusterInterface {
  id: number
  template: string[]
  size: number
}

export interface NodeInterface {
  children: Map<string, NodeInterface>
  clusterIds: number[]
}

export interface SerializedCluster {
  id: number
  template: string[]
  size: number
}

export interface SerializedNode {
  keyToChildNode: Record<string, SerializedNode>
  clusterIds: number[]
}

export interface DrainState {
  clusters: SerializedCluster[]
  idToCluster: Record<number, SerializedCluster>
  rootNode: SerializedNode
  clusterId: number
}

export type ChangeType = 'none' | 'created' | 'updated'

export interface TemplateMinerResult {
  logCluster: LogClusterInterface
  isNewTemplate: boolean
  changeType: ChangeType
  processingTime: number
}

/**
 * Drain压缩结果
 */
export interface DrainResult {
  compressedContent: string
  templateCount: number
  lineCount: number
  compressionRatio: string
}
