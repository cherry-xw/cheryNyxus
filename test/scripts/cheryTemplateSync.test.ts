import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'
import { ensureEnvSeed, syncCheryTemplate } from '../../scripts/lib/chery-template-sync.mjs'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'chery-template-sync-'))
  roots.push(root)
  return root
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function baseConfig(brain = 'user-brain'): Record<string, unknown> {
  return {
    global: { supervision: 'smart' },
    llm: { brain: { [brain]: { provider: 'openai', model: 'test' } } },
    sense_groups: { chery_nexus: ['skill'], curator: ['read_file'] },
    roles: {
      cheryNyxus: { brain, senseGroup: 'chery_nexus', lock: true },
      curator: { brain, senseGroup: 'curator', lock: true },
    },
    presets: { cheryNyxus: { leader: 'cheryNyxus', roles: ['cheryNyxus', 'curator'] } },
    server: { port: 8182, webPort: 8183 },
  }
}

function writeTemplate(root: string, prompt = 'template-v1'): string {
  const template = join(root, '.chery.template')
  write(join(template, 'prompt', 'cheryNyxus', 'cheryNyxus.md'), prompt)
  write(join(template, 'skills', 'role-design', 'SKILL.md'), 'role design')
  const config = baseConfig('my-brain') as any
  config.sense_groups.role_architect = ['skill', 'read_file']
  config.sense_groups.role_acceptance = ['skill']
  config.sense_groups.chery_nexus.push('config_manage', 'role_acceptance')
  config.roles.roleArchitect = {
    brain: 'my-brain',
    senseGroup: 'role_architect',
    systemPrompt: 'prompt/roleArchitect/roleArchitect.md',
  }
  config.roles.roleAcceptance = {
    brain: 'my-brain',
    senseGroup: 'role_acceptance',
    systemPrompt: 'prompt/roleAcceptance/roleAcceptance.md',
  }
  write(join(template, 'config.yaml'), yaml.dump(config))
  return template
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('syncCheryTemplate', () => {
  it('creates a fresh runtime copy and records managed hashes', () => {
    const root = tempRoot()
    const templateDir = writeTemplate(root)
    const runtimeRoot = join(root, 'runtime')
    const report = syncCheryTemplate({ templateDir, runtimeRoot })

    expect(report.created).toBe(true)
    expect(readFileSync(join(runtimeRoot, '.chery', 'skills', 'role-design', 'SKILL.md'), 'utf8')).toBe(
      'role design',
    )
    const manifest = JSON.parse(
      readFileSync(join(runtimeRoot, '.chery', '.template-manifest.json'), 'utf8'),
    )
    expect(manifest.files['skills/role-design/SKILL.md']).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.files['config.yaml']).toBeUndefined()
  })

  it('updates managed files, keeps user modifications and respects user deletion', () => {
    const root = tempRoot()
    const templateDir = writeTemplate(root)
    const runtimeRoot = join(root, 'runtime')
    syncCheryTemplate({ templateDir, runtimeRoot })

    write(join(templateDir, 'skills', 'role-design', 'SKILL.md'), 'role design v2')
    write(join(runtimeRoot, '.chery', 'prompt', 'cheryNyxus', 'cheryNyxus.md'), 'user prompt')
    rmSync(join(runtimeRoot, '.chery', 'skills', 'role-design', 'SKILL.md'))
    const report = syncCheryTemplate({ templateDir, runtimeRoot })

    expect(report.preserved).toEqual(
      expect.arrayContaining([
        { path: 'prompt/cheryNyxus/cheryNyxus.md', reason: 'user-modified' },
        { path: 'skills/role-design/SKILL.md', reason: 'user-deleted' },
      ]),
    )
    expect(readFileSync(join(runtimeRoot, '.chery', 'prompt', 'cheryNyxus', 'cheryNyxus.md'), 'utf8')).toBe(
      'user prompt',
    )
  })

  it('updates unchanged managed files and creates a recovery copy', () => {
    const root = tempRoot()
    const templateDir = writeTemplate(root)
    const runtimeRoot = join(root, 'runtime')
    syncCheryTemplate({ templateDir, runtimeRoot })
    write(join(templateDir, 'skills', 'role-design', 'SKILL.md'), 'role design v2')

    const report = syncCheryTemplate({ templateDir, runtimeRoot })

    expect(report.updated).toContain('skills/role-design/SKILL.md')
    expect(readFileSync(join(runtimeRoot, '.chery', 'skills', 'role-design', 'SKILL.md'), 'utf8')).toBe(
      'role design v2',
    )
    const backupStamps = readdirSync(join(runtimeRoot, '.chery', 'backups', 'template'))
    expect(backupStamps).toHaveLength(1)
    expect(
      readFileSync(
        join(
          runtimeRoot,
          '.chery',
          'backups',
          'template',
          backupStamps[0]!,
          'skills',
          'role-design',
          'SKILL.md',
        ),
        'utf8',
      ),
    ).toBe('role design')
    expect(report.warnings).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('refuses a symlinked runtime .chery root', () => {
    const root = tempRoot()
    const templateDir = writeTemplate(root)
    const runtimeRoot = join(root, 'runtime')
    const externalRoot = join(root, 'external')
    mkdirSync(runtimeRoot, { recursive: true })
    mkdirSync(externalRoot, { recursive: true })
    write(join(externalRoot, 'sentinel.txt'), 'untouched')
    symlinkSync(externalRoot, join(runtimeRoot, '.chery'), 'dir')

    const report = syncCheryTemplate({ templateDir, runtimeRoot })

    expect(report.warnings).toEqual([
      `运行时 .chery 不是可同步的真实目录：${join(runtimeRoot, '.chery')}`,
    ])
    expect(readFileSync(join(externalRoot, 'sentinel.txt'), 'utf8')).toBe('untouched')
    expect(readdirSync(externalRoot)).toEqual(['sentinel.txt'])
  })

  it('refuses a non-directory runtime .chery root', () => {
    const root = tempRoot()
    const templateDir = writeTemplate(root)
    const runtimeRoot = join(root, 'runtime')
    write(join(runtimeRoot, '.chery'), 'not a directory')

    const report = syncCheryTemplate({ templateDir, runtimeRoot })

    expect(report.warnings).toEqual([
      `运行时 .chery 不是可同步的真实目录：${join(runtimeRoot, '.chery')}`,
    ])
    expect(readFileSync(join(runtimeRoot, '.chery'), 'utf8')).toBe('not a directory')
  })

  it('migrates only missing built-ins and keeps the user brain and custom resources', () => {
    const root = tempRoot()
    const templateDir = writeTemplate(root)
    const runtimeRoot = join(root, 'runtime')
    write(join(runtimeRoot, '.chery', 'config.yaml'), yaml.dump(baseConfig()))
    write(join(runtimeRoot, '.chery', 'prompt', 'cheryNyxus', 'cheryNyxus.md'), 'custom prompt')

    const report = syncCheryTemplate({ templateDir, runtimeRoot })
    const config = yaml.load(readFileSync(join(runtimeRoot, '.chery', 'config.yaml'), 'utf8')) as any

    expect(report.configMigrated).toBe(true)
    expect(config.roles.roleArchitect.brain).toBe('user-brain')
    expect(config.roles.roleAcceptance.brain).toBe('user-brain')
    expect(config.presets.cheryNyxus.roles).toEqual([
      'cheryNyxus',
      'curator',
      'roleArchitect',
      'roleAcceptance',
    ])
    expect(config.sense_groups.chery_nexus).toEqual(['skill', 'config_manage', 'role_acceptance'])
    expect(readFileSync(join(runtimeRoot, '.chery', 'prompt', 'cheryNyxus', 'cheryNyxus.md'), 'utf8')).toBe(
      'custom prompt',
    )
  })

  it('preserves supervision-qualified built-in senses without adding duplicates', () => {
    const root = tempRoot()
    const templateDir = writeTemplate(root)
    const runtimeRoot = join(root, 'runtime')
    const config = baseConfig() as any
    config.sense_groups.chery_nexus = ['skill', 'config_manage:auto', 'role_acceptance:manual']
    write(join(runtimeRoot, '.chery', 'config.yaml'), yaml.dump(config))

    syncCheryTemplate({ templateDir, runtimeRoot })
    const migrated = yaml.load(
      readFileSync(join(runtimeRoot, '.chery', 'config.yaml'), 'utf8'),
    ) as any

    expect(migrated.sense_groups.chery_nexus).toEqual([
      'skill',
      'config_manage:auto',
      'role_acceptance:manual',
    ])
  })

  it('seeds .env once without overwriting user values', () => {
    const root = tempRoot()
    const example = join(root, '.env.example')
    const runtimeRoot = join(root, 'runtime')
    write(example, 'API_KEY=\n')
    expect(ensureEnvSeed({ envExamplePath: example, runtimeRoot }).created).toBe(true)
    write(join(runtimeRoot, '.env'), 'API_KEY=user-secret\n')
    expect(ensureEnvSeed({ envExamplePath: example, runtimeRoot }).created).toBe(false)
    expect(readFileSync(join(runtimeRoot, '.env'), 'utf8')).toBe('API_KEY=user-secret\n')
  })
})
