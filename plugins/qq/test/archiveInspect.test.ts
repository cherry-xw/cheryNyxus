import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const run=promisify(execFile),roots:string[]=[]
const script=fileURLToPath(new URL('../skills/archive-inspect/scripts/archive.py',import.meta.url))
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function fixture(entries:Array<{name:string;text:string;mode?:number}>){
  const root=await mkdtemp('/tmp/opencode/qq-archive-inspect-');roots.push(root)
  const source=`import json,sys,zipfile
with zipfile.ZipFile('archive.zip','w',compression=zipfile.ZIP_STORED) as archive:
 for entry in json.loads(sys.argv[1]):
  info=zipfile.ZipInfo(entry['name']);info.create_system=3;info.external_attr=entry.get('mode',0o100600)<<16
  archive.writestr(info,entry['text'].encode('utf-8'))
`
  await run('python3',['-c',source,JSON.stringify(entries)],{cwd:root})
  const inspect=(operation='extract')=>run('python3',[script,operation],{cwd:root})
  return {root,inspect}
}
describe('QQ ZIP inspection without a container or network',()=>{
  it('lists and safely extracts Unicode members without running their contents and keeps complete files on retry',async()=>{
    const f=await fixture([{name:'中文 空格/长文.txt',text:'原文😀'.repeat(100)},{name:'run.py',text:'raise RuntimeError("must never run")'}])
    expect(JSON.parse((await f.inspect('list')).stdout).entryCount).toBe(2)
    await f.inspect()
    const member=path.join(f.root,'extracted','中文 空格','长文.txt'),first=await lstat(member)
    await f.inspect()
    expect((await lstat(member)).ino).toBe(first.ino)
    expect(await readFile(member,'utf8')).toBe('原文😀'.repeat(100))
    expect(await readdir(path.join(f.root,'.archive-inspect-staging'))).toEqual([])
  })
  it('resumes after a killed publisher linked a complete member and ignores incomplete staging',async()=>{
    const f=await fixture([{name:'done.txt',text:'完成😀'},{name:'next.txt',text:'下一份'}])
    const staging=path.join(f.root,'.archive-inspect-staging');await mkdir(staging);await mkdir(path.join(f.root,'extracted'))
    const completed=path.join(staging,`member-${randomUUID()}`),incomplete=path.join(staging,`member-${randomUUID()}`)
    await writeFile(completed,'完成😀');await link(completed,path.join(f.root,'extracted','done.txt'));await writeFile(incomplete,'part')
    await f.inspect()
    expect((await lstat(path.join(f.root,'extracted','done.txt'))).nlink).toBe(1)
    expect(await readFile(path.join(f.root,'extracted','next.txt'),'utf8')).toBe('下一份')
    expect(await readFile(incomplete,'utf8')).toBe('part')
  })
  it('does not publish a partly decoded member on a CRC error',async()=>{
    const f=await fixture([{name:'bad.txt',text:'unique-original-payload'}])
    const archive=path.join(f.root,'archive.zip'),bytes=await readFile(archive),at=bytes.indexOf(Buffer.from('unique-original-payload'))
    expect(at).toBeGreaterThan(0);bytes[at]^=1;await writeFile(archive,bytes)
    await expect(f.inspect()).rejects.toThrow()
    await expect(lstat(path.join(f.root,'extracted','bad.txt'))).rejects.toMatchObject({code:'ENOENT'})
    expect(await readdir(path.join(f.root,'.archive-inspect-staging'))).toEqual([])
  })
  it('rejects unsafe member names, links, duplicate files and over-limit entry counts',async()=>{
    for(const entries of [[{name:'../escape',text:'no'}],[{name:'/absolute',text:'no'}],[{name:'link',text:'../escape',mode:0o120777}],
      [{name:'duplicate',text:'one'},{name:'duplicate',text:'two'}],Array.from({length:2001},(_,i)=>({name:`f${i}`,text:''}))]){
      const f=await fixture(entries);await expect(f.inspect()).rejects.toThrow()
      await expect(lstat(path.join(f.root,'extracted'))).rejects.toMatchObject({code:'ENOENT'})
    }
  })
  it('never overwrites a conflicting file or follows a planted directory link',async()=>{
    const f=await fixture([{name:'dir/file.txt',text:'source'}]);await mkdir(path.join(f.root,'extracted'));await mkdir(path.join(f.root,'outside'))
    await symlink(path.join(f.root,'outside'),path.join(f.root,'extracted','dir'));await expect(f.inspect()).rejects.toThrow()
    expect(await readdir(path.join(f.root,'outside'))).toEqual([])
    await rm(path.join(f.root,'extracted','dir'));await mkdir(path.join(f.root,'extracted','dir'));await writeFile(path.join(f.root,'extracted','dir','file.txt'),'different')
    await expect(f.inspect()).rejects.toThrow()
    expect(await readFile(path.join(f.root,'extracted','dir','file.txt'),'utf8')).toBe('different')
  })
})
