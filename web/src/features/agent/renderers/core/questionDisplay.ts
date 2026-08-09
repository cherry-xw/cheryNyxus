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
  | { kind: 'answered'; labels: string[]; freeText?: string }

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

function matchSerializedLabels(
  serialized: string,
  options: readonly QuestionOptionView[],
): string[] {
  if (!serialized) return []
  const labels = options.map((option) => option.label)
  const memo = new Map<number, string[] | null>()

  function visit(offset: number): string[] | null {
    if (offset === serialized.length) return []
    if (memo.has(offset)) return memo.get(offset) ?? null
    for (const label of labels) {
      if (!serialized.startsWith(label, offset)) continue
      const end = offset + label.length
      if (end === serialized.length) {
        const match = [label]
        memo.set(offset, match)
        return match
      }
      if (!serialized.startsWith(', ', end)) continue
      const rest = visit(end + 2)
      if (rest) {
        const match = [label, ...rest]
        memo.set(offset, match)
        return match
      }
    }
    memo.set(offset, null)
    return null
  }

  return (
    visit(0) ??
    serialized
      .split(', ')
      .map((label) => label.trim())
      .filter(Boolean)
  )
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

  const labels = matchSerializedLabels(labelsText, args?.options ?? [])
  return {
    kind: 'answered',
    labels,
    ...(freeText ? { freeText } : {}),
  }
}
