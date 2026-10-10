#!/usr/bin/env node
/** Persistent user crontab: validate before atomic replacement. */
import {mkdir, readFile, open, rename, unlink} from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {pathToFileURL} from 'node:url'

export async function updateCrontab(content, {home = process.env.HOME, supercronic = process.env.CHERY_SUPERCRONIC || '/usr/local/bin/supercronic'} = {}) {
  if (!home) throw new Error('HOME is required')
  const root = path.join(home, 'scheduler')
  await mkdir(root, {recursive: true, mode: 0o700})
  const temporary = path.join(root, `.crontab-${randomUUID()}`)
  let child, interrupted = false
  const stop = signal => { interrupted = true; child?.kill(signal) }
  const term = () => stop('SIGTERM')
  const interrupt = () => stop('SIGINT')
  process.on('SIGTERM', term)
  process.on('SIGINT', interrupt)
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(content); await file.sync() } finally { await file.close() }
    await new Promise((resolve, reject) => {
      child = spawn(supercronic, ['-test', temporary], {stdio: 'inherit'})
      child.once('error', reject)
      child.once('close', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error('Crontab validation failed')))
    })
    if (interrupted) throw new Error('Crontab update interrupted')
    await rename(temporary, path.join(root, 'crontab'))
    const directory = await open(root, 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally {
    process.off('SIGTERM', term); process.off('SIGINT', interrupt)
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

async function main(args) {
  if (!process.env.HOME) throw new Error('HOME is required')
  if (args.length === 1 && args[0] === '-l') {
    try { process.stdout.write(await readFile(path.join(process.env.HOME, 'scheduler/crontab'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    return
  }
  if (args.length !== 1) throw new Error('Usage: crontab -l | -r | - | FILE')
  let content = ''
  if (args[0] === '-') { for await (const chunk of process.stdin) content += chunk.toString() }
  else if (args[0] !== '-r') content = await readFile(args[0], 'utf8')
  await updateCrontab(content)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
