import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir, mkdtemp, stat, rename, rm} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {pathToFileURL} from 'node:url'
import {withDownloadLock} from './download.mjs'
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
export function selectFormats(formats) {
 const audio = formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none').sort((a,b)=>(a.abr || a.tbr || 0)-(b.abr || b.tbr || 0))[0]
 return formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height <= 1080 && f.ext === 'mp4' && (!f.acodec || f.acodec === 'none' ? audio : true)).sort((a,b)=>b.height-a.height || (a.tbr||0)-(b.tbr||0)).map(v=>[v,...(v.acodec && v.acodec !== 'none' ? [] : [audio])])
}
async function size(f, headers) {
 const u = new URL(f.url)
 if(u.protocol !== 'https:' || !['.bilivideo.com','.bilivideo.cn','.akamaized.net'].some(h=>u.hostname.endsWith(h))) throw new Error('Unexpected media host')
 // 1) HEAD 探测 content-length（upos CDN 支持）。
 try {
   const r = await fetch(u,{method:'HEAD',headers,redirect:'error',signal:AbortSignal.timeout(15000)})
   const n = Number(r.headers.get('content-length'))
   if(r.ok && Number.isSafeInteger(n) && n>0) return n
 } catch { /* fall through */ }
 // 2) yt-dlp 已给出的近似大小（零额外请求，误差极小）。
 if(Number.isSafeInteger(f.filesize_approx) && f.filesize_approx>0) return f.filesize_approx
 // 3) GET Range bytes=0-0 探测精确大小（mcdn CDN 对 HEAD 返回 404，但支持 Range GET）。
 try {
   const r = await fetch(u,{method:'GET',headers:{...headers,Range:'bytes=0-0'},redirect:'error',signal:AbortSignal.timeout(15000)})
   if(r.status===206){
     const total = Number((r.headers.get('content-range')||'').split('/')[1])
     if(Number.isSafeInteger(total) && total>0) return total
   }
 } catch { /* fall through */ }
 throw new Error('SIZE_UNKNOWN')
}
async function resolveShort(u) {
 const r = await fetch(u, {method:'HEAD', redirect:'manual', headers:{'User-Agent': USER_AGENTS[0]}, signal:AbortSignal.timeout(15000)})
 const loc = r.headers.get('location')
 return loc ? new URL(loc, u).href : u
}
async function main(url) {
 const u = new URL(url)
 if(u.protocol!=='https:' || u.username || u.password || !['b23.tv','www.bilibili.com','bilibili.com'].includes(u.hostname)) throw new Error('Invalid Bilibili URL')
 let target = url
 if(u.hostname==='b23.tv'){
  for(let attempt=0;attempt<3;attempt++){
   try { target = await resolveShort(url); break } catch { if(attempt===2) throw new Error('SIZE_UNKNOWN') }
  }
 }
 const bin = path.join(os.homedir(),'.local/bin/yt-dlp')
 const options={timeout:210000,maxBuffer:8*1024*1024}
 let stdout
 for(let attempt=0;attempt<4;attempt++){
  const ua = USER_AGENTS[attempt % USER_AGENTS.length]
  try { ({stdout} = await run(bin,['--ignore-config','--playlist-items','1','--skip-download','--dump-single-json','--socket-timeout','15','--retries','1','--user-agent',ua,target],options)); break }
  catch(e){ if(attempt===3) throw e; await new Promise(r=>setTimeout(r,4000*(attempt+1))) }
 }
 const info=JSON.parse(stdout)
 const formats=info.formats?.length?info.formats:(info.entries?.[0]?.formats||[])
const httpHeaders=info.http_headers??info.entries?.[0]?.http_headers??{}
 let chosen, sizes, unknown = false
 for(const pair of selectFormats(formats)) {
  try { const values=await Promise.all(pair.map(f=>size(f,{...httpHeaders,...f.http_headers}))); if(values.reduce((a,b)=>a+b,0)<=LIMIT-1024*1024) {chosen=pair;sizes=values;break} } catch(e) { if(e.message!=='SIZE_UNKNOWN') throw e; unknown = true }
 }
 if(!chosen) throw new Error(unknown ? 'SIZE_UNKNOWN' : 'SIZE_LIMIT')
 const root=process.env.CHERY_MEDIA_DIR || path.join(os.homedir(),'media'); await mkdir(root,{recursive:true})
 return withDownloadLock(root,async()=>{
  const temp=await mkdtemp(path.join(root,'.bili-'))
  try {
   // Each stream uses the verified content length and a hard streaming cap.
   for(let i=0;i<chosen.length;i++) {
    const f=chosen[i];const {saveStream}=await import('./limits.mjs')
    await saveStream(f.url,path.join(temp,`${i}`),{...httpHeaders,...f.http_headers},LIMIT)
   }
   const args=['-v','error','-i',path.join(temp,'0'),...(chosen.length>1?['-i',path.join(temp,'1'),'-map','0:v:0','-map','1:a:0']:[]),'-c','copy','-movflags','+faststart',path.join(temp,'out.mp4')]
   await run('ffmpeg',args,options)
   const bytes=(await stat(path.join(temp,'out.mp4'))).size;if(bytes>LIMIT) throw new Error('SIZE_LIMIT')
   const file=path.join(root,`${Date.now()}${Math.floor(Math.random()*100000)}.mp4`);await rename(path.join(temp,'out.mp4'),file)
   return {ok:true,file,bytes,height:chosen[0].height,id:info.id}
  } finally {await rm(temp,{recursive:true,force:true})}
 })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.log(JSON.stringify({ok:false,error:e.message.includes('SIZE_')?e.message:'BILIBILI_DOWNLOAD_FAILED'}));process.exitCode=1})
