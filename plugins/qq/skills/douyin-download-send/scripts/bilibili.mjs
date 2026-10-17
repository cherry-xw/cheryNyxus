import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir, mkdtemp, stat, rename, rm} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {pathToFileURL} from 'node:url'
import {withDownloadLock} from './download.mjs'
import {saveStream} from './limits.mjs'
const run = promisify(execFile), LIMIT = 150 * 1024 * 1024
const USER_AGENTS = [
 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
]
export function allowedMediaUrl(value) {
 try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && ['.bilivideo.com','.bilivideo.cn','.akamaized.net'].some(h=>u.hostname.endsWith(h)) } catch { return false }
}
export function resolution(f) {
 return Number.isFinite(f.width) && f.width > 0 && Number.isFinite(f.height) && f.height > 0 ? Math.min(f.width, f.height) : 0
}
export function selectFormats(formats) {
 const safe = formats.filter(f => allowedMediaUrl(f.url))
 const audio = safe.filter(f => f.vcodec === 'none' && f.acodec && f.acodec !== 'none').sort((a,b)=>(a.abr || a.tbr || 0)-(b.abr || b.tbr || 0))
 const codecRank = f => /^avc1|^h264/.test(f.vcodec) ? 0 : /^hvc1|^hev1|^hevc/.test(f.vcodec) ? 1 : 2
 return safe.filter(f => f.vcodec && f.vcodec !== 'none' && resolution(f) > 0 && resolution(f) <= 1080 && f.ext === 'mp4')
  .sort((a,b)=>resolution(b)-resolution(a) || codecRank(a)-codecRank(b) || (a.tbr||0)-(b.tbr||0))
  .flatMap(v => v.acodec && v.acodec !== 'none' ? [[v]] : audio.map(a => [v,a]))
}
export async function size(f, headers, request = fetch, signal) {
 const u = new URL(f.url)
 if(!allowedMediaUrl(f.url)) throw new Error('Unexpected media host')
 // 1) HEAD 探测 content-length（upos CDN 支持）。
 try {
   const r = await request(u,{method:'HEAD',headers,redirect:'error',...(signal ? {signal} : {})})
   const n = Number(r.headers.get('content-length'))
   if(r.status===200 && Number.isSafeInteger(n) && n>0) return n
 } catch { /* fall through */ }
 // HEAD 不可用时用 Range 查询精确总大小；估算值不用于准入。
 try {
   const r = await request(u,{method:'GET',headers:{...headers,Range:'bytes=0-0'},redirect:'error',...(signal ? {signal} : {})})
   try {
     const match = /^bytes 0-0\/(\d+)$/.exec(r.headers.get('content-range') || '')
     const total = Number(match?.[1])
     if(r.status===206 && Number.isSafeInteger(total) && total>0) return total
   } finally { await r.body?.cancel() }
 } catch { /* fall through */ }
 throw new Error('SIZE_UNKNOWN')
}
export async function tryCandidates(formats, headers, attempt, {probe=size, signal, budget={downloads:0}}={}) {
 const candidates=selectFormats(formats), probes=new Map()
 if(!candidates.length) throw new Error('NO_SAFE_FORMAT')
 let last='SIZE_LIMIT', unknown=false, attempted=false
 for(const pair of candidates) {
  signal?.throwIfAborted()
  let sizes
  try {
   sizes=await Promise.all(pair.map(f=>{
    if(!probes.has(f.url)) probes.set(f.url,probe(f,{...headers,...f.http_headers},fetch,signal))
    return probes.get(f.url)
   }))
  } catch { signal?.throwIfAborted(); unknown=true; continue }
  if(sizes.some(n=>!Number.isSafeInteger(n)||n<=0)) {unknown=true;continue}
  if(sizes.reduce((a,b)=>a+b,0)>LIMIT-1024*1024) continue
  if(budget.downloads>=4) throw new Error('ATTEMPT_LIMIT')
  budget.downloads++;attempted=true
  try { return await attempt(pair,sizes) }
  catch(e) { signal?.throwIfAborted(); last=['MERGE_FAILED','MEDIA_INVALID','SIZE_LIMIT'].includes(e.message)?e.message:'DOWNLOAD_FAILED' }
 }
 throw new Error(attempted?last:unknown?'SIZE_UNKNOWN':'SIZE_LIMIT')
}
export function validateShareUrl(value) {
 const u=new URL(value)
 if(u.protocol!=='https:' || u.username || u.password || (u.port && u.port!=='443') || !['b23.tv','www.bilibili.com','bilibili.com'].includes(u.hostname)) throw new Error('INVALID_URL')
 return u
}
async function resolveShort(u, signal) {
 const r = await fetch(u, {method:'HEAD', redirect:'manual', headers:{'User-Agent': USER_AGENTS[0]}, ...(signal ? {signal} : {})})
 const loc = r.headers.get('location')
 await r.body?.cancel()
 if(![301,302,303,307,308].includes(r.status) || !loc) throw new Error('RESOLVE_FAILED')
 const next=validateShareUrl(new URL(loc,u).href)
 if(next.hostname==='b23.tv') throw new Error('RESOLVE_FAILED')
 return next.href
}
export function errorResult(e) {
 const codes=['SIZE_UNKNOWN','SIZE_LIMIT','NO_SAFE_FORMAT','METADATA_FAILED','RESOLVE_FAILED','LIVE_UNSUPPORTED','DOWNLOAD_FAILED','MERGE_FAILED','MEDIA_INVALID','ATTEMPT_LIMIT','INVALID_URL']
 const error=codes.includes(e.message)?e.message:['TimeoutError','AbortError'].includes(e.name)?'TIME_LIMIT':'BILIBILI_DOWNLOAD_FAILED'
 const stage=error.startsWith('SIZE_')||error==='NO_SAFE_FORMAT'?'selection':({RESOLVE_FAILED:'resolve',INVALID_URL:'resolve',METADATA_FAILED:'metadata',LIVE_UNSUPPORTED:'metadata',MERGE_FAILED:'merge',MEDIA_INVALID:'validation',TIME_LIMIT:'timeout',ATTEMPT_LIMIT:'download',DOWNLOAD_FAILED:'download'}[error]??'unknown')
 return {ok:false,error,stage}
}
export async function main(url) {
 const controller=new AbortController(),signal=controller.signal,budget={downloads:0}
 const u=validateShareUrl(url)
 let target = url
 if(u.hostname==='b23.tv'){
   target = await resolveShort(url,signal)
 }
 const bin = path.join(os.homedir(),'.local/bin/yt-dlp')
 const options={maxBuffer:8*1024*1024,signal}
 const root=process.env.CHERY_MEDIA_DIR || path.join(os.homedir(),'media'); await mkdir(root,{recursive:true})
 return withDownloadLock(root,async()=>{
 for(let refresh=0;refresh<2;refresh++){
 let stdout
 try { ({stdout} = await run(bin,['--ignore-config','--playlist-items','1','--skip-download','--dump-single-json','--retries','0',...(refresh?[]:['--user-agent',USER_AGENTS[0]]),target],options)) }
 catch { signal.throwIfAborted(); if(!refresh) continue; throw new Error('METADATA_FAILED') }
 const data=JSON.parse(stdout),info=data.entries?.[0]??data
 if(info.is_live) throw new Error('LIVE_UNSUPPORTED')
 const httpHeaders=info.http_headers??data.http_headers??{}
 try { return await tryCandidates(info.formats??[],httpHeaders,async(chosen,sizes)=>{
  const temp=await mkdtemp(path.join(root,'.bili-'))
  try {
   // Each stream uses the verified content length and a hard streaming cap.
   for(let i=0;i<chosen.length;i++) {
    const f=chosen[i]
    await saveStream(f.url,path.join(temp,`${i}`),{...httpHeaders,...f.http_headers},sizes[i],{signal,exact:sizes[i]})
   }
   const probe0 = JSON.parse((await run('ffprobe',['-v','error','-show_entries','stream=index,codec_type,codec_name,profile','-of','json',path.join(temp,'0')],{...options,maxBuffer:65536})).stdout)
   const probe1 = chosen.length>1 ? JSON.parse((await run('ffprobe',['-v','error','-show_entries','stream=index,codec_type,codec_name,profile','-of','json',path.join(temp,'1')],{...options,maxBuffer:65536})).stdout) : undefined
   const audioStream = (probe1 ? probe1.streams : probe0.streams)?.find(s=>s.codec_type==='audio')
   const needsAudioTranscode = !!audioStream && (audioStream.codec_name!=='aac' || audioStream.profile!=='LC')
   const mapArgs = chosen.length>1 ? ['-i',path.join(temp,'1'),'-map','0:v:0','-map','1:a:0'] : ['-map','0:v:0',...(audioStream?['-map','0:a:0']:[])]
   const codecArgs = ['-c:v','copy',...(audioStream?(needsAudioTranscode?['-c:a','aac','-profile:a','aac_low','-b:a','128k','-ar','48000','-ac','2']:['-c:a','copy']):[])]
   const args=['-nostdin','-v','error','-threads','2','-i',path.join(temp,'0'),...mapArgs,...codecArgs,'-movflags','+faststart',path.join(temp,'out.mp4')]
   try { await run('ffmpeg',args,options) } catch { throw new Error('MERGE_FAILED') }
   try {
    const {stdout}=await run('ffprobe',['-v','error','-show_entries','stream=codec_type,width,height:format=duration','-of','json',path.join(temp,'out.mp4')],{...options,maxBuffer:65536})
    const media=JSON.parse(stdout),v=media.streams?.find(s=>s.codec_type==='video')
    if(!v || !media.streams.some(s=>s.codec_type==='audio') || v.width!==chosen[0].width || v.height!==chosen[0].height || !(Number(media.format?.duration)>0)) throw new Error()
   } catch { throw new Error('MEDIA_INVALID') }
   const bytes=(await stat(path.join(temp,'out.mp4'))).size;if(bytes>LIMIT) throw new Error('SIZE_LIMIT')
   const file=path.join(root,`${Date.now()}${Math.floor(Math.random()*100000)}.mp4`);await rename(path.join(temp,'out.mp4'),file)
   return {ok:true,file,bytes,width:chosen[0].width,height:chosen[0].height,resolution:resolution(chosen[0]),id:info.id}
  } finally {await rm(temp,{recursive:true,force:true})}
 },{signal,budget})
 } catch(e) {
  signal.throwIfAborted()
  if(!refresh && ['NO_SAFE_FORMAT','SIZE_UNKNOWN','DOWNLOAD_FAILED'].includes(e.message) && budget.downloads<4) continue
  throw e
 }
 }
 })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.log(JSON.stringify(errorResult(e)));process.exitCode=1})
