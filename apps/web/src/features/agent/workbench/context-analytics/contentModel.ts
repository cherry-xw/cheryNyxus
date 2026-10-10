import type { ContextContentItem } from './model'

export function readableContextText(value: string): string {
  return value.replace(/\\r\\n|\\n|\\r/g, '\n')
}

function schemaType(value: unknown): string {
  if (!value || typeof value !== 'object') return 'unknown'
  const type = (value as { type?: unknown }).type
  return Array.isArray(type) ? type.join(' | ') : typeof type === 'string' ? type : 'unknown'
}

export function contextContentItemFromResponse(
  item: { id: string; name: string; content: string; kind: 'system' | 'tool' },
  sourceLabel: string,
  contentState: 'available' | 'partial' | 'missing',
): ContextContentItem {
  if (item.kind !== 'tool') {
    return {
      itemId: item.id,
      category: 'system',
      label: item.name,
      preview: item.content.slice(0, 240),
      content: readableContextText(item.content),
      tokenEstimate: null,
      sourceLabel,
      contentState,
      kind: 'plain',
    }
  }
  try {
    const parsed = JSON.parse(item.content) as {
      description?: string
      parameters?: { properties?: Record<string, unknown>; required?: string[] }
    }
    const required = new Set(parsed.parameters?.required ?? [])
    return {
      itemId: item.id,
      category: 'tools',
      label: item.name,
      preview: readableContextText(parsed.description ?? '未提供工具详情。'),
      content: JSON.stringify(parsed, null, 2),
      tokenEstimate: null,
      sourceLabel,
      contentState,
      kind: 'tool',
      toolParameters: Object.entries(parsed.parameters?.properties ?? {}).map(
        ([name, schema]) => ({
          name,
          type: schemaType(schema),
          required: required.has(name),
          description: readableContextText(
            typeof (schema as { description?: unknown }).description === 'string'
              ? (schema as { description: string }).description
              : '未提供参数说明。',
          ),
        }),
      ),
    }
  } catch {
    return {
      itemId: item.id,
      category: 'tools',
      label: item.name,
      preview: '工具定义无法解析，可在详情中查看保存的原文。',
      content: readableContextText(item.content),
      tokenEstimate: null,
      sourceLabel,
      contentState,
      kind: 'tool',
      toolParameters: [],
    }
  }
}
