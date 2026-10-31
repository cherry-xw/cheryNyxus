import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const entrypoint = fileURLToPath(new URL('../src/workerEntrypoint.py', import.meta.url))
// Substitute OS calls only: no Docker, mounted fixtures or user commands are started.
const checks = `import json,os,runpy,stat,sys,types
case=json.loads(sys.argv[2])
module=runpy.run_path(sys.argv[1])
events=[]
def opened(name,flags,dir_fd=None):
    assert flags & os.O_NOFOLLOW and flags & os.O_DIRECTORY
    events.append(['open',name])
    if name == case.get('rejectPath'):
        raise OSError('link or unavailable directory')
    return 10+len(events)
os.open=opened
os.dup=lambda descriptor: descriptor+100
os.close=lambda descriptor: None
os.fstat=lambda descriptor: types.SimpleNamespace(st_mode=stat.S_IFDIR,st_dev=int(case.get('device','123')),st_ino=int(case.get('inode','9007199254740997')))
os.fchdir=lambda descriptor: events.append(['chdir',descriptor])
os.execv=lambda file,args: events.append(['exec',file,args])
sys.argv=['entrypoint',json.dumps(case.get('expected',{'device':'123','inode':'9007199254740997'})),case.get('cwd','incoming-zips/slot/extracted'),'original command']
result=module['main']()
print(json.dumps({'result':result,'events':events}))
`
async function check(input: object) {
  const output = await run('python3', ['-I', '-S', '-c', checks, entrypoint, JSON.stringify(input)])
  return { ...JSON.parse(output.stdout), stderr: output.stderr } as {
    result: number | null; events: Array<any[]>; stderr: string
  }
}

describe('QQ worker entrypoint directory checks', () => {
  it('checks the exact directory identity before changing directory and starting the original command', async () => {
    const result = await check({})
    expect(result.stderr).toBe('')
    expect(result.events.map(event => event[0])).toEqual(['open', 'open', 'open', 'chdir', 'exec'])
    expect(result.events.at(-1)).toEqual(['exec', '/usr/bin/bash', ['/usr/bin/bash', '-c', 'original command']])
  })
  it.each([{ device: '124' }, { inode: '9007199254740996' }, { expected: {} }, { expected: null }])(
    'rejects wrong or missing source identity without executing a command: %j', async input => {
      const result = await check(input)
      expect(result.result).toBe(126)
      expect(result.stderr).toContain('QQ_WORKER_MOUNT_REJECTED')
      expect(result.events.some(event => event[0] === 'exec' || event[0] === 'chdir')).toBe(false)
    },
  )
  it('rejects a changed or linked working directory before starting a command', async () => {
    const result = await check({ rejectPath: 'slot' })
    expect(result.result).toBe(126)
    expect(result.events.some(event => event[0] === 'exec')).toBe(false)
  })
  it('keeps shared commands available without source authority', async () => {
    const result = await check({ expected: null, cwd: '.' })
    expect(result.stderr).toBe('')
    expect(result.events.at(-1)?.[0]).toBe('exec')
    expect(result.events).toContainEqual(['open', '/workspace/files'])
  })
})
