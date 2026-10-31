import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createWorkerController } from '../src/workerController.mjs'
import { executeQQWorker } from '../src/workerClient.js'

const subject={selfId:'100',userId:'123',conversationType:'group',groupId:'999'}
function deferred() { let resolve!:()=>void; const promise=new Promise<void>(r=>{resolve=r}); return {promise,resolve} }
async function fixture(runtime: object) {
  const root=await mkdtemp('/tmp/opencode/qq-worker-controller-')
  const options={fileRoot:path.join(root,'files'),mediaRoot:path.join(root,'media'),skillsRoot:path.join(root,'skills'),sourceRoot:path.join(root,'sources'),image:'offline-fixture'}
  await Promise.all([options.fileRoot,options.mediaRoot,options.skillsRoot].map(p=>mkdir(p)))
  const server=createWorkerController(options,runtime),socket=path.join(root,'control.sock')
  await new Promise<void>(resolve=>server.listen(socket,resolve))
  return {options,socket,async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}}
}

describe('QQ worker creation and cancellation without Docker', () => {
  it('does not start a command cancelled while container creation is still in progress', async () => {
    const created=deferred(),release=deferred(),stopped=deferred(),cleaned=deferred()
    let removals=0
    const runtime={spawn:vi.fn(),exec:vi.fn(async (_bin:string,args:string[])=>{
      if(args[0]==='create'){created.resolve();await release.promise}
      if(args[0]==='rm'){removals++;stopped.resolve();if(removals>=2)cleaned.resolve()}
      return {stdout:'offline-container'}
    })}
    const f=await fixture(runtime),controller=new AbortController()
    try {
      const request=executeQQWorker(f.socket,{subject,command:'never run'},controller.signal)
      const rejected=expect(request).rejects.toThrow('Worker cancelled')
      await created.promise; controller.abort(); await rejected; await stopped.promise
      release.resolve(); await cleaned.promise
      expect(runtime.spawn).not.toHaveBeenCalled()
      const names=runtime.exec.mock.calls.filter(([,args])=>args[0]==='rm').map(([,args])=>args[2])
      expect(new Set(names).size).toBe(1)
    } finally {release.resolve();await f.close()}
  })
  it('applies limits at create, starts only after create finishes and removes the same container', async () => {
    const events:string[]=[],child=new EventEmitter() as EventEmitter & {stdout:PassThrough;stderr:PassThrough}
    child.stdout=new PassThrough();child.stderr=new PassThrough()
    const runtime={exec:vi.fn(async (_bin:string,args:string[])=>{events.push(args[0]!);return {stdout:'offline-container'}}),
      spawn:vi.fn((_bin:string,args:string[])=>{events.push(args[0]!);queueMicrotask(()=>{child.stdout.write('ok');child.emit('close',0)});return child})}
    const f=await fixture(runtime)
    try {
      const result=await executeQQWorker(f.socket,{subject,command:'offline',limits:{workerMemoryMb:256,workerPidsLimit:32,workerCpuCores:0.5}})
      expect(result).toMatchObject({ok:true,stdout:'ok',appliedLimits:{cpuCores:0.5,memoryMb:256,pidsLimit:32}})
      expect(events.slice(0,2)).toEqual(['create','start'])
      const create=runtime.exec.mock.calls.find(([,args])=>args[0]==='create')![1]
      expect(create).toEqual(expect.arrayContaining(['--memory','256m','--pids-limit','32','--cpus','0.5']))
      expect(create.some(v=>v.includes('/workspace/files/incoming-zips:ro'))).toBe(true)
      const name=create[create.indexOf('--name')+1]
      expect(runtime.spawn).toHaveBeenCalledWith('docker',['start','--attach',name],expect.anything())
    } finally {await f.close()}
  })
})
