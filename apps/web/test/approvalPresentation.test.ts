import { describe, expect, it } from 'vitest'
import {
  createApprovalPresentation,
  formatApprovalArgumentScalar,
  toArgumentKeyLabel,
} from '../src/utils/approvalPresentation'

describe('approval presentation', () => {
  it('describes config reads in user language while retaining the technical action', () => {
    const view = createApprovalPresentation('config_manage', '{"action":"get"}')
    // 审批卡精简后（8ab1ba60）：actor/approval 固定文案由审批卡模板统一承载，呈现工具不再返回。
    expect(view).toMatchObject({
      title: '大模型需要获取配置参数',
      toolLabel: '配置管理',
      operationLabel: '获取配置参数',
    })
    expect(formatApprovalArgumentScalar('action', 'get')).toBe('获取配置参数（get）')
  })

  it('includes a useful target for ordinary tools', () => {
    const view = createApprovalPresentation('read_file', { path: 'E:/work/spec.md' })
    expect(view.title).toBe('大模型需要读取文件')
    // 审批卡精简后（8ab1ba60）：总结句改为结构化 target + keyFacts。
    expect(view.target).toBe('E:/work/spec.md')
    expect(view.keyFacts).toEqual([
      { label: '工具名称', value: '文件读取' },
      { label: '文件路径', value: 'E:/work/spec.md' },
    ])
    expect(view.toolLabel).toBe('文件读取')
  })

  it('falls back safely for custom tools and localizes common argument keys', () => {
    const view = createApprovalPresentation('custom_fetch', '{not-json')
    expect(view.title).toContain('custom_fetch')
    // 未知自定义工具未声明关键信息 → 空列表，由审批卡通用面（标题/工具名/操作）兜底。
    expect(view.keyFacts).toEqual([])
    expect(toArgumentKeyLabel('baseRevision')).toBe('配置版本')
    expect(toArgumentKeyLabel('custom_field')).toBe('custom field')
  })

  it('makes each config patch understandable without reading raw operations', () => {
    const view = createApprovalPresentation(
      'config_manage',
      '{"action":"patch","operations":[{"op":"putRole","name":"reviewer","role":{"brain":"gpt-5"}}]}',
    )
    expect(view.operationLabel).toBe('修改配置参数')
    expect(view.changes).toEqual([
      { label: '角色配置', detail: '将角色“reviewer”使用模型“gpt-5”' },
    ])
  })
})
