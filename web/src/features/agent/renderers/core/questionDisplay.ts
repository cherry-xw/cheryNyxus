export interface QuestionOptionView {
  label: string
  description?: string
}

export interface QuestionArgsView {
  question: string
  header?: string
  options: QuestionOptionView[]
  multiSelect: boolean
}

export type QuestionAnswerView =
  | { kind: 'running'; labels: []; freeText?: undefined }
  | { kind: 'cancelled'; labels: []; freeText?: undefined }
  | { kind: 'missing'; labels: []; freeText?: undefined }
  | { kind: 'answered'; labels: string[]; freeText?: string; notes?: Record<string, string> }

export function parseQuestionArgs(input: unknown): QuestionArgsView | null {
  try {
    const value: unknown = typeof input === 'string' ? JSON.parse(input) : input
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const raw = value as Record<string, unknown>
    if (typeof raw.question !== 'string' || !Array.isArray(raw.options)) return null
    const options = raw.options.flatMap((option): QuestionOptionView[] => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return []
      const candidate = option as Record<string, unknown>
      if (typeof candidate.label !== 'string') return []
      return [
        {
          label: candidate.label,
          ...(typeof candidate.description === 'string'
            ? { description: candidate.description }
            : {}),
        },
      ]
    })
    return {
      question: raw.question,
      ...(typeof raw.header === 'string' ? { header: raw.header } : {}),
      options,
      multiSelect: raw.multiSelect === true,
    }
  } catch {
    return null
  }
}

interface SerializedLabelMatch {
  labels: string[]
  notes: Record<string, string>
}

/** 后端选项补充注记分隔：`label（补充: note）`（src/db/question.ts）。 */
const NOTE_SUFFIX = '（补充: '

function matchSerializedLabels(
  serialized: string,
  options: readonly QuestionOptionView[],
): SerializedLabelMatch {
  if (!serialized) return { labels: [], notes: {} }
  const labels = options.map((option) => option.label)
  const memo = new Map<number, SerializedLabelMatch | null>()

  /** 读取 label 之后紧跟的「（补充: note）」注记；无注记返回 undefined。 */
  function noteAfter(offset: number, labelLength: number): string | undefined {
    const after = offset + labelLength
    if (!serialized.startsWith(NOTE_SUFFIX, after)) return undefined
    const end = serialized.indexOf('）', after + NOTE_SUFFIX.length)
    if (end < 0) return undefined
    return serialized.slice(after + NOTE_SUFFIX.length, end).trim() || undefined
  }

  function visit(offset: number): SerializedLabelMatch | null {
    if (offset === serialized.length) return { labels: [], notes: {} }
    if (memo.has(offset)) return memo.get(offset) ?? null
    for (const label of labels) {
      if (!serialized.startsWith(label, offset)) continue
      const end = offset + label.length
      const note = noteAfter(offset, label.length)
      const after = note !== undefined ? end + NOTE_SUFFIX.length + note.length + 1 : end
      if (after === serialized.length) {
        const match: SerializedLabelMatch = {
          labels: [label],
          notes: note !== undefined ? { [label]: note } : {},
        }
        memo.set(offset, match)
        return match
      }
      if (!serialized.startsWith(', ', after)) continue
      const rest = visit(after + 2)
      if (rest) {
        const match: SerializedLabelMatch = {
          labels: [label, ...rest.labels],
          notes: note !== undefined ? { [label]: note, ...rest.notes } : rest.notes,
        }
        memo.set(offset, match)
        return match
      }
    }
    memo.set(offset, null)
    return null
  }

  const matched = visit(0)
  if (matched) return matched
  // 无法按完整选项标签匹配（历史异常数据）：逐段剥离补充注记后原样保留。
  const notes: Record<string, string> = {}
  const parts = serialized
    .split(', ')
    .map((part) => {
      const noteIndex = part.indexOf(NOTE_SUFFIX)
      if (noteIndex < 0 || !part.endsWith('）')) return part.trim()
      const base = part.slice(0, noteIndex).trim()
      const note = part.slice(noteIndex + NOTE_SUFFIX.length, -1).trim()
      if (base && note) notes[base] = note
      return base
    })
    .filter(Boolean)
  return { labels: parts, notes }
}

export function parseQuestionAnswer(
  result: unknown,
  status: string,
  args: QuestionArgsView | null,
): QuestionAnswerView {
  if (status === 'running') return { kind: 'running', labels: [] }
  if (typeof result !== 'string') return { kind: 'missing', labels: [] }
  if (result === '(用户取消了此问题)') return { kind: 'cancelled', labels: [] }

  const prefix = '用户回答: '
  if (!result.startsWith(prefix)) return { kind: 'missing', labels: [] }
  const body = result.slice(prefix.length)
  const otherPrefix = '其他: '
  const otherSeparator = ', 其他: '
  let labelsText = body
  let freeText: string | undefined
  if (body.startsWith(otherPrefix)) {
    labelsText = ''
    freeText = body.slice(otherPrefix.length).trim()
  } else {
    const otherIndex = body.lastIndexOf(otherSeparator)
    if (otherIndex >= 0) {
      labelsText = body.slice(0, otherIndex)
      freeText = body.slice(otherIndex + otherSeparator.length).trim()
    }
  }

  const matched = matchSerializedLabels(labelsText, args?.options ?? [])
  return {
    kind: 'answered',
    labels: matched.labels,
    ...(freeText ? { freeText } : {}),
    ...(Object.keys(matched.notes).length ? { notes: matched.notes } : {}),
  }
}
