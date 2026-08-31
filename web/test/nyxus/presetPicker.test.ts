import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Nyxus preset picker regressions', () => {
  it('loads bootstrap config through the Electron-safe platform channel', async () => {
    const api = await readFile(resolve('web/src/services/agentApi.ts'), 'utf8')
    const fetchConfig = api.slice(
      api.indexOf('export async function fetchServerConfig'),
      api.indexOf('\n}', api.indexOf('export async function fetchServerConfig')) + 2,
    )

    expect(fetchConfig).toContain('getServerConfig({ refresh: true })')
    expect(fetchConfig).not.toContain("fetch(httpUrl('/api/config')")
  })

  it('never turns a missing or failed preset catalog into an invalid brain-only chat', async () => {
    const picker = await readFile(
      resolve('web/src/features/agent/toolbar/PresetPicker.vue'),
      'utf8',
    )
    const core = await readFile(
      resolve('web/src/features/pets/nyxus/components/NyxusCore.vue'),
      'utf8',
    )

    expect(picker).toContain('预设列表加载失败')
    expect(picker).toContain('暂无预设，请先在设置中添加预设')
    expect(picker).not.toContain("emit('fallback')")
    expect(core).not.toContain('createFallback')
    expect(core).not.toContain("senseGroup: ''")
  })
})
