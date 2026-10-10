import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat} from 'node:fs/promises'
import path from 'node:path'
import {spawnSync, spawn} from 'node:child_process'
import {updateCrontab} from '../../apps/backend/deploy/docker/crontab.mjs'
import {supervise} from '../../apps/backend/deploy/docker/runtime-supervisor.mjs'
import {withDownloadLock, saveMedia, validateShareUrl, validateMediaUrl, findItem, download} from '../../plugins/qq/skills/douyin-download-send/scripts/download.mjs'
const scratch = process.env.TMPDIR || '/home/chery/.hermes/cache/scratch'
async function isolated(fn) { const root = await mkdtemp(path.join(scratch, 'node-runtime-')); try { return await fn(root) } finally { await rm(root, {recursive: true, force: true}) } }
const mp4 = Buffer.concat([Buffer.from('0000ftypisom'), Buffer.alloc(80)])
const response = bytes => new Response(bytes, {headers: {'content-type': 'video/mp4'}})

test('real Supercronic accepts valid configuration and preserves it on syntax rejection', () => isolated(async home => {
  const supercronic = path.resolve('apps/backend/deploy/docker/runtime/supercronic')
  await updateCrontab('* * * * * echo isolated\n', {home, supercronic})
  await assert.rejects(updateCrontab('not a cron schedule\n', {home, supercronic}))
  assert.equal(await readFile(path.join(home, 'scheduler/crontab'), 'utf8'), '* * * * * echo isolated\n')
}))

test('crontab validates before atomic replacement and removes rejected temporary files', () => isolated(async home => {
  const validator = path.join(home, 'validator')
  await writeFile(validator, '#!/bin/sh\n! /usr/bin/grep -q INVALID "$2"\n', {mode: 0o700})
  await updateCrontab('* * * * * echo ok\n', {home, supercronic: validator})
  await assert.rejects(updateCrontab('INVALID', {home, supercronic: validator}))
  assert.equal(await readFile(path.join(home, 'scheduler/crontab'), 'utf8'), '* * * * * echo ok\n')
  assert.deepEqual(await readdir(path.join(home, 'scheduler')), ['crontab'])
  assert.equal((await stat(path.join(home, 'scheduler/crontab'))).mode & 0o777, 0o600)
  await updateCrontab('', {home, supercronic: validator})
}))

test('supervisor child failure and spawn failure stop peers', () => isolated(async home => {
  const scheduler = path.join(home, 'scheduler.sh'), backend = path.join(home, 'backend.mjs')
  await writeFile(scheduler, '#!/bin/sh\nsleep 0.1\nexit 0\n', {mode: 0o700})
  await writeFile(backend, 'setInterval(() => {}, 1000)\n')
  assert.equal(await supervise({home, scheduler, backend, graceMs: 100}), 1)
  assert.equal(await supervise({home, scheduler: path.join(home, 'missing'), backend, graceMs: 100}), 1)
}))

