import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolveSenseArtifactPaths } from '@/core/sense/artifactPaths.js'

describe('Sense artifact paths', () => {
  it.each([
    ['/repo/apps/backend/src/core/sense/artifactPaths.ts', '/repo/apps/backend/dist'],
    ['/repo/apps/backend/dist/index.js', '/repo/apps/backend/dist'],
    ['/app/dist/index.js', '/app/dist'],
    ['/another-launch-directory/backend/dist/index.js', '/another-launch-directory/backend/dist'],
  ])('resolves %s independently of launcher cwd', (modulePath, distDir) => {
    expect(resolveSenseArtifactPaths(pathToFileURL(modulePath).href)).toEqual({
      distDir,
      sensesDir: `${distDir}/senses`,
      tempDir: `${distDir}/.sense-temp`,
    })
  })

  it('uses the backend dist for the actual source module', () => {
    const backendDir = new URL('../../../', import.meta.url)
    expect(resolveSenseArtifactPaths()).toEqual(
      resolveSenseArtifactPaths(new URL('dist/index.js', backendDir).href),
    )
  })
})
