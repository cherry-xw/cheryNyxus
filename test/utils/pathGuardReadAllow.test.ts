/**
 * pathGuard allowConfigRead 单测：checkCheryGuard 读放行语义。
 *
 * 契约（docs/agent/middleware.md「路径守卫」）：
 *  - allowConfigRead = 配置管理核心角色（senseTable 含 config_manage/install_skill）对 read_file/
 *    search_codebase 读 .chery/ 全树放行（按工具名旁路）
 *  - write_file/execute_command 不受影响（写仍拦）；allowRuleDir 豁免 .chery/rule/ 不回归
 *  - 非配置管理角色（无 opts）守卫保持现状
 * 纯逻辑测试（相对路径走正则分支，resolve 不触盘，无 CHERY_DIR 依赖）。
 */
import { describe, it, expect } from 'vitest'
import { checkCheryGuard, CHERY_GUARD_MESSAGE, GUARD_EXEMPT } from '@/utils/pathGuard.js'

describe('checkCheryGuard allowConfigRead（配置管理角色读放行）', () => {
  it('read_file .chery/config.yaml + allowConfigRead → 放行（null）', () => {
    expect(
      checkCheryGuard('read_file', { path: '.chery/config.yaml' }, { allowConfigRead: true }),
    ).toBeNull()
  })

  it('search_codebase + allowConfigRead → 放行', () => {
    expect(
      checkCheryGuard('search_codebase', { path: '.chery/prompt' }, { allowConfigRead: true }),
    ).toBeNull()
  })

  it('write_file .chery/x + allowConfigRead → 仍拦（写不受读放行影响）', () => {
    expect(
      checkCheryGuard('write_file', { path: '.chery/x.txt' }, { allowConfigRead: true }),
    ).toBe(CHERY_GUARD_MESSAGE)
  })

  it('execute_command cat .chery/... + allowConfigRead → 仍拦（决策锚点）', () => {
    expect(
      checkCheryGuard('execute_command', { command: 'cat .chery/config.yaml' }, { allowConfigRead: true }),
    ).toBe(CHERY_GUARD_MESSAGE)
  })

  it('write_file .chery/rule/x.yaml + allowConfigRead+allowRuleDir → 放行（rule 豁免不回归）', () => {
    expect(
      checkCheryGuard('write_file', { path: '.chery/rule/chat.yaml' }, { allowConfigRead: true, allowRuleDir: true }),
    ).toBeNull()
  })

  it('write_file .chery/x + allowRuleDir（非 rule 目录）→ 仍拦', () => {
    expect(
      checkCheryGuard('write_file', { path: '.chery/x.txt' }, { allowRuleDir: true }),
    ).toBe(CHERY_GUARD_MESSAGE)
  })

  it('非配置管理角色（无 opts）+ read_file .chery/x → 仍拦（其他角色守卫不回归）', () => {
    expect(checkCheryGuard('read_file', { path: '.chery/config.yaml' })).toBe(CHERY_GUARD_MESSAGE)
  })

  it('GUARD_EXEMPT（install_skill）不受 opts 影响 → 放行', () => {
    expect(GUARD_EXEMPT.has('install_skill')).toBe(true)
    expect(checkCheryGuard('install_skill', { path: '.chery/skills/x' }, { allowConfigRead: false })).toBeNull()
  })

  it('read_file 非 .chery 路径 + allowConfigRead → 放行（正常读不受守卫）', () => {
    expect(checkCheryGuard('read_file', { path: 'notes.txt' }, { allowConfigRead: true })).toBeNull()
    expect(checkCheryGuard('read_file', { path: 'notes.txt' })).toBeNull()
  })
})
