import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { link, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stageSourceZip, readSourceZipText, sourceDirectory, separateSourceRoot } from '../src/sourceWorkspace.mjs'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}) })
async function fixture(publish = true) {
  const root = await mkdtemp('/tmp/opencode/qq-source-workspace-'); roots.push(root)
  const sourceRoot=path.join(root,'sources'),sharedRoot=path.join(root,'shared')
  await mkdir(sharedRoot)
  const scope={ownerId:'qq-fixture',selfId:'100',conversationType:'group' as const,targetId:'999',scopeId:'scope',permissionRevision:1}
  const body=Buffer.alloc(22); body.writeUInt32LE(0x06054b50)
  const sha256=createHash('sha256').update(body).digest('hex')
  const access={sourceRoot,sharedRoot,scope,validate:async()=>{}}
  const input={...access,source:{recordId:'record',revision:1,partId:'p1'},senderId:'123',originalName:'中文 空格.zip',body,
    asset:{assetId:'asset',assetVersionId:'version',sizeBytes:body.length,sha256}}
  const mount=publish?await stageSourceZip(input):{slotKey:`record-p1-${sha256.slice(0,12)}`}
  const slot=path.join(sourceRoot,sourceDirectory(scope),'incoming-zips',mount.slotKey)
  return {root,...access,input,mount,slot}
}

