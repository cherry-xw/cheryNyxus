import { expect, it } from 'vitest'
import { settingsNotices } from '../../src/features/agent/settings/model/settingsNotices'

it('counts only the entries shown in each category, including simultaneous warnings and errors', () => {
  const notices = settingsNotices({
    savedHint: '已保存',
    warnings: ['警告 A', '警告 B'],
    error: '保存失败',
  })
  expect(notices.filter((notice) => notice.kind === 'message')).toHaveLength(1)
  expect(notices.filter((notice) => notice.kind === 'warning')).toHaveLength(2)
  expect(notices.filter((notice) => notice.kind === 'error')).toHaveLength(1)
  expect(settingsNotices({ externalChange: true })[0]).toMatchObject({
    id: 'external',
    kind: 'warning',
  })
  expect(settingsNotices({})).toEqual([])
})
