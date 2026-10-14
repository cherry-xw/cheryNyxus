import fs from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const transactionSnapshots = new AsyncLocalStorage()
export function transactionExpectedText(file) {
  const snapshot = transactionSnapshots.getStore()
  if (!snapshot || !snapshot.active || snapshot.file !== path.resolve(file)) throw new Error('Configuration write requires shared transaction')
  return snapshot.text
}
export function configRevision(text) { return createHash('sha256').update(text).digest('hex') }
function acquire(file) {
  const lock = `${path.resolve(file)}.transaction-lock`
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  fs.mkdirSync(lock, { mode: 0o700 })
  return () => fs.rmdirSync(lock)
}
export function withConfigTransactionSync(file, operation) {
  const key = path.resolve(file)
  const inherited = transactionSnapshots.getStore()
  if (inherited?.active && inherited.file === key && inherited.synchronous) return operation()
  const release = acquire(file)
  const snapshot = { file: key, text: '', active: true, synchronous: true }
  try {
    snapshot.text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    return transactionSnapshots.run(snapshot, operation)
  } finally { snapshot.active = false; release() }
}
export async function withConfigTransaction(file, operation) {
  const deadline = Date.now() + 5000
  let release
  while (!release) {
    try { release = acquire(file) } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('Configuration transaction unavailable')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const snapshot = { file: path.resolve(file), text: '', active: true, synchronous: false }
  try {
    snapshot.text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    return await transactionSnapshots.run(snapshot, operation)
  } finally { snapshot.active = false; release() }
}
export function replaceConfigText(file, text, expectedText) {
  transactionExpectedText(file)
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (configRevision(current) !== configRevision(expectedText)) throw new Error('Configuration revision conflict')
  const temporary = `${file}.transaction-${randomUUID()}`
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, text); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined
    const latest = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (configRevision(latest) !== configRevision(expectedText)) throw new Error('Configuration revision conflict')
    fs.renameSync(temporary, file)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}
