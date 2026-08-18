/**
 * buildFirstSystemPrompt 测试（agent/prompt/index）。
 *
 * 构造首条 system prompt：<system-reminder>{system.md}</system-reminder> + <environment> + <skills>。
 * 复用 flows/fixtures/.chery/system.md（全局 setupFiles 已设 CHERY_DIR）。
 */
import { describe, it, expect } from 'vitest'
import buildFirstSystemPrompt from '@/agent/prompt/index.js'

describe('buildFirstSystemPrompt', () => {
  it('含 <system-reminder> 包裹 system.md 内容', () => {
    const prompt = buildFirstSystemPrompt()
    expect(prompt).toContain('<system-reminder>')
    expect(prompt).toContain('</system-reminder>')
    // system.md 内容在模块加载时缓存；若文件存在则非空，否则为空字符串
    // 只验证标签结构，不验证具体内容（内容依赖 CHERY_DIR 下 prompt/system.md 是否存在）
  })

  it('含 <environment> 块（OS / 日期 / 时间）', () => {
    const prompt = buildFirstSystemPrompt()
    expect(prompt).toContain('<environment>')
    expect(prompt).toContain('操作系统:')
    expect(prompt).toContain('当前日期:')
    expect(prompt).toContain('当前时间:')
  })

  it('含 <skills> 块（无 skills 时为空 section）', () => {
    const prompt = buildFirstSystemPrompt()
    expect(prompt).toContain('<skills>')
    expect(prompt).toContain('</skills>')
  })

  it('整体结构：system-reminder → environment → skills 顺序', () => {
    const prompt = buildFirstSystemPrompt()
    const reminderIdx = prompt.indexOf('<system-reminder>')
    const envIdx = prompt.indexOf('<environment>')
    const skillsIdx = prompt.indexOf('<skills>')
    expect(reminderIdx).toBeGreaterThanOrEqual(0)
    expect(envIdx).toBeGreaterThan(reminderIdx)
    expect(skillsIdx).toBeGreaterThan(envIdx)
  })

  it('仅多角色编制注入结构化 @角色编排说明', () => {
    const prompt = buildFirstSystemPrompt(undefined, undefined, undefined, [
      { name: 'plan', description: '拆解任务' },
      { name: 'reviewer', description: '审查实现' },
    ])
    expect(prompt).toContain('<role-mentions>')
    expect(prompt).toContain('@plan: 拆解任务')
    expect(prompt).toContain('[[role:@名称]]')
    expect(
      buildFirstSystemPrompt(undefined, undefined, undefined, [
        { name: 'plan', description: '拆解任务' },
      ]),
    ).not.toContain('<role-mentions>')
  })

  it('有已定稿代际时注入 <history_generations>（每代一行 + history_recall 提示）', () => {
    const prompt = buildFirstSystemPrompt(undefined, undefined, undefined, undefined, [
      {
        index: 1,
        summary: '第一段摘要'.repeat(60), // > 200 字符，验证截断
        nodeCount: 42,
        createdAt: new Date('2026-08-01T10:00:00Z').getTime(),
        trigger: 'manual',
      },
      {
        index: 2,
        summary: '第二段摘要',
        nodeCount: 7,
        createdAt: new Date('2026-08-10T10:00:00Z').getTime(),
        trigger: 'auto',
      },
    ])
    expect(prompt).toContain('<history_generations>')
    expect(prompt).toMatch(/第1代 \[手动\]/)
    expect(prompt).toMatch(/第2代 \[自动\]/)
    // 摘要截断到 200 字符：第1代行不超 200 + 行前缀余量
    const gen1Line = prompt.split('\n').find((line) => line.includes('第1代'))!
    expect(gen1Line.length).toBeLessThanOrEqual(300)
    expect(prompt).toContain('history_recall')
    // 段位置：environment 之后、skills 之前
    expect(prompt.indexOf('<history_generations>')).toBeGreaterThan(prompt.indexOf('<environment>'))
    expect(prompt.indexOf('<skills>')).toBeGreaterThan(prompt.indexOf('<history_generations>'))
  })

  it('无已定稿代际不注入 <history_generations>（零开销）', () => {
    expect(buildFirstSystemPrompt()).not.toContain('<history_generations>')
    expect(buildFirstSystemPrompt(undefined, undefined, undefined, undefined, [])).not.toContain(
      '<history_generations>',
    )
  })
})
