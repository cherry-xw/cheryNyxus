#!/usr/bin/env node
/**
 * 通用视频探测与下载脚本（支持 HTML 扫描、M3U8 Master Playlist、MP4 直链、yt-dlp 及 N_m3u8DL-RE 下载与 QQ 兼容转码）
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, open, rename, rm, stat, unlink, readdir } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { withVideoProgress, progressPhase } from './progress.mjs'
import { withDownloadLock, normalizeVideoFile } from './normalize.mjs'

const run = promisify(execFile)
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export function forbiddenIp(address) {
  const normalized = String(address).toLowerCase().replace(/^::ffff:/, '')
  if (isIP(normalized) === 4) {
    const [a = -1, b = -1] = normalized.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
  }
  if (isIP(normalized) === 6) {
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
  }
  return true
}

export async function assertPublicUrl(rawUrl) {
  let u
  try { u = new URL(rawUrl) } catch { throw new Error('INVALID_URL') }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('INVALID_URL')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('FORBIDDEN_ADDRESS')
  if (isIP(host)) {
    if (forbiddenIp(host)) throw new Error('FORBIDDEN_ADDRESS')
    return u
  }
  const records = await lookup(host, { all: true, verbatim: true })
  if (!records.length || records.some(r => forbiddenIp(r.address))) throw new Error('FORBIDDEN_ADDRESS')
  return u
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(1)} MB`
}

export function extractMediaLinksFromHtml(html, baseUrl) {
  const found = new Set()
  const add = raw => {
    if (!raw || typeof raw !== 'string') return
    const cleaned = raw.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&').trim()
    try {
      const u = new URL(cleaned, baseUrl)
      if (['http:', 'https:'].includes(u.protocol) && /\.(?:m3u8|mp4)(?:$|\?)/i.test(u.href)) found.add(u.href)
    } catch {}
  }
  for (const m of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi)) add(m[0])
  for (const m of html.matchAll(/(?:src|data-src|url|playUrl|videoUrl|backup|file)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/gi)) add(m[1])
  for (const m of html.matchAll(/["']((?:\/|\.\.?\/)[^"'\s<>]+\.(?:m3u8|mp4)(?:\?[^"'\s<>]*)?)["']/gi)) add(m[1])
  return [...found]
}

export function parseMasterM3u8(content, baseUrl, durationSec = 0) {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const variants = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue
    const attrs = line.slice('#EXT-X-STREAM-INF:'.length)
    const next = lines.slice(i + 1).find(l => !l.startsWith('#'))
    if (!next) continue
    const resMatch = /RESOLUTION=(\d+)x(\d+)/i.exec(attrs)
    const bwMatch = /(?:AVERAGE-)?BANDWIDTH=(\d+)/i.exec(attrs)
    const codecsMatch = /CODECS="([^"]+)"/i.exec(attrs)
    const width = resMatch ? Number(resMatch[1]) : 0
    const height = resMatch ? Number(resMatch[2]) : 0
    const shortSide = width && height ? Math.min(width, height) : height
    const bandwidth = bwMatch ? Number(bwMatch[1]) : 0
    const estimatedBytes = bandwidth && durationSec > 0 ? Math.round((bandwidth / 8) * durationSec) : null
    const streamUrl = new URL(next, baseUrl).href
    variants.push({
      formatId: `hls-${shortSide || bandwidth || variants.length + 1}`,
      quality: shortSide ? `${shortSide}P` : (bandwidth ? `${Math.round(bandwidth / 1000)}kbps` : `流${variants.length + 1}`),
      resolution: width && height ? `${width}x${height}` : '未知',
      shortSide,
      protocol: 'm3u8',
      codecs: codecsMatch ? codecsMatch[1] : 'h264/aac',
      sizeBytes: estimatedBytes,
      sizeLabel: estimatedBytes ? `约 ${formatBytes(estimatedBytes)}` : '未知大小（M3U8流）',
      sizeExact: false,
      streamUrl,
    })
  }
  return variants
}

export function parseMediaM3u8Duration(content) {
  if (!/#EXT-X-ENDLIST/i.test(content) && /#EXT-X-TARGETDURATION/i.test(content) && !/#EXT-X-PLAYLIST-TYPE:VOD/i.test(content)) {
    return { isLive: true, durationSec: 0 }
  }
  let total = 0
  for (const m of content.matchAll(/#EXTINF:([\d.]+)/gi)) {
    total += Number(m[1]) || 0
  }
  return { isLive: false, durationSec: Math.round(total) }
}

export function selectRecommendedOption(options, maxBytes = 1024 * 1024 * 1024) {
  const valid = options.filter(o => !o.sizeBytes || o.sizeBytes <= maxBytes)
  const pool = valid.length ? valid : options
  const p720 = pool.find(o => o.shortSide === 720 || o.quality === '720P')
  if (p720) return p720.formatId
  const p480 = pool.find(o => (o.shortSide >= 360 && o.shortSide <= 540) || o.quality === '480P')
  if (p480) return p480.formatId
  const under720 = pool.filter(o => o.shortSide > 0 && o.shortSide <= 720).sort((a, b) => b.shortSide - a.shortSide)[0]
  if (under720) return under720.formatId
  return pool[0]?.formatId ?? null
}

async function publicFetch(url, options = {}, depth = 0) {
  if (depth > 8) throw new Error('TOO_MANY_REDIRECTS')
  const checked = await assertPublicUrl(String(url))
  const res = await fetch(checked, { ...options, redirect: 'manual' })
  if ([301,302,303,307,308].includes(res.status)) {
    const location = res.headers.get('location'); await res.body?.cancel()
    if (!location) throw new Error('INVALID_REDIRECT')
    return publicFetch(new URL(location, checked).href, options, depth + 1)
  }
  return res
}

async function fetchTextSafe(url, headers = {}) {
  const checked = await assertPublicUrl(url)
  const res = await publicFetch(checked, { headers: { 'User-Agent': DEFAULT_UA, ...headers }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP_${res.status}`)
  let text = ''
  for await (const chunk of res.body) {
    text += Buffer.from(chunk).toString('utf8')
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('PAGE_TOO_LARGE')
  }
  return { text, finalUrl: res.url || checked.href, contentType: res.headers.get('content-type') || '' }
}

async function headSizeSafe(url, headers = {}) {
  try {
    const checked = await assertPublicUrl(url)
    const r = await publicFetch(checked, { method: 'HEAD', headers: { 'User-Agent': DEFAULT_UA, ...headers }, redirect: 'follow' })
    const len = Number(r.headers.get('content-length'))
    if (r.ok && Number.isSafeInteger(len) && len > 0) return len
  } catch {}
  try {
    const checked = await assertPublicUrl(url)
    const r = await publicFetch(checked, { method: 'GET', headers: { 'User-Agent': DEFAULT_UA, ...headers, Range: 'bytes=0-0' }, redirect: 'follow' })
    try {
      const m = /^bytes 0-0\/(\d+)$/i.exec(r.headers.get('content-range') || '')
      const len = Number(m?.[1])
      if (r.status === 206 && Number.isSafeInteger(len) && len > 0) return len
    } finally { await r.body?.cancel() }
  } catch {}
  return null
}

export async function probeUrl(url, { maxDownloadMb = Number(process.env.QQ_MAX_DOWNLOAD_MB || 1024) } = {}) {
  await assertPublicUrl(url)
  const maxBytes = maxDownloadMb * 1024 * 1024
  const ytDlpBin = process.env.YT_DLP_PATH || 'yt-dlp'

  // 1. Direct .m3u8 or .mp4 URL
  if (/\.m3u8(?:$|\?)/i.test(url)) {
    const { text, finalUrl } = await fetchTextSafe(url)
    if (/#EXT-X-STREAM-INF:/i.test(text)) {
      let durationSec = 0
      const rawVariants = parseMasterM3u8(text, finalUrl, 0)
      if (rawVariants[0]?.streamUrl) {
        try {
          const sub = await fetchTextSafe(rawVariants[0].streamUrl, { Referer: finalUrl })
          const info = parseMediaM3u8Duration(sub.text)
          if (info.isLive) throw new Error('LIVE_UNSUPPORTED')
          durationSec = info.durationSec
        } catch (e) { if (e.message === 'LIVE_UNSUPPORTED') throw e }
      }
      const options = parseMasterM3u8(text, finalUrl, durationSec).map(o => ({
        ...o,
        withinLimit: !o.sizeBytes || o.sizeBytes <= maxBytes,
      }))
      const recommendedFormatId = selectRecommendedOption(options, maxBytes)
      return { ok: true, mode: 'probe', sourceType: 'm3u8_master', title: path.basename(new URL(finalUrl).pathname) || 'M3U8视频', durationSec, maxDownloadMb, recommendedFormatId, mobileAdvice: '手机观看环境下 720P 已非常清晰，480P 也完全可接受；文件越大下载与 QQ 发送受流量限制越慢，建议优先选择 720P 或 480P。', options }
    }
    const info = parseMediaM3u8Duration(text)
    if (info.isLive) throw new Error('LIVE_UNSUPPORTED')
    const options = [{
      formatId: 'hls-default',
      quality: '默认清晰度 (M3U8)',
      resolution: '原画',
      shortSide: 720,
      protocol: 'm3u8',
      codecs: 'h264/aac',
      sizeBytes: null,
      sizeLabel: '按分片实时统计（上限 ' + maxDownloadMb + ' MB）',
      sizeExact: false,
      withinLimit: true,
      streamUrl: finalUrl,
    }]
    return { ok: true, mode: 'probe', sourceType: 'm3u8_single', title: path.basename(new URL(finalUrl).pathname) || 'M3U8视频', durationSec: info.durationSec, maxDownloadMb, recommendedFormatId: 'hls-default', mobileAdvice: '手机观看环境下 720P 已非常清晰，480P 也完全可接受；文件越大下载与 QQ 发送受流量限制越慢。', options }
  }

  if (/\.mp4(?:$|\?)/i.test(url)) {
    const sizeBytes = await headSizeSafe(url)
    const options = [{
      formatId: 'mp4-direct',
      quality: '直链 MP4',
      resolution: '原画',
      shortSide: 720,
      protocol: 'mp4',
      codecs: 'mp4',
      sizeBytes,
      sizeLabel: sizeBytes ? formatBytes(sizeBytes) : '未知大小',
      sizeExact: Boolean(sizeBytes),
      withinLimit: !sizeBytes || sizeBytes <= maxBytes,
      streamUrl: url,
    }]
    return { ok: true, mode: 'probe', sourceType: 'mp4_direct', title: path.basename(new URL(url).pathname) || '直链视频', durationSec: 0, maxDownloadMb, recommendedFormatId: 'mp4-direct', mobileAdvice: '手机观看环境下 720P 已非常清晰，480P 也完全可接受；文件越大下载与 QQ 发送受流量限制越慢。', options }
  }

  // 2. Try yt-dlp metadata extraction for general video sites
  try {
    const { stdout } = await run(ytDlpBin, ['--ignore-config', '--playlist-items', '1', '--skip-download', '--dump-single-json', '--retries', '1', '--user-agent', DEFAULT_UA, url], { maxBuffer: 10 * 1024 * 1024 })
    const raw = JSON.parse(stdout)
    const info = raw.entries?.[0] ?? raw
    if (info.is_live) throw new Error('LIVE_UNSUPPORTED')
    const durationSec = Math.round(Number(info.duration || 0))
    const formats = Array.isArray(info.formats) ? info.formats : []
    const bestAudio = formats.filter(f => f.vcodec === 'none' && f.acodec && f.acodec !== 'none' && f.url).sort((a, b) => (a.abr || a.tbr || 0) - (b.abr || b.tbr || 0))[0]
    const byHeight = new Map()
    for (const f of formats) {
      if (!f.url || !f.vcodec || f.vcodec === 'none') continue
      const w = Number(f.width || 0), h = Number(f.height || 0)
      const shortSide = w && h ? Math.min(w, h) : (h || w || 0)
      if (!shortSide) continue
      const label = shortSide >= 2160 ? '4K' : shortSide >= 1440 ? '2K' : `${shortSide}P`
      const hasAudio = Boolean(f.acodec && f.acodec !== 'none')
      const audioBytes = !hasAudio && bestAudio ? Number(bestAudio.filesize || bestAudio.filesize_approx || (bestAudio.tbr && durationSec ? (bestAudio.tbr * 1000 / 8) * durationSec : 0)) : 0
      const videoBytes = Number(f.filesize || f.filesize_approx || (f.tbr && durationSec ? (f.tbr * 1000 / 8) * durationSec : 0))
      const totalBytes = videoBytes > 0 ? Math.round(videoBytes + audioBytes) : null
      const isAvc = /^avc1|^h264/i.test(String(f.vcodec))
      const existing = byHeight.get(label)
      if (!existing || (isAvc && !existing.isAvc) || ((totalBytes || Infinity) < (existing.sizeBytes || Infinity) && isAvc === existing.isAvc)) {
        byHeight.set(label, {
          formatId: hasAudio ? String(f.format_id) : (bestAudio ? `${f.format_id}+${bestAudio.format_id}` : String(f.format_id)),
          quality: label,
          resolution: w && h ? `${w}x${h}` : `${shortSide}P`,
          shortSide,
          protocol: String(f.protocol || f.ext || 'mp4').includes('m3u8') ? 'm3u8' : 'mp4',
          codecs: `${f.vcodec}${hasAudio ? '+' + f.acodec : (bestAudio ? '+' + bestAudio.acodec : '')}`,
          isAvc,
          sizeBytes: totalBytes,
          sizeLabel: totalBytes ? `${f.filesize ? '' : '约 '}${formatBytes(totalBytes)}` : '未知大小',
          sizeExact: Boolean(f.filesize),
          withinLimit: !totalBytes || totalBytes <= maxBytes,
        })
      }
    }
    const options = [...byHeight.values()].sort((a, b) => a.shortSide - b.shortSide)
    if (options.length) {
      const recommendedFormatId = selectRecommendedOption(options, maxBytes)
      return {
        ok: true,
        mode: 'probe',
        sourceType: 'yt_dlp',
        title: String(info.title || '视频'),
        durationSec,
        maxDownloadMb,
        recommendedFormatId,
        mobileAdvice: '手机观看环境下 720P 已非常清晰，480P 也完全可接受；文件越大下载与 QQ 发送受流量限制越慢，建议优先选择 720P 或 480P，不建议盲目选 1080P/2K/4K。',
        options,
      }
    }
  } catch (e) {
    if (e.message === 'LIVE_UNSUPPORTED') throw e
  }

  // 3. Fallback: Fetch HTML and scan for embedded .m3u8 / .mp4 links
  const { text: html, finalUrl } = await fetchTextSafe(url)
  const links = extractMediaLinksFromHtml(html, finalUrl)
  if (!links.length) throw new Error('NO_MEDIA_FOUND_IN_HTML')
  const firstM3u8 = links.find(l => /\.m3u8(?:$|\?)/i.test(l))
  if (firstM3u8) return probeUrl(firstM3u8, { maxDownloadMb })
  const firstMp4 = links[0]
  return probeUrl(firstMp4, { maxDownloadMb })
}

async function monitorDirSize(dir, maxBytes, onExceed) {
  let total = 0
  const walk = async current => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const full = path.join(current, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile()) {
        const st = await stat(full).catch(() => null)
        if (st) total += st.size
      }
    }
  }
  await walk(dir)
  if (total > maxBytes) onExceed(total)
}

async function runBounded(bin, args, dir, maxBytes) {
  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.resume(); child.stderr.resume()
    let exceeded = false
    const timer = setInterval(() => { void monitorDirSize(dir, maxBytes, () => { exceeded = true; child.kill('SIGKILL') }) }, 250)
    child.once('error', e => { clearInterval(timer); reject(e) })
    child.once('close', code => { clearInterval(timer); if (exceeded) reject(new Error('SIZE_LIMIT')); else if (code !== 0) reject(new Error('DOWNLOAD_FAILED')); else resolve() })
  })
}

export async function downloadWithNm3u8(streamUrl, outputDir, { referer, maxBytes = 1024 * 1024 * 1024, threadCount = 4 } = {}) {
  await assertPublicUrl(streamUrl)
  const tempDir = await mkdtemp(path.join(outputDir, '.nm3u8-'))
  const saveName = 'out'
  const bin = process.env.N_M3U8DL_RE_PATH || 'N_m3u8DL-RE'
  const args = [
    streamUrl,
    '--tmp-dir', tempDir,
    '--save-dir', tempDir,
    '--save-name', saveName,
    '--thread-count', String(threadCount),
    '--concurrent-download',
    '--auto-select',
    '--no-log', '--no-ansi-color', '--disable-update-check',
    '--header', `User-Agent: ${DEFAULT_UA}`,
    ...(referer ? ['--header', `Referer: ${referer}`] : []),
  ]
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TERM: 'dumb' } })
      let exceeded = false
      let stderr = ''
      child.stdout.resume()
      child.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-4000) })
      const timer = setInterval(() => {
        void monitorDirSize(tempDir, maxBytes, () => {
          exceeded = true
          try { child.kill('SIGKILL') } catch {}
        })
      }, 1000)
      child.on('error', err => { clearInterval(timer); reject(err) })
      child.on('close', code => {
        clearInterval(timer)
        if (exceeded) return reject(new Error('SIZE_LIMIT'))
        if (code !== 0) return reject(new Error(`M3U8_DOWNLOAD_FAILED: ${stderr.slice(0, 200)}`))
        resolve()
      })
    })
    const files = (await readdir(tempDir)).filter(f => /\.(?:mp4|ts|mkv|mov)$/i.test(f))
    if (!files.length) throw new Error('M3U8_OUTPUT_MISSING')
    const rawOut = path.join(tempDir, files[0])
    const finalFile = path.join(outputDir, `${Date.now()}${Math.floor(Math.random() * 1000000)}.mp4`)
    // Convert/remux into standard MP4 with video stream 0 and AAC-LC audio stream 1
    await run('ffmpeg', [
      '-nostdin', '-v', 'error', '-threads', '2', '-y',
      '-i', rawOut,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'copy',
      '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      finalFile,
    ])
    progressPhase('processing')
    await normalizeVideoFile(finalFile, { maxBytes })
    const finalStat = await stat(finalFile)
    if (finalStat.size > maxBytes) {
      await unlink(finalFile).catch(() => {})
      throw new Error('SIZE_LIMIT')
    }
    return { ok: true, file: finalFile, mediaFile: path.basename(finalFile), bytes: finalStat.size, sizeLabel: formatBytes(finalStat.size) }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function downloadVideo(url, { formatId, outputDir = process.env.CHERY_MEDIA_DIR || path.join(os.homedir(), 'media'), maxDownloadMb = Number(process.env.QQ_MAX_DOWNLOAD_MB || 1024), threadCount = Number(process.env.QQ_WORKER_THREADS || 4) } = {}) {
  if (!Number.isFinite(maxDownloadMb) || maxDownloadMb <= 0 || maxDownloadMb > Number(process.env.QQ_MAX_DOWNLOAD_MB || 1024) || maxDownloadMb > 1024) throw new Error('INVALID_SIZE_LIMIT')
  await assertPublicUrl(url)
  await mkdir(outputDir, { recursive: true })
  const maxBytes = maxDownloadMb * 1024 * 1024
  return withDownloadLock(outputDir, async () => {
    const probed = await probeUrl(url, { maxDownloadMb })
    const chosenId = formatId || probed.recommendedFormatId || probed.options?.[0]?.formatId
    const chosen = probed.options?.find(o => o.formatId === chosenId)
    if (formatId && !chosen) throw new Error('INVALID_FORMAT_ID')
    if (!chosen) throw new Error('NO_FORMAT_AVAILABLE')
    if (chosen.sizeBytes && chosen.sizeBytes > maxBytes) throw new Error('SIZE_LIMIT')
    progressPhase('downloading')

    if (probed.sourceType === 'm3u8_master' || probed.sourceType === 'm3u8_single') {
      try {
        if (process.env.QQ_HLS_DOWNLOADER !== 'nm3u8') throw new Error('USE_FFMPEG')
        return await downloadWithNm3u8(chosen.streamUrl || url, outputDir, { referer: url, maxBytes, threadCount })
      } catch (error) {
        if (error.message === 'SIZE_LIMIT') throw error
        const finalFile = path.join(outputDir, `${Date.now()}${Math.floor(Math.random() * 1000000)}.mp4`)
        try {
          progressPhase('processing')
          await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', chosen.streamUrl || url,
            '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
            '-threads', String(threadCount), '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k', '-movflags', '+faststart',
            '-fs', String(maxBytes + 1), finalFile], { maxBuffer: 262144 })
          const info = await stat(finalFile)
          if (info.size > maxBytes) throw new Error('SIZE_LIMIT')
          return { ok: true, file: finalFile, mediaFile: path.basename(finalFile), bytes: info.size, sizeLabel: formatBytes(info.size), downloader: 'ffmpeg', primaryDownloaderFailed: error.message !== 'USE_FFMPEG' }
        } catch (failure) { await unlink(finalFile).catch(() => {}); throw failure }
      }
    }

    if (probed.sourceType === 'mp4_direct') {
      const targetUrl = await assertPublicUrl(chosen.streamUrl || url)
      const res = await publicFetch(targetUrl, { headers: { 'User-Agent': DEFAULT_UA, Referer: url }, redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error('DOWNLOAD_FAILED')
      const len = Number(res.headers.get('content-length'))
      progressPhase('downloading', len || undefined)
      if (len && len > maxBytes) { await res.body.cancel(); throw new Error('SIZE_LIMIT') }
      const finalFile = path.join(outputDir, `${Date.now()}${Math.floor(Math.random() * 1000000)}.mp4`)
      const tempFile = `${finalFile}.part`
      const handle = await open(tempFile, 'wx', 0o600)
      let bytes = 0
      try {
        for await (const chunk of res.body) {
          bytes += chunk.length
          if (bytes > maxBytes) throw new Error('SIZE_LIMIT')
          await handle.writeFile(chunk)
        }
        if (len && bytes !== len) throw new Error('INCOMPLETE_MEDIA')
        await handle.sync()
        await handle.close()
        progressPhase('processing')
        await normalizeVideoFile(tempFile, { maxBytes })
        const st = await stat(tempFile)
        if (st.size > maxBytes) throw new Error('SIZE_LIMIT')
        await rename(tempFile, finalFile)
        return { ok: true, file: finalFile, mediaFile: path.basename(finalFile), bytes: st.size, sizeLabel: formatBytes(st.size), quality: chosen.quality }
      } finally {
        await handle.close().catch(() => {})
        await unlink(tempFile).catch(() => {})
      }
    }

    // yt-dlp download path
    const ytDlpBin = process.env.YT_DLP_PATH || 'yt-dlp'
    const tempDir = await mkdtemp(path.join(outputDir, '.ytdl-'))
    try {
      const outTemplate = path.join(tempDir, 'video.%(ext)s')
      await runBounded(ytDlpBin, [
        '--ignore-config', '--no-playlist',
        '-f', chosen.formatId,
        '--merge-output-format', 'mp4',
        '--max-filesize', `${maxDownloadMb}M`,
        '--concurrent-fragments', String(threadCount),
        '-o', outTemplate,
        url,
      ], tempDir, maxBytes)
      const files = (await readdir(tempDir)).filter(f => f.endsWith('.mp4'))
      if (!files.length) throw new Error('DOWNLOAD_OUTPUT_MISSING')
      const merged = path.join(tempDir, files[0])
      progressPhase('processing')
      await normalizeVideoFile(merged, { maxBytes })
      const st = await stat(merged)
      if (st.size > maxBytes) throw new Error('SIZE_LIMIT')
      const finalFile = path.join(outputDir, `${Date.now()}${Math.floor(Math.random() * 1000000)}.mp4`)
      await rename(merged, finalFile)
      return { ok: true, file: finalFile, mediaFile: path.basename(finalFile), bytes: st.size, sizeLabel: formatBytes(st.size), quality: chosen.quality }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  })
}

async function cli(args) {
  const mode = args[0]
  const url = args[1]
  if (!mode || !url || !['probe', 'download'].includes(mode)) {
    throw new Error('Usage: video.mjs <probe|download> <URL> [--format <formatId>] [--max-mb <MB>]')
  }
  let formatId
  let maxDownloadMb = Number(process.env.QQ_MAX_DOWNLOAD_MB || 1024)
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--format' && args[i + 1]) { formatId = args[++i]; continue }
    if (args[i] === '--max-mb' && args[i + 1]) { maxDownloadMb = Number(args[++i]); continue }
  }
  if (mode === 'probe') return probeUrl(url, { maxDownloadMb })
  const root = process.env.CHERY_MEDIA_DIR || path.join(os.homedir(), 'media')
  await mkdir(root, { recursive: true })
  return withVideoProgress(root, () => downloadVideo(url, { formatId, maxDownloadMb }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2))
    .then(res => console.log(JSON.stringify(res)))
    .catch(err => {
      console.log(JSON.stringify({ ok: false, error: /^[A-Z_0-9]+$/.test(String(err.message)) ? err.message : 'VIDEO_OPERATION_FAILED' }))
      process.exitCode = 1
    })
}
