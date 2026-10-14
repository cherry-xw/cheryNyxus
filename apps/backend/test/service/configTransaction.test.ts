import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { configRevision, replaceConfigText, withConfigTransaction, withConfigTransactionSync } from '../../src/utils/configTransaction.js'

describe('F01 shared cross-process config transaction', () => {
  it('rejects inherited async callbacks after their transaction has released the lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nyxus-expired-transaction-'))
    const file = join(root, 'config.yaml'); await writeFile(file, 'manager: original\n')
    let release!: () => void; let later!: Promise<void>
    const gate = new Promise<void>((resolve) => { release = resolve })
    try {
      await withConfigTransaction(file, async () => {
        later = gate.then(() => { replaceConfigText(file, 'manager: stale\n', 'manager: original\n') })
      })
      release()
      await expect(later).rejects.toThrow('requires shared transaction')
      expect(await readFile(file, 'utf8')).toBe('manager: original\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('serializes independent writers and refuses a nonparticipating stale CAS without changing identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nyxus-transaction-'))
    const file = join(root, 'config.json')
    await writeFile(file, JSON.stringify({ manager: { account: 'preserved' }, a: 0, b: 0 }))
    const module = pathToFileURL(resolve('apps/backend/src/utils/configTransaction.ts')).href
    const work = (key: string) => new Promise<void>((done, reject) => {
      const code = `import fs from 'node:fs'; import {withConfigTransaction,replaceConfigText} from ${JSON.stringify(module)}; const file=${JSON.stringify(file)}; for(let i=0;i<10;i++) await withConfigTransaction(file,async()=>{const text=fs.readFileSync(file,'utf8');const value=JSON.parse(text);value[${JSON.stringify(key)}]++;await new Promise(r=>setTimeout(r,2));replaceConfigText(file,JSON.stringify(value),text)});`
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] })
      let errors = ''; child.stderr.on('data', (data) => errors += data)
      child.once('error', reject); child.once('exit', (exit) => exit === 0 ? done() : reject(new Error(errors)))
    })
    try {
      await Promise.all([work('a'), work('b')])
      const text = await readFile(file, 'utf8')
      expect(JSON.parse(text)).toEqual({ manager: { account: 'preserved' }, a: 10, b: 10 })
      expect(() => withConfigTransactionSync(file, () => replaceConfigText(file, '{}', 'stale'))).toThrow('revision conflict')
      expect(configRevision(await readFile(file, 'utf8'))).toBe(configRevision(text))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
