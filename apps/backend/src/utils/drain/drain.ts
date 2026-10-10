import type { NodeInterface } from './types'
import { DrainBase } from './drainBase'
import { LogCluster, Node } from './node'

export class Drain extends DrainBase {
  /**
   * Performs a tree-based search for the best matching cluster.
   */
  treeSearch(
    rootNode: NodeInterface,
    tokens: string[],
    simTh: number,
    includeParams: boolean,
  ): LogCluster | null {
    const tokenCount = tokens.length
    let currentNode = rootNode.children.get(String(tokenCount))

    if (!currentNode) {
      return null
    }

    if (tokenCount === 0) {
      const clusterId = currentNode.clusterIds[0]
      if (clusterId === undefined) {
        return null
      }
      return this.idToCluster.get(clusterId) ?? null
    }

    let currentNodeDepth = 1
    for (const token of tokens) {
      if (currentNodeDepth >= this.maxNodeDepth) {
        break
      }

      if (currentNodeDepth === tokenCount) {
        break
      }

      const keyToChildNode: Map<string, NodeInterface> = currentNode.children
      currentNode = keyToChildNode.get(token) ?? keyToChildNode.get(this.paramStr)

      if (!currentNode) {
        return null
      }

      currentNodeDepth += 1
    }

    return this.fastMatch(currentNode.clusterIds, tokens, simTh, includeParams)
  }

  /**
   * Inserts a cluster template sequence into the Drain prefix tree.
   */
  addSeqToPrefixTree(rootNode: NodeInterface, cluster: LogCluster): void {
    const tokenCount = cluster.template.length
    const tokenCountKey = String(tokenCount)

    let firstLayerNode = rootNode.children.get(tokenCountKey)
    if (!firstLayerNode) {
      firstLayerNode = new Node()
      rootNode.children.set(tokenCountKey, firstLayerNode)
    }

    let currentNode = firstLayerNode

    if (tokenCount === 0) {
      currentNode.clusterIds = [cluster.id]
      return
    }

    let currentDepth = 1
    for (const token of cluster.template) {
      if (currentDepth >= this.maxNodeDepth || currentDepth >= tokenCount) {
        const newClusterIds: number[] = []
        for (const clusterId of currentNode.clusterIds) {
          if (this.idToCluster.has(clusterId)) {
            newClusterIds.push(clusterId)
          }
        }
        newClusterIds.push(cluster.id)
        currentNode.clusterIds = newClusterIds
        break
      }

      if (!currentNode.children.has(token)) {
        if (this.parametrizeNumericTokens && DrainBase.hasNumbers(token)) {
          if (!currentNode.children.has(this.paramStr)) {
            const newNode = new Node()
            currentNode.children.set(this.paramStr, newNode)
            currentNode = newNode
          } else {
            currentNode = currentNode.children.get(this.paramStr)!
          }
        } else if (currentNode.children.has(this.paramStr)) {
          if (currentNode.children.size < this.maxChildren) {
            const newNode = new Node()
            currentNode.children.set(token, newNode)
            currentNode = newNode
          } else {
            currentNode = currentNode.children.get(this.paramStr)!
          }
        } else if (currentNode.children.size + 1 < this.maxChildren) {
          const newNode = new Node()
          currentNode.children.set(token, newNode)
          currentNode = newNode
        } else if (currentNode.children.size + 1 === this.maxChildren) {
          const newNode = new Node()
          currentNode.children.set(this.paramStr, newNode)
          currentNode = newNode
        } else {
          currentNode = currentNode.children.get(this.paramStr)!
        }
      } else {
        currentNode = currentNode.children.get(token)!
      }

      currentDepth += 1
    }
  }

  /**
   * Computes similarity between a template sequence and a log sequence.
   */
  getSeqDistance(seq1: string[], seq2: string[], includeParams: boolean): [number, number] {
    if (seq1.length !== seq2.length) {
      throw new Error('Sequence lengths must match')
    }

    if (seq1.length === 0) {
      return [1, 0]
    }

    let similarTokens = 0
    let paramCount = 0

    for (let index = 0; index < seq1.length; index += 1) {
      const token1 = seq1[index]
      const token2 = seq2[index]

      if (token1 === this.paramStr) {
        paramCount += 1
        continue
      }

      if (token1 === token2) {
        similarTokens += 1
      }
    }

    if (includeParams) {
      similarTokens += paramCount
    }

    return [similarTokens / seq1.length, paramCount]
  }

  /**
   * Creates a merged template by replacing mismatched tokens with the wildcard token.
   */
  createTemplate(seq1: string[], seq2: string[]): string[] {
    if (seq1.length !== seq2.length) {
      throw new Error('Sequence lengths must match')
    }

    return seq1.map((token, index) => (token === seq2[index] ? seq2[index] : this.paramStr))
  }

  /**
   * Matches a log message against existing clusters without creating/modifying clusters.
   */
  match(content: string, fullSearchStrategy: 'never' | 'always' = 'never'): LogCluster | null {
    const requiredSimTh = 1.0
    const contentTokens = this.getContentAsTokens(content)

    const fullSearch = (): LogCluster | null => {
      const allIds = this.getClustersIdsForSeqLen(contentTokens.length)
      return this.fastMatch(allIds, contentTokens, requiredSimTh, true)
    }

    if (fullSearchStrategy === 'always') {
      return fullSearch()
    }

    const matchCluster = this.treeSearch(this.rootNode, contentTokens, requiredSimTh, true)

    if (matchCluster) {
      return matchCluster
    }

    if (fullSearchStrategy === 'never') {
      return null
    }

    return fullSearch()
  }
}
