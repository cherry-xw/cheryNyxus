/**
 * approvalPresentation 工具单测。
 *
 * 覆盖关键信息（keyFacts）投影：
 * - 技能加载 = 工具名称 + 技能名称（用户核心诉求：权重最高的两条核对信息）
 * - 各工具类型按自身目标字段投影关键信息
 * - role/roleName 等别名同标签只保留第一条有值的
 * - 未声明关键信息的工具（含未知自定义工具）回退空列表 → ApprovalSummary 走通用能力/行为/对象
 * - title / toolLabel / operationLabel 等既有契约不变
 */
import { describe, it, expect } from 'vitest'
import { createApprovalPresentation } from '@/utils/approvalPresentation'

describe('createApprovalPresentation 关键信息（keyFacts）', () => {
  it('技能加载：关键信息 = 工具名称 + 技能名称', () => {
    const p = createApprovalPresentation('skill', { name: 'code-review-skill' })
    expect(p.title).toBe('大模型需要加载技能')
    expect(p.keyFacts).toEqual([
      { label: '工具名称', value: '技能管理' },
      { label: '技能名称', value: 'code-review-skill' },
    ])
  })

  it('文件读取：关键信息 = 工具名称 + 文件路径', () => {
    const p = createApprovalPresentation('read_file', { path: 'src/index.ts' })
    expect(p.keyFacts).toEqual([
      { label: '工具名称', value: '文件读取' },
      { label: '文件路径', value: 'src/index.ts' },
    ])
  })

  it('命令执行：关键信息 = 工具名称 + 命令内容 + 用途说明', () => {
    const p = createApprovalPresentation('execute_command', {
      command: 'pnpm test',
      description: '运行测试',
    })
    expect(p.keyFacts).toEqual([
      { label: '工具名称', value: '命令执行' },
      { label: '命令内容', value: 'pnpm test' },
      { label: '用途说明', value: '运行测试' },
    ])
  })

  it('角色验收：roleName 与 role 同标签只保留第一条有值的', () => {
    const p = createApprovalPresentation('role_acceptance', {
      roleName: 'reviewer',
      role: 'fallback-role',
    })
    expect(p.keyFacts).toEqual([
      { label: '工具名称', value: '角色验收' },
      { label: '角色名称', value: 'reviewer' },
    ])
  })

  it('缺参的字段被跳过：skill 无 name 时只剩工具名称', () => {
    const p = createApprovalPresentation('skill', {})
    expect(p.keyFacts).toEqual([{ label: '工具名称', value: '技能管理' }])
  })

  it('未声明关键信息的工具回退空列表（通用能力/行为/对象由 ApprovalSummary 承担）', () => {
    const p = createApprovalPresentation('some_custom_tool', { foo: 'bar' })
    expect(p.keyFacts).toEqual([])
    expect(p.toolLabel).toBe('some_custom_tool')
    expect(p.operationLabel).toBe('执行「some_custom_tool」操作')
  })

  it('config_manage 走通用回退：无关键信息，保留行为与变更契约', () => {
    const p = createApprovalPresentation('config_manage', {
      action: 'patch',
      operations: [{ op: 'putRole', name: 'assistant' }],
    })
    expect(p.keyFacts).toEqual([])
    expect(p.operationLabel).toBe('修改配置参数')
    expect(p.changes.length).toBeGreaterThan(0)
  })
})
