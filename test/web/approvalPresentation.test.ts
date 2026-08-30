import { describe, expect, it } from 'vitest'
import {
  createApprovalPresentation,
  formatApprovalArgumentScalar,
  toArgumentKeyLabel,
} from '../../web/src/utils/approvalPresentation'

describe('approval presentation', () => {
  it('describes config reads in user language while retaining the technical action', () => {
    const view = createApprovalPresentation('config_manage', '{"action":"get"}')
    expect(view).toMatchObject({
      title: '大模型需要获取配置参数',
      toolLabel: '配置管理',
      operationLabel: '获取配置参数',
      actorLabel: '大模型发起',
      approvalLabel: '由你审批后执行',
    })
    expect(formatApprovalArgumentScalar('action', 'get')).toBe('获取配置参数（get）')
  })

  it('includes a useful target for ordinary tools', () => {
    const view = createApprovalPresentation('read_file', { path: 'E:/work/spec.md' })
    expect(view.title).toBe('大模型需要读取文件')
    expect(view.summary).toContain('E:/work/spec.md')
    expect(view.toolLabel).toBe('文件读取')
  })

  it('falls back safely for custom tools and localizes common argument keys', () => {
    const view = createApprovalPresentation('custom_fetch', '{not-json')
    expect(view.title).toContain('custom_fetch')
    expect(view.summary).toContain('批准后才会执行')
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
