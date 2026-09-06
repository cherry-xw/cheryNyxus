import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigApplyState, ConfigImpact } from '@chery/protocol'
import { useConfigApplyStore } from '../../src/stores/configApply'
import {
  applyHeadline,
  destructiveTargetLabel,
  impactLabel,
  impactNextStep,
  previewRequiresConfirmation,
} from '../../src/features/agent/settings/config/applyPresentation'
import {
  externalRevisionAction,
  isRevisionConflict,
} from '../../src/features/agent/settings/config/revisionSync'

const api = vi.hoisted(() => ({ getConfigApplyState: vi.fn() }))
vi.mock('../../src/services/agentApi', () => ({ agentApi: api }))

const applied: ConfigApplyState = {
  protocolVersion: 2,
  savedRevision: 'config-2',
  appliedRevision: 'config-2',
  status: 'applied',
  impacts: [],
  restart: { required: false, status: 'none' },
}

describe('configuration apply state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    api.getConfigApplyState.mockReset()
  })

  it('keeps the last valid state when an old server sends an incompatible contract', () => {
    const store = useConfigApplyStore()
    expect(store.apply(applied)).toBe(true)
    expect(store.apply({ ...applied, protocolVersion: 1 })).toBe(false)
    expect(store.state).toEqual(applied)
    expect(store.error).toContain('升级客户端')
  })

  it('coalesces reconnect status reads and adopts the authoritative state', async () => {
    let resolve!: (state: ConfigApplyState) => void
    api.getConfigApplyState.mockReturnValue(
      new Promise<ConfigApplyState>((done) => {
        resolve = done
      }),
    )
    const store = useConfigApplyStore()
    const first = store.refresh()
    const second = store.refresh()
    expect(api.getConfigApplyState).toHaveBeenCalledTimes(1)
    resolve(applied)
    await Promise.all([first, second])
    expect(store.state?.savedRevision).toBe('config-2')
  })

  it('presents resources, waiting work and failures without internal boundary terms', () => {
    const impact: ConfigImpact = {
      resource: '["roles","reviewer"]',
      paths: ['/roles/reviewer/brain'],
      semanticPaths: ['/roles/reviewer/brain'],
      semantic: true,
      boundary: 'tree',
      status: 'pending',
      reason: '正在运行的会话会先完成当前工作',
      affectedRootChatIds: ['chat-1'],
      appliedRevision: 'config-1',
    }
    expect(impactLabel(impact)).toBe('角色 / reviewer')
    expect(destructiveTargetLabel('presets/team-a')).toBe('预设 / team-a')
    expect(
      previewRequiresConfirmation({
        protocolVersion: 2,
        baseRevision: 'config-1',
        previewToken: 'preview-1',
        impacts: [{ ...impact, paths: ['/roles/reviewer/permissions/write'] }],
        destructiveTargets: [],
        policy: 'wait',
      }),
    ).toBe(true)
    expect(impactNextStep(impact)).toContain('等待受影响任务')
    expect(impactNextStep(impact)).not.toContain('tree')
    expect(applyHeadline({ ...applied, status: 'failed', impacts: [impact] })).toContain('生效失败')
  })
})

describe('settings revision synchronization', () => {
  it('reloads clean drafts and preserves dirty or saving drafts', () => {
    const base = { revision: 'config-2', baseRevision: 'config-1' }
    expect(externalRevisionAction({ ...base, dirty: false, saving: false })).toBe('reload')
    expect(externalRevisionAction({ ...base, dirty: true, saving: false })).toBe('preserve')
    expect(externalRevisionAction({ ...base, dirty: false, saving: true })).toBe('preserve')
    expect(
      externalRevisionAction({
        revision: 'config-1',
        baseRevision: 'config-1',
        dirty: true,
        saving: false,
      }),
    ).toBe('ignore')
    expect(isRevisionConflict('baseRevision 已过期：请重新读取后保存')).toBe(true)
  })

  it('wires server notifications, draft protection and explicit reload controls', async () => {
    const root = resolve(import.meta.dirname, '../../src')
    const [runtime, controller, dialog] = await Promise.all([
      readFile(resolve(root, 'application/runtime/startApplicationRuntime.ts'), 'utf8'),
      readFile(resolve(root, 'features/agent/settings/useSettingsDialogController.ts'), 'utf8'),
      readFile(resolve(root, 'features/agent/settings/SettingsDialog.vue'), 'utf8'),
    ])
    expect(runtime).toContain("event?.type === 'config.apply.changed'")
    expect(runtime).toContain('configApply.refresh()')
    expect(controller).toContain('hasUnsavedChanges.value')
    expect(controller).toContain('externalChange.value = true')
    expect(dialog).toContain('当前未保存草稿仍保留')
    expect(dialog).toContain('重新载入服务器版本')
    expect(dialog).toContain('<ConfigApplyStatus :preview="destructivePreview" />')
  })
})
