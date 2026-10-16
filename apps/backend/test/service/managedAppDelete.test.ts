import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readdir, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ManagedAppController } from '../../src/service/managedApp/controller.ts'
import { XfsQuotaManager } from '../../src/service/managedApp/quotaManager.ts'
import { ControllerStateStore } from '../../src/service/managedApp/stateStore.ts'
import { controllerRpcRequestSchema } from '../../src/service/managedApp/types.ts'

describe('managed app deletion', () => {
  it('deletes the owned stopped app only after storage cleanup succeeds', async () => {
    const record = { userId: '649207438', appId: 'delete-test', projectId: 10001 }
    const c = Object.create(ManagedAppController.prototype) as any
    c.deletingApps = new Set(); c.tasks = new Map()
    c.requireOwnedApp = vi.fn((userId, appId) => { if(userId !== record.userId || appId !== record.appId) throw Error('denied'); return record })
    c.withAppLock = vi.fn(async (_key, fn) => fn())
    c.stopAppServiceLocked = vi.fn(async () => {})
    c.quota = { deleteProject: vi.fn(async () => {}) }
    c.store = { deleteApp: vi.fn(async () => {}) }
    await expect(c.deleteApp({ userId: '3561381800', appId: record.appId })).rejects.toThrow('denied')
    expect(c.stopAppServiceLocked).not.toHaveBeenCalled()
    c.quota.deleteProject.mockRejectedValueOnce(Error('disk failure'))
    await expect(c.deleteApp(record)).rejects.toThrow('disk failure')
    expect(c.store.deleteApp).not.toHaveBeenCalled()
    expect(c.deletingApps.size).toBe(0)
    c.tasks.set('busy', { result: { ...record, status: 'running' } })
    await expect(c.deleteApp(record)).rejects.toThrow('活动任务')
    c.tasks.clear()
    await expect(c.deleteApp(record)).resolves.toEqual({ appId: record.appId, deleted: true })
    expect(c.store.deleteApp).toHaveBeenCalledWith(record.userId, record.appId)
  })
  it('removes only matching app and notifications from durable state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'app-delete-'))
    try {
      const store = new ControllerStateStore(path.join(root, 'state.json')); await store.load()
      const state = store.getState()
      state.apps['649207438:test'] = { userId: '649207438', appId: 'test' } as any
      state.apps['3561381800:test'] = { userId: '3561381800', appId: 'test' } as any
      state.notifications.a = { userId: '649207438', appId: 'test' } as any
      state.notifications.b = { userId: '3561381800', appId: 'test' } as any
      await store.deleteApp('649207438', 'test')
      await store.load()
      expect(store.listAllApps()).toHaveLength(1)
      expect(Object.keys(store.getState().notifications)).toEqual(['b'])
    } finally { await rm(root,{recursive:true,force:true}) }
  })
  it('rejects symlink app roots before touching storage or quota', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'app-delete-path-'))
    try {
      await mkdir(path.join(root,'649207438/apps'),{recursive:true})
      const outside=path.join(root,'outside');await mkdir(outside);await writeFile(path.join(outside,'keep'),'safe')
      await symlink(outside,path.join(root,'649207438/apps/test'))
      const q = new XfsQuotaManager({ hostUserFilesRoot:root,xfsMountPoint:root })
      vi.spyOn(q,'verifyQuotaFilesystemReady').mockResolvedValue()
      await expect(q.deleteProject('649207438','test',10001)).rejects.toThrow('符号链接')
      expect(await readdir(outside)).toEqual(['keep'])
    } finally { await rm(root,{recursive:true,force:true}) }
  })
  it('rejects paths and extra ownership selectors in delete RPC', () => {
    for(const params of [{userId:'649207438',appId:'../other'},{userId:'649207438',appId:'test',root:'/'}])
      expect(controllerRpcRequestSchema.safeParse({id:'delete',method:'deleteApp',params}).success).toBe(false)
  })
})
