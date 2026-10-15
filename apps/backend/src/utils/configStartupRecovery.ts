import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import yaml from 'js-yaml'
import { configRecord, mergeBackendConfig } from './configOwnership.js'
import { replaceConfigText, withConfigTransactionSync } from './configTransaction.js'

/** Startup recovery obeys the same ownership boundary as the live watcher. */
export function recoverStartupConfig(file: string): { restored: boolean; rejectedPath: string } {
  return withConfigTransactionSync(file, () => {
    const text = fs.readFileSync(file, 'utf8')
    const backups = path.join(path.dirname(file), 'backups')
    fs.mkdirSync(backups, { recursive: true })
    const rejectedPath = path.join(backups, `rejected-startup-${randomUUID()}.yaml`)
    fs.writeFileSync(rejectedPath, text, { flag: 'wx', mode: 0o600 })
    let current: Record<string, unknown>
    try { current = configRecord(yaml.load(text)) }
    catch { return { restored: false, rejectedPath } }
    const candidates = fs.readdirSync(backups).filter((name) => /^config-.*\.yaml$/i.test(name)).sort().reverse()
    for (const name of candidates) {
      let previous: Record<string, unknown>
      try { previous = configRecord(yaml.load(fs.readFileSync(path.join(backups, name), 'utf8'))) }
      catch { continue }
      replaceConfigText(file, yaml.dump(mergeBackendConfig(current, previous), { lineWidth: -1 }), text)
      return { restored: true, rejectedPath }
    }
    return { restored: false, rejectedPath }
  })
}
