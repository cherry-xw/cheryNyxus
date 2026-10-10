#!/usr/bin/env node
/** Download a single public video; JSON stdout, coordinated with host cleanup. */
import {mkdir, realpath, open, rename, unlink} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {randomUUID} from 'node:crypto'
import {spawn, execFile} from 'node:child_process'
import {promisify} from 'node:util'
const runFile = promisify(execFile)
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'

export function validateShareUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || !['v.douyin.com', 'www.douyin.com', 'www.iesdouyin.com', 'iesdouyin.com'].includes(url.hostname)) throw new Error('Expected a Douyin HTTPS URL')
  return url
}
export function validateMediaUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || !(url.hostname.endsWith('.douyinvod.com') || url.hostname.endsWith('.douyin.com') || url.hostname.endsWith('.douyinpic.com'))) throw new Error('Unexpected media host')
  return url
}
export function findItem(value, target) {
  if (!value || typeof value !== 'object') return undefined
  if (String(value.aweme_id ?? value.awemeId ?? '') === target && value.video) return value
  for (const item of Object.values(value)) { const found = findItem(item, target); if (found) return found }
}
export async function withDownloadLock(root, action) {
  // util-linux flock uses the same kernel locks as Python fcntl.flock.
  const holder = spawn('flock', ['--shared', path.join(path.dirname(root), '.downloads.lock'), 'sh', '-c', 'printf "locked\\n"; cat >/dev/null'], {stdio: ['pipe', 'pipe', 'pipe']})
  let diagnostics = ''
  holder.stderr.on('data', chunk => { diagnostics += chunk.toString() })
  holder.stdin.on('error', () => {})
  const closed = new Promise(resolve => holder.once('close', resolve))
  await new Promise((resolve, reject) => {
    holder.once('error', reject)
    holder.stdout.once('data', resolve)
    holder.once('close', code => reject(new Error(`Download lock unavailable (${code}): ${diagnostics.slice(0, 100)}`)))
  })
  try { return await action() } finally { holder.stdin.end(); await closed }
}
export async function saveMedia(address, dest, headers, {request = fetch, signal, image = false} = {}) {
  const temporary = path.join(path.dirname(dest), `.${path.basename(dest)}-${randomUUID()}.part`)
  let response, file
  try {
    let url = validateMediaUrl(address)
    for (let redirects = 0; ; redirects++) {
      response = await request(url, {headers, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])])})
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      await response.body?.cancel()
      if (redirects >= 5) throw new Error('Too many media redirects')
      url = validateMediaUrl(new URL(response.headers.get('location'), url).href)
    }
    if (!response.ok || !response.headers.get('content-type')?.includes(image ? 'image' : 'video') || !response.body) throw new Error('Unexpected media response')
    file = await open(temporary, 'wx', 0o600)
    let size = 0, first = Buffer.alloc(0)
    for await (const chunk of response.body) {
      signal?.throwIfAborted()
      const bytes = Buffer.from(chunk)
      if (first.length < 32) first = Buffer.concat([first, bytes.subarray(0, 32 - first.length)])
      size += bytes.length
      if (size > (image ? 30 : 200) * 1024 * 1024) throw new Error('Media too large')
      await file.writeFile(bytes)
    }
    if (image ? !(first.subarray(0,3).equals(Buffer.from([255,216,255])) || first.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || /^GIF8[79]a/.test(first.toString('ascii')) || (first.subarray(0,4).toString() === 'RIFF' && first.subarray(8,12).toString() === 'WEBP')) : (size < 32 || !first.includes(Buffer.from('ftyp')))) throw new Error('Invalid media file')
    await file.sync(); await file.close(); file = undefined
    await rename(temporary, dest)
    return size
  } finally {
    await file?.close()
    await response?.body?.cancel().catch(() => {})
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}
export async function download(url, output, {chromium, request = fetch} = {}) {
  validateShareUrl(url)
  await mkdir(output, {recursive: true})
  const root = await realpath(output)
  return withDownloadLock(root, async () => {
    if (!chromium) {
      const require = createRequire(path.join(process.env.HOME || os.homedir(), 'browser-tools/package.json'))
      chromium = require('playwright').chromium
    }
    const controller = new AbortController()
    let browser
    const stop = () => { controller.abort(new Error('Download interrupted')); void browser?.close().catch(() => {}) }
    process.on('SIGTERM', stop); process.on('SIGINT', stop)
    try {
      browser = await chromium.launch({headless: true})
      controller.signal.throwIfAborted()
      const context = await browser.newContext({locale: 'zh-CN', viewport: {width: 1280, height: 800}})
      const page = await context.newPage()
      const idPattern = /(?:\/video\/|\/share\/video\/|\/note\/|modal_id=)(\d+)/
      let target = url.match(idPattern)?.[1]
      if (!target) { await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 45000}); validateShareUrl(page.url()); target = page.url().match(idPattern)?.[1] }
      if (!target) throw new Error('Could not resolve video ID')
      await page.goto(`https://www.douyin.com/jingxuan?modal_id=${target}`, {waitUntil: 'domcontentloaded', timeout: 60000})
      await page.waitForSelector('#RENDER_DATA', {state: 'attached', timeout: 45000})
      const item = findItem(JSON.parse(decodeURIComponent(await page.locator('#RENDER_DATA').textContent())), target)
      if (!item) throw new Error('Target video data missing; login or verification may be required')
      // Image posts may expose background music as item.video: never send that as video.
      // A single live photo carries its actual motion clip in images[0].video.
      const images = item.images
      if (Array.isArray(images) && images.length && (images.length !== 1 || !images[0]?.video)) {
        if (images.length > 30) throw new Error('Too many images')
        const files = []
        const headers = {'User-Agent': await page.evaluate('navigator.userAgent'), Referer: 'https://www.douyin.com/'}
        for (const [index, image] of images.entries()) {
          if (image.video) throw new Error('Mixed live-photo album is not supported yet')
          const raw = path.join(root, `${target}-${index}.source`)
          let address = (image.downloadUrlList?.length ? image.downloadUrlList : image.urlList)?.[0]
          if (address && typeof address === 'object') address = address.src ?? address.url
          if (!address) throw new Error('Image address missing')
          try {
            await saveMedia(address, raw, headers, {request, signal: controller.signal, image: true})
            const {stdout} = await runFile('identify', ['-ping', '-format', '%n ', raw], {timeout: 15000, maxBuffer: 65536, signal: controller.signal})
            const animated = Number(stdout.trim().split(/\s+/)[0]) > 1
            const dest = path.join(root, `${target}-${index}.${animated ? 'gif' : 'png'}`)
            const temporary = path.join(root, `.${target}-${index}-${randomUUID()}.part`)
            try {
              await runFile('convert', ['-limit', 'memory', '128MiB', '-limit', 'map', '128MiB', raw, ...(animated ? ['-coalesce', '-loop', '0'] : []), `${animated ? 'gif' : 'png'}:${temporary}`], {timeout: 60000, signal: controller.signal})
              await rename(temporary, dest)
            } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e }) }
            files.push(dest)
          } finally { await unlink(raw).catch(e => { if (e.code !== 'ENOENT') throw e }) }
        }
        return {id: target, kind: 'images', files}
      }
      const video = Array.isArray(images) && images.length ? images[0].video : item.video
      let addresses = video.playAddr ?? video.play_addr ?? {}
      if (!Array.isArray(addresses)) addresses = addresses.urlList ?? addresses.url_list ?? []
      let address = addresses[0]
      if (address && typeof address === 'object') address = address.src ?? address.url
      if (!address) throw new Error('No video address')
      const dest = path.join(root, `${target}.mp4`)
      const bytes = await saveMedia(address, dest, {'User-Agent': await page.evaluate('navigator.userAgent'), Referer: 'https://www.douyin.com/'}, {request, signal: controller.signal})
      return {id: target, file: dest, bytes, durationMs: video.duration}
    } finally {
      await browser?.close()
      process.off('SIGTERM', stop); process.off('SIGINT', stop)
    }
  })
}
async function main(args) {
  if (!(args.length === 1 || (args.length === 3 && args[1] === '--output'))) throw new Error('Usage: download.mjs URL [--output DIRECTORY]')
  return download(args[0], args[2] || process.env.CHERY_MEDIA_DIR || path.join(os.homedir(), 'media'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify({ok: true, ...result}))).catch(error => {
    console.log(JSON.stringify({ok: false, error: String(error.message).slice(0, 250)})); process.exitCode = 1
  })
}
