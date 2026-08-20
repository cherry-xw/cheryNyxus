import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Electron graphics policy', () => {
  it('defaults to hardware composition and persists a GPU-crash fallback', async () => {
    const source = await readFile(resolve('web/electron/main.ts'), 'utf8')

    expect(source).not.toContain('\napp.disableHardwareAcceleration()\n')
    expect(source).toContain(
      "const graphicsMode: GraphicsMode = forceSoftware || gpuSafeModeActive ? 'software' : 'hardware'",
    )
    expect(source).toContain("if (graphicsMode === 'software') app.disableHardwareAcceleration()")
    expect(source).toContain("details.type.toLowerCase() === 'gpu'")
    expect(source).toContain('!isQuitting &&')
    expect(source).toContain('recordGpuSafeMode(`${details.type}:${details.reason}`)')
    expect(source).toContain('const rendererParams = { ...params, graphicsMode }')
  })
})
