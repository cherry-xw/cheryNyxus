import { readFile, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB_SOURCE_ROOT = resolve(import.meta.dirname, '../../src')
const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..')

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      return entry.isFile() && /\.(?:ts|tsx|vue)$/.test(entry.name) ? [path] : []
    }),
  )
  return nested.flat()
}

async function matchingFiles(
  directory: string,
  pattern: RegExp,
  ignore: (name: string) => boolean = () => false,
): Promise<string[]> {
  const matches: string[] = []
  for (const file of await sourceFiles(directory)) {
    const name = relative(WEB_SOURCE_ROOT, file).replaceAll('\\', '/')
    if (!ignore(name) && pattern.test(await readFile(file, 'utf8'))) matches.push(name)
  }
  return matches
}

describe('frontend architecture boundaries', () => {
  it('routes ordinary features through application public ports', async () => {
    const directInfrastructureImports = await matchingFiles(
      resolve(WEB_SOURCE_ROOT, 'features'),
      /(?:from\s+|import\s*)['"]@\/(?:stores|services)(?:\/[^'"]*)?['"]|import\(['"]@\/(?:stores|services)(?:\/[^'"]*)?['"]\)/,
      (name) => name === 'features/pets/nyxus/application/host.ts',
    )

    expect(directInfrastructureImports).toEqual([])
  })

  it('keeps services independent from application state and UI', async () => {
    const upwardImports = await matchingFiles(
      resolve(WEB_SOURCE_ROOT, 'services'),
      /(?:from\s+|import\s*)['"]@\/(?:application|stores|features)(?:\/[^'"]*)?['"]|import\(['"]@\/(?:application|stores|features)(?:\/[^'"]*)?['"]\)/,
    )

    expect(upwardImports).toEqual([])
  })

  it('keeps state owners independent from feature implementations', async () => {
    const featureImports = await matchingFiles(
      resolve(WEB_SOURCE_ROOT, 'stores'),
      /(?:from\s+|import\s*)['"]@\/features(?:\/[^'"]*)?['"]|import\(['"]@\/features(?:\/[^'"]*)?['"]\)/,
    )

    expect(featureImports).toEqual([])
  })

  it('keeps domain modules independent from application ports too', async () => {
    const applicationImports = await matchingFiles(
      resolve(WEB_SOURCE_ROOT, 'domain'),
      /(?:from\s+|import\s*)['"]@\/application(?:\/[^'"]*)?['"]|import\(['"]@\/application(?:\/[^'"]*)?['"]\)/,
    )

    expect(applicationImports).toEqual([])
  })

  it('keeps Nyxus store access inside its host adapter', async () => {
    const nyxusImports = await matchingFiles(
      resolve(WEB_SOURCE_ROOT, 'features/pets/nyxus'),
      /(?:from\s+|import\s*)['"]@\/stores(?:\/[^'"]*)?['"]|import\(['"]@\/stores(?:\/[^'"]*)?['"]\)/,
    )

    expect(nyxusImports).toEqual(['features/pets/nyxus/application/host.ts'])
  })

  it('keeps the canonical chat owner independent from the agents compatibility facade', async () => {
    const agentImports = await matchingFiles(
      resolve(WEB_SOURCE_ROOT, 'stores/chats'),
      /(?:from\s+|import\s*)['"](?:@\/stores\/agents|\.\.\/agents)(?:\/[^'"]*)?['"]|import\(['"](?:@\/stores\/agents|\.\.\/agents)(?:\/[^'"]*)?['"]\)/,
    )

    expect(agentImports).toEqual([])
  })

  it('does not expose legacy chat transport methods in the Web service', async () => {
    const source = await readFile(resolve(WEB_SOURCE_ROOT, 'services/agentApi.ts'), 'utf8')
    const legacyMethods = [
      'chat.send',
      'chat.resume',
      'chat.get',
      'chat.sync',
      'chat.attach',
      'chat.startSpawn',
      'chat.sendToChild',
    ]

    for (const method of legacyMethods) expect(source).not.toContain(`'${method}'`)
    for (const member of ['sendMessage', 'resumeChat', 'syncChat', 'attachChat', 'getHistory']) {
      expect(source).not.toMatch(new RegExp(`\\b${member}\\s*\\(`))
    }
  })

  it('does not register legacy chat routes on the backend router', async () => {
    const source = await readFile(resolve(REPOSITORY_ROOT, 'src/service/chat/handler.ts'), 'utf8')
    const legacyConstants = [
      'CHAT_SEND',
      'CHAT_RESUME',
      'CHAT_GET',
      'CHAT_SYNC',
      'CHAT_ATTACH',
      'CHAT_START_SPAWN',
      'CHAT_SEND_TO_CHILD',
    ]

    for (const method of legacyConstants) {
      expect(source).not.toMatch(new RegExp(`router\\.register\\(Method\\.${method}\\b`))
    }
  })
})
