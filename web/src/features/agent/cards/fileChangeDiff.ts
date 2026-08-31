import { parseArgs } from '@/utils/parseArgs'

export type FileChangePreview = {
  path: string
  before: string
  after: string
  kind: 'create' | 'modify' | 'delete'
}

export type FileChangePreviewPayload = { files: FileChangePreview[]; error?: string }
export type FileChangeDiffLine = { kind: 'add' | 'remove' | 'same'; text: string }

export function fileChangePreview(args: unknown): FileChangePreviewPayload | null {
  const value = parseArgs(args).parsed?.entries.find(
    (entry) => entry.key === '__filePreview',
  )?.value
  if (!value || typeof value !== 'object') return null
  const payload = value as Partial<FileChangePreviewPayload & FileChangePreview>
  const files = Array.isArray(payload.files) ? payload.files : [payload]
  const valid = files
    .filter(
      (item): item is FileChangePreview =>
        typeof item?.path === 'string' &&
        typeof item.before === 'string' &&
        typeof item.after === 'string',
    )
    .map((item): FileChangePreview => ({
      ...item,
      kind: item.kind === 'create' || item.kind === 'delete' ? item.kind : 'modify',
    }))
  return valid.length || typeof payload.error === 'string'
    ? { files: valid, error: payload.error }
    : null
}

export function diffFileLines(beforeText: string, afterText: string): FileChangeDiffLine[] {
  const before = beforeText === '' ? [] : beforeText.split('\n')
  const after = afterText === '' ? [] : afterText.split('\n')
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1))
  for (let row = before.length - 1; row >= 0; row--) {
    for (let col = after.length - 1; col >= 0; col--) {
      table[row]![col] =
        before[row] === after[col]
          ? table[row + 1]![col + 1]! + 1
          : Math.max(table[row + 1]![col]!, table[row]![col + 1]!)
    }
  }
  const output: FileChangeDiffLine[] = []
  let row = 0
  let col = 0
  while (row < before.length || col < after.length) {
    if (row < before.length && col < after.length && before[row] === after[col]) {
      output.push({ kind: 'same', text: before[row++]! })
      col++
    } else if (
      col < after.length &&
      (row === before.length || table[row]![col + 1]! >= table[row + 1]![col]!)
    ) {
      output.push({ kind: 'add', text: after[col++]! })
    } else {
      output.push({ kind: 'remove', text: before[row++]! })
    }
  }
  return output
}