test('supervisor forwards SIGTERM and bounds uncooperative child shutdown', () => isolated(async home => {
  const scheduler = path.join(home, 'scheduler.sh'), backend = path.join(home, 'backend.mjs')
  await writeFile(scheduler, '#!/bin/sh\ntrap "" TERM\nwhile :; do sleep 1; done\n', {mode: 0o700})
  await writeFile(backend, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)\n')
  const module = new URL('../../apps/backend/deploy/docker/runtime-supervisor.mjs', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {supervise} from ${JSON.stringify(module)}; const p=supervise(${JSON.stringify({home, scheduler, backend, graceMs: 100})}); setTimeout(()=>process.kill(process.pid,'SIGTERM'),100); process.exitCode=await p;`])
  const result = await new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})))
  assert.deepEqual(result, {code: 143, signal: null})
}))

test('shared flock excludes Python cleanup exclusive lock and releases on failure', () => isolated(async root => {
  const media = path.join(root, 'media'); await mkdir(media)
  const probe = () => spawnSync('python3', ['-c', 'import fcntl,sys\nf=open(sys.argv[1],"a")\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(9)', path.join(root, '.downloads.lock')]).status
  await assert.rejects(withDownloadLock(media, async () => { assert.equal(probe(), 9); throw new Error('test failure') }))
  assert.equal(probe(), 0)
}))

test('URL rules, exact target selection, MP4 validation and failed atomic write preserve existing files', () => isolated(async root => {
  assert.throws(() => validateShareUrl('https://evil.example/video/123'))
  assert.throws(() => validateMediaUrl('https://douyinvod.com.evil.example/x'))
  assert.throws(() => validateMediaUrl('http://a.douyinvod.com/x'))
  assert.equal(findItem([{aweme_id: '2', video: {}}, {aweme_id: '1', video: {duration: 9}}], '1').video.duration, 9)
  const dest = path.join(root, '1.mp4')
  await writeFile(dest, 'original')
  await assert.rejects(saveMedia('https://a.douyinvod.com/x', dest, {}, {request: async () => response('invalid')}))
  assert.equal(await readFile(dest, 'utf8'), 'original')
  await assert.rejects(saveMedia('https://a.douyinvod.com/x', dest, {}, {request: async () => new Response(null, {status: 302, headers: {location: 'https://evil.example/x'}})}))
  assert.equal(await saveMedia('https://a.douyinvod.com/x', dest, {}, {request: async () => response(mp4)}), mp4.length)
  assert.deepEqual(await readdir(root), ['1.mp4'])
}))

test('complete downloader uses selected browser data, returns manifest and closes browser', () => isolated(async root => {
  let closed = false
  const item = {awemeId: '123', video: {duration: 10, playAddr: {urlList: ['https://a.douyinvod.com/x']}}}
  const page = {goto: async () => {}, waitForSelector: async () => {}, locator: () => ({textContent: async () => encodeURIComponent(JSON.stringify({item}))}), evaluate: async () => 'test-agent'}
  const chromium = {launch: async () => ({newContext: async () => ({newPage: async () => page}), close: async () => { closed = true }})}
  const result = await download('https://www.douyin.com/video/123', path.join(root, 'media'), {chromium, request: async () => response(mp4)})
  assert.equal(result.id, '123'); assert.equal(result.bytes, mp4.length); assert.equal(closed, true)
  assert.deepEqual(await readFile(result.file), mp4)
}))

test('image download preserves animation and returns ordered image manifest', {skip: spawnSync('convert', ['-version']).error?.code === 'ENOENT'}, () => isolated(async root => {
  const source = path.join(root, 'source.gif')
  assert.equal(spawnSync('convert', ['-size', '2x2', '-delay', '10', 'xc:red', 'xc:blue', '-loop', '0', source]).status, 0)
  const bytes = await readFile(source)
  const item = {awemeId: '123', video: {}, images: [{urlList: ['https://p3.douyinpic.com/image']}]}
  const page = {goto: async () => {}, waitForSelector: async () => {}, locator: () => ({textContent: async () => encodeURIComponent(JSON.stringify({item}))}), evaluate: async () => 'test-agent'}
  const chromium = {launch: async () => ({newContext: async () => ({newPage: async () => page}), close: async () => {}})}
  const result = await download('https://www.douyin.com/note/123', path.join(root, 'media'), {chromium, request: async () => new Response(bytes, {headers: {'content-type': 'image/gif'}})})
  assert.equal(result.kind, 'images'); assert.equal(path.basename(result.files[0]), '123-0.gif')
  assert.equal(spawnSync('identify', ['-ping', '-format', '%n ', result.files[0]], {encoding:'utf8'}).stdout.trim(), '2 2')
  assert.deepEqual(await readdir(path.join(root, 'media')), ['123-0.gif'])
}))

test('note live photo selects motion clip, not album background music', () => isolated(async root => {
  let selected
  const item = {awemeId: '123', video: {playAddr: [{src: 'https://a.douyin.com/music'}]}, images: [{video: {duration: 2200, playAddr: [{src: 'https://a.douyinvod.com/motion'}]}}]}
  const page = {goto: async () => {}, waitForSelector: async () => {}, locator: () => ({textContent: async () => encodeURIComponent(JSON.stringify({item}))}), evaluate: async () => 'test-agent'}
  const chromium = {launch: async () => ({newContext: async () => ({newPage: async () => page}), close: async () => {}})}
  const result = await download('https://www.douyin.com/note/123', path.join(root, 'media'), {chromium, request: async url => { selected = String(url); return response(mp4) }})
  assert.equal(selected, 'https://a.douyinvod.com/motion'); assert.equal(result.durationMs, 2200)
  item.images = Array.from({length: 31}, () => ({urlList: ['https://a.douyin.com/static']}))
  await assert.rejects(download('https://www.douyin.com/note/123', path.join(root, 'media'), {chromium}), /Too many images/)
}))
