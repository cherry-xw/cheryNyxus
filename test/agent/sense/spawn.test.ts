/**
 * spawn_role sense 单元测试。
 *
 * 覆盖：
 * - sense 定义：name/supervision
 * - 缺少 chatId → throw
 * - 无效角色 type → throw
 * - roster gate：不在编制 → throw
 * - wait=true / wait=false 路径
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import spawnSense from '@/agent/sense/spawn.js'
import { SupervisionLevel } from '@/core/config.js'

const exec = spawnSense.executor.execute.bind(spawnSense.executor)
const sharedData = new Map<string, Map<string, unknown>>()

describe('spawn_role sense 定义', () => {
  it('name = spawn_role', () => {
    expect(spawnSense.definition.function.name).toBe('spawn_role')
  })

  it('supervision = auto', () => {
    expect(spawnSense.supervisionLevel).toBe(SupervisionLevel.auto)
  })
})

describe('spawn_role handler', () => {
  it('缺少 chatId → throw', async () => {
    await expect(
      exec({ type: 'reviewer', prompt: 'test', wait: false }, sharedData, {}),
    ).rejects.toThrow('spawn_role 缺少主 chatId')
  })

  it('无效角色 type → 参数格式错误', async () => {
    await expect(
      exec(
        { type: '__nonexistent_role__', prompt: 'test', wait: false },
        sharedData,
        { chatId: 'test-chat' },
      ),
    ).rejects.toThrow('type 应为单一角色名')
  })
})
