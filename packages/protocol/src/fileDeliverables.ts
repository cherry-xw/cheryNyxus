import type { FileOperationRecord } from './chat.js'

/** 每条独立产出链保留最后一批成功保存的文件，多图不会缩减为一张。 */
export function defaultDeliverableAssetIds(operations: readonly FileOperationRecord[]): string[] {
  const successful = operations.filter(op =>
    ['succeeded', 'partial'].includes(op.executionStatus) && ['saved', 'partial_saved'].includes(op.deliveryStatus) &&
    ((op.outputAssetIds?.length ?? 0) > 0 || op.outputParts?.some(part => part.type === 'asset')),
  ).sort((a, b) => a.createdAt - b.createdAt)
  const roots = new Map<string, string>()
  const producer = new Map<string, string>()
  const latest = new Map<string, FileOperationRecord>()
  const root = (id: string): string => {
    const parent = roots.get(id)
    return parent && parent !== id ? root(parent) : id
  }
  for (const op of successful) {
    const parents = [...new Set(op.inputAssets.flatMap(asset => {
      const previous = producer.get(asset.assetId)
      return previous ? [root(previous)] : []
    }))]
    const chain = parents[0] ?? op.operationId
    roots.set(op.operationId, chain)
    for (const parent of parents) { roots.set(parent, chain); latest.delete(parent) }
    latest.set(chain, op)
    for (const id of outputIds(op)) producer.set(id, chain)
  }
  return [...new Set([...latest.values()].flatMap(outputIds))]
}

function outputIds(op: FileOperationRecord): string[] {
  return [...new Set([...(op.outputAssetIds ?? []), ...(op.outputParts ?? []).filter(part => part.type === 'asset').map(part => part.assetId)])]
}
