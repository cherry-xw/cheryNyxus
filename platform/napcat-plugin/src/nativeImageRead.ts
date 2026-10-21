import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** Linux directory-FD walk: no parent or leaf symlinks, no FIFO open, finite regular-file reads. */
export function readNativeImage(root: string, filename: string, size: number, md5: string, validate: () => void) {
  if(process.platform!=='linux'||!path.isAbsolute(root)||!path.isAbsolute(filename)||!Number.isSafeInteger(size)||size<=0||size>20971520||!/^[a-fA-F0-9]{32}$/.test(md5))throw Error('SOURCE_UNAVAILABLE')
  const relative=path.relative(root,filename), pieces=relative.split(path.sep)
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||pieces.some(p=>!p||p==='.'||p==='..'))throw Error('SOURCE_UNAVAILABLE')
  const fds:number[]=[]
  try {
    let fd=fs.openSync('/',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);fds.push(fd)
    for(const component of root.split('/').filter(Boolean).concat(pieces.slice(0,-1))) {
      fd=fs.openSync(`/proc/self/fd/${fd}/${component}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);fds.push(fd)
    }
    validate()
    const file=fs.openSync(`/proc/self/fd/${fd}/${pieces.at(-1)}`,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);fds.push(file)
    const before=fs.fstatSync(file)
    if(!before.isFile()||before.size!==size)throw Error('SOURCE_UNAVAILABLE')
    const body=Buffer.alloc(size);let offset=0
    while(offset<size){validate();const n=fs.readSync(file,body,offset,Math.min(65536,size-offset),offset);if(!n)throw Error('SOURCE_UNAVAILABLE');offset+=n}
    const after=fs.fstatSync(file)
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||createHash('md5').update(body).digest('hex')!==md5.toLowerCase())throw Error('SOURCE_UNAVAILABLE')
    validate()
    return body
  }finally{for(const fd of fds.reverse())fs.closeSync(fd)}
}
