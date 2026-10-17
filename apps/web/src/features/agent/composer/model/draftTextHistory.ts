/** 保存编辑器的有序文本表示；文件字节和服务调用不属于撤销操作。 */
export function createDraftTextHistory(initial = '', limit = 100) {
  let entries = [initial]
  let index = 0
  return {
    reset(value: string) { entries = [value]; index = 0 },
    record(value: string) {
      if (value === entries[index]) return
      entries = [...entries.slice(0, index + 1), value].slice(-limit)
      index = entries.length - 1
    },
    move(direction: -1 | 1): string | undefined {
      const next = index + direction
      if (next < 0 || next >= entries.length) return undefined
      index = next
      return entries[index]
    },
  }
}
