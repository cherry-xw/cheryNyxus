#!/usr/bin/env node
/** Stop both process groups on signal, spawn error or either child's exit. */
import {mkdir, open} from 'node:fs/promises'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {pathToFileURL} from 'node:url'

export async function supervise({home = process.env.HOME, scheduler = process.env.CHERY_SUPERCRONIC || '/usr/local/bin/supercronic', backend = '/app/dist/index.js', graceMs = 30000} = {}) {
  if (!home) throw new Error('HOME is required')
  const root = path.join(home, 'scheduler')
  await mkdir(root, {recursive: true, mode: 0o700})
  const crontab = path.join(root, 'crontab')
  try { const file = await open(crontab, 'wx', 0o600); await file.close() }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  const children = []
  let stopping = false, timer, exitCode = 1
  const kill = signal => {
    for (const child of children) {
      if (!child.pid) continue
      try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') console.error(error.message) }
    }
  }
  const stop = (code = 1, signal = 'SIGTERM') => {
    if (stopping) return
    stopping = true; exitCode = code
    kill(signal)
    timer = setTimeout(() => kill('SIGKILL'), graceMs)
  }
  const term = () => stop(143, 'SIGTERM')
  const interrupt = () => stop(130, 'SIGINT')
  process.on('SIGTERM', term); process.on('SIGINT', interrupt)
  try {
    const launch = (command, args) => {
      const child = spawn(command, args, {stdio: 'inherit', detached: true})
      children.push(child)
      return new Promise(resolve => {
        child.once('error', error => { console.error(error.message); stop() })
        child.once('close', () => { stop(); resolve() })
      })
    }
    const pending = [launch(scheduler, ['-inotify', crontab]), launch(process.execPath, [backend])]
    await Promise.all(pending)
    return exitCode
  } finally {
    kill('SIGKILL')
    clearTimeout(timer)
    process.off('SIGTERM', term); process.off('SIGINT', interrupt)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  supervise().then(code => { process.exitCode = code }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