describe('source-scope ZIP workspace', () => {
  it('publishes one immutable ZIP from separate processes, not only the process-local queue', async () => {
    const f=await fixture(false)
    const payload={...f.input,body:undefined}
    const program=`import {stageSourceZip} from ${JSON.stringify(new URL('../src/sourceWorkspace.mjs',import.meta.url).href)};
      const input=JSON.parse(process.argv[1]);input.body=Buffer.alloc(22);input.body.writeUInt32LE(0x06054b50);input.validate=async()=>{};
      console.log(JSON.stringify(await stageSourceZip(input)));`
    const run=()=>promisify(execFile)(process.execPath,['--input-type=module','--eval',program,JSON.stringify(payload)])
    const results=await Promise.all([run(),run(),run()])
    expect(results.map(result=>JSON.parse(result.stdout))).toEqual([expect.objectContaining({slotKey:f.mount.slotKey}),expect.objectContaining({slotKey:f.mount.slotKey}),expect.objectContaining({slotKey:f.mount.slotKey})])
    expect(await readFile(path.join(f.slot,'archive.zip'))).toEqual(f.input.body)
    expect((await lstat(path.join(f.slot,'archive.zip'))).nlink).toBe(1)
  })
  it('finishes reserved publication after interruption and only removes matching private temporaries', async () => {
    const f=await fixture(),registry=path.join(f.sourceRoot,sourceDirectory(f.scope),'slots')
    const entry=path.join(registry,`${f.mount.slotKey}.json`),entryTemp=path.join(registry,`.source-${randomUUID()}`)
    await link(entry,entryTemp)
    await rm(path.join(f.slot,'archive.zip'))
    const dataTemp=path.join(registry,`.source-${randomUUID()}`)
    await writeFile(dataTemp,f.input.body);await link(dataTemp,path.join(f.slot,'archive.zip'))
    const unrelated=path.join(registry,`.source-${randomUUID()}`)
    await writeFile(unrelated,'another incomplete publisher')
    expect(await stageSourceZip(f.input)).toMatchObject({slotKey:f.mount.slotKey})
    const names=await readdir(registry)
    expect(names).not.toContain(path.basename(entryTemp));expect(names).not.toContain(path.basename(dataTemp))
    expect(await readFile(unrelated,'utf8')).toBe('another incomplete publisher')
    expect((await lstat(path.join(f.slot,'archive.zip'))).nlink).toBe(1)
    await link(path.join(f.slot,'archive.zip'),path.join(f.root,'untrusted-alias'))
    await expect(stageSourceZip(f.input)).rejects.toThrow('FILE_INVALID')
    expect(await readFile(path.join(f.root,'untrusted-alias'))).toEqual(f.input.body)
  })
  it('never accepts a registry reservation as proof that a ZIP was mounted', async () => {
    const f=await fixture()
    await rm(path.join(f.slot,'archive.zip'))
    const controller=new AbortController()
    await expect(stageSourceZip({...f.input,signal:controller.signal,validate:async()=>controller.abort()})).rejects.toThrow()
    await expect(readFile(path.join(f.slot,'archive.zip'))).rejects.toMatchObject({code:'ENOENT'})
    await stageSourceZip(f.input)
    expect(await readFile(path.join(f.slot,'archive.zip'))).toEqual(f.input.body)
  })
  it('serializes duplicate publication and preserves existing extraction and fixed identities', async () => {
    const f=await fixture()
    await writeFile(path.join(f.slot,'extracted','kept.txt'),'保留')
    const [one,two]=await Promise.all([stageSourceZip(f.input),stageSourceZip(f.input)])
    expect(one).toEqual(f.mount); expect(two).toEqual(f.mount)
    expect(await readFile(path.join(f.slot,'archive.zip'))).toEqual(f.input.body)
    expect(await readFile(path.join(f.slot,'extracted','kept.txt'),'utf8')).toBe('保留')
    await expect(stageSourceZip({...f.input,originalName:'different.zip'})).rejects.toThrow('SOURCE_CONFLICT')
    await expect(stageSourceZip({...f.input,body:Buffer.from('not zip')})).rejects.toThrow('FILE_INVALID')
    expect(()=>separateSourceRoot(path.join(f.sharedRoot,'sources'),f.sharedRoot)).toThrow('STORAGE_UNAVAILABLE')
  })
  it('reads long UTF-8 lines beyond the shared file limit in Unicode code points', async () => {
    const f=await fixture(),text='中文😀'.repeat(120000)
    await writeFile(path.join(f.slot,'extracted','长 文件.txt'),text)
    const first=await readSourceZipText({...f,path:'长 文件.txt',slotKey:f.mount.slotKey,length:7})
    const next=await readSourceZipText({...f,path:'长 文件.txt',slotKey:f.mount.slotKey,start:first.nextStart!,length:8192})
    expect(first.text+next.text).toBe(Array.from(text).slice(0,8199).join(''))
    expect(first.nextStart).toBe(7); expect(next.nextStart).toBe(8199)
    const end=await readSourceZipText({...f,path:'长 文件.txt',slotKey:f.mount.slotKey,start:Array.from(text).length-5})
    expect(end.complete).toBe(true); expect(end.nextStart).toBeNull(); expect(Array.from(end.text)).toHaveLength(5)
  })
  it('rejects foreign scopes, unsafe paths, binary data and symlink files/directories', async () => {
    const f=await fixture()
    await writeFile(path.join(f.root,'private.txt'),'must not leak')
    await writeFile(path.join(f.slot,'extracted','binary'),Buffer.from([0xff,0x00]))
    await symlink(path.join(f.root,'private.txt'),path.join(f.slot,'extracted','link'))
    await symlink(f.root,path.join(f.slot,'extracted','directory-link'))
    const read=(p:string)=>readSourceZipText({...f,path:p,slotKey:f.mount.slotKey})
    for (const p of ['../manifest.json','/etc/passwd','a/../../private.txt','a\\b','link','directory-link/private.txt','binary'])
      await expect(read(p)).rejects.toThrow()
    await expect(readSourceZipText({...f,scope:{...f.scope,scopeId:'foreign'},path:'anything',slotKey:f.mount.slotKey})).rejects.toThrow()
  })
  it('checks cancellation after asynchronous authority validation and never returns a revoked result', async () => {
    const f=await fixture(),controller=new AbortController()
    await writeFile(path.join(f.slot,'extracted','text'),'not returned')
    await expect(readSourceZipText({...f,slotKey:f.mount.slotKey,path:'text',signal:controller.signal,
      validate:async()=>{controller.abort()}})).rejects.toThrow()
    const second=new AbortController()
    await expect(stageSourceZip({...f.input,signal:second.signal,validate:async()=>{second.abort()}})).rejects.toThrow()
  })
})
