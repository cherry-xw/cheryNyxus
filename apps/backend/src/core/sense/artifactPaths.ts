import { dirname, basename, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Custom Sense artifacts belong to the Backend, not the launcher's cwd.
 * Source execution uses apps/backend/dist; the single-file bundle uses its own
 * directory (apps/backend/dist in the Backend image).
 */
export function resolveSenseArtifactPaths(moduleUrl: string = import.meta.url): {
  distDir: string
  sensesDir: string
  tempDir: string
} {
  const here = dirname(fileURLToPath(moduleUrl))
  const sourceTree = basename(here) === 'sense'
    && basename(dirname(here)) === 'core'
    && basename(dirname(dirname(here))) === 'src'
  const distDir = sourceTree ? resolve(here, '../../..', 'dist') : here
  return {
    distDir,
    sensesDir: join(distDir, 'senses'),
    tempDir: join(distDir, '.sense-temp'),
  }
}
