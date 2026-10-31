import type { SourceContextItem } from '../../../packages/protocol/src/sourceManagement'

type SectionItem = Pick<SourceContextItem, 'itemId' | 'type'>
export type SourceInputSection<T extends SectionItem> = {
  key: string
  type: T['type']
  heading: string
  items: T[]
}

const headings: Record<SourceContextItem['type'], string> = {
  message: '输入消息',
  gap: '范围与省略说明',
  summary: '已采用摘要',
  data: '附加资料',
  tool_result: '本次工具过程',
  restricted: '内容受限',
}

export function groupSourceSections<T extends SectionItem>(items: readonly T[]): SourceInputSection<T>[] {
  const sections: SourceInputSection<T>[] = []
  for (const item of items) {
    const previous = sections.at(-1)
    if (previous?.type === item.type) previous.items.push(item)
    else sections.push({ key: `${item.type}:${item.itemId}`, type: item.type, heading: headings[item.type], items: [item] })
  }
  return sections
}
