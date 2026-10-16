import type { AppNotification } from './notifications.ts'
import path from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type { ManagedAppRecord } from './types.ts'

export interface PersistedControllerState {
  version: 1
  notifications: Record<string, AppNotification>
  nextProjectId: number
  lastWeeklyCleanupSlot: string | null
  activeBurstTicket: {
    appKey: string
    deadlineMs: number
  } | null
  apps: Record<string, ManagedAppRecord>
}

const INITIAL_STATE: PersistedControllerState = {
  version: 1,
  notifications: {},
  nextProjectId: 10001,
  lastWeeklyCleanupSlot: null,
  activeBurstTicket: null,
  apps: {},
}

export class ControllerStateStore {
  private readonly filePath: string
  private state: PersistedControllerState = structuredClone(INITIAL_STATE)
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(filePath = '/var/lib/cherynyxus-apps/controller-state.json') {
    this.filePath = filePath
  }

  async load(): Promise<PersistedControllerState> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedControllerState>
      this.state = {
        version: 1,
        notifications: parsed.notifications ?? {},
        nextProjectId:
          typeof parsed.nextProjectId === 'number' && parsed.nextProjectId >= 10001
            ? parsed.nextProjectId
            : 10001,
        lastWeeklyCleanupSlot: parsed.lastWeeklyCleanupSlot ?? null,
        activeBurstTicket: parsed.activeBurstTicket ?? null,
        apps: parsed.apps && typeof parsed.apps === 'object' ? parsed.apps : {},
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
      this.state = structuredClone(INITIAL_STATE)
      await this.save()
    }
    return this.state
  }

  getState(): PersistedControllerState {
    return this.state
  }

  getApp(userId: string, appId: string): ManagedAppRecord | undefined {
    return this.state.apps[`${userId}:${appId}`]
  }

  listUserApps(userId: string): ManagedAppRecord[] {
    return Object.values(this.state.apps).filter(a => a.userId === userId)
  }

  listAllApps(): ManagedAppRecord[] {
    return Object.values(this.state.apps)
  }

  async deleteApp(userId: string, appId: string): Promise<void> {
    delete this.state.apps[`${userId}:${appId}`]
    for (const [id, notification] of Object.entries(this.state.notifications))
      if (notification.userId === userId && notification.appId === appId) delete this.state.notifications[id]
    await this.save()
  }

  async allocateProjectId(): Promise<number> {
    const id = this.state.nextProjectId++
    await this.save()
    return id
  }

  async upsertApp(record: ManagedAppRecord): Promise<void> {
    this.state.apps[`${record.userId}:${record.appId}`] = record
    await this.save()
  }

  async setBurstTicket(
    ticket: { appKey: string; deadlineMs: number } | null,
  ): Promise<void> {
    this.state.activeBurstTicket = ticket
    await this.save()
  }

  async setLastWeeklyCleanupSlot(slot: string): Promise<void> {
    this.state.lastWeeklyCleanupSlot = slot
    await this.save()
  }

  async save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2)
    const run = this.writeChain.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, this.filePath)
    })
    this.writeChain = run
    await run
  }
}
