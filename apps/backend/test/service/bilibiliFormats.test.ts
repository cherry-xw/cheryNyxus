import { describe, it, expect, vi } from 'vitest'
import { allowedMediaUrl, selectFormats, size, tryCandidates, validateShareUrl } from '../../../../plugins/qq/skills/douyin-download-send/scripts/bilibili.mjs'
const audio = (id: string, host='x.bilivideo.cn') => ({ format_id:id,url:`https://${host}/${id}`,vcodec:'none',acodec:'aac',abr:10 })
const video = (id: string,width=1080,height=1920) => ({format_id:id,url:`https://x.bilivideo.cn/${id}`,ext:'mp4',vcodec:'avc1',acodec:'none',width,height})
describe('bounded Bilibili format selection',()=>{
 it('falls back from oversized 1080P to 720P',async()=>{
  const probe=vi.fn(async(f:any)=>f.format_id==='large'?200*1024*1024:1000)
  const attempt=vi.fn(async(p:any[])=>p[0].format_id)
  await expect(tryCandidates([audio('a'),video('large'),video('small',720,1280)],{},attempt,{probe})).resolves.toBe('small')
  expect(attempt).toHaveBeenCalledOnce()
 })
 it('retries another safe audio after a download failure and caches sizes',async()=>{
  const probe=vi.fn(async()=>1000),attempt=vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce('ok')
  await expect(tryCandidates([audio('a'),audio('b'),video('v')],{},attempt,{probe})).resolves.toBe('ok')
  expect(probe).toHaveBeenCalledTimes(3)
 })
 it('skips unknown audio size without losing other candidates',async()=>{
  const probe=vi.fn(async(f:any)=>{if(f.format_id==='a')throw new Error('SIZE_UNKNOWN');return 1000})
  await expect(tryCandidates([audio('a'),audio('b'),video('v')],{},async()=>true,{probe})).resolves.toBe(true)
 })
 it('bounds actual download attempts across metadata refreshes',async()=>{
  const budget={downloads:3},attempt=vi.fn(async()=>{throw new Error('network')})
  await expect(tryCandidates([audio('a'),audio('b'),video('v')],{},attempt,{probe:async()=>1000,budget})).rejects.toThrow('ATTEMPT_LIMIT')
  expect(attempt).toHaveBeenCalledOnce()
 })
 it('does not download video without any safe audio',async()=>{
  const attempt=vi.fn()
  await expect(tryCandidates([audio('a','bad.test'),video('v')],{},attempt)).rejects.toThrow('NO_SAFE_FORMAT')
  expect(attempt).not.toHaveBeenCalled()
 })
 it('recognizes square videos and prefers AVC at the same resolution',()=>{
  expect(selectFormats([audio('a'),{...video('hevc',1080,1080),vcodec:'hvc1'},video('avc',1080,1080)])[0][0].format_id).toBe('avc')
 })
 it('rejects unsafe share redirects',()=>expect(()=>validateShareUrl('https://evil.test/video/BV1')).toThrow('INVALID_URL'))
 it('skips unsupported CDN audio and retains all safe alternatives',()=>{
  const pairs=selectFormats([audio('bad','x.edge.mountaintoys.cn'),audio('a'),audio('b'),video('v')])
  expect(pairs.map((p:any[])=>p.map(x=>x.format_id))).toEqual([['v','a'],['v','b']])
 })
 it('recognizes portrait 1080P and excludes higher or unknown resolutions',()=>{
  expect(selectFormats([audio('a'),video('720',720,1280),video('1080'),video('2k',1440,2560),video('unknown',0,0)]).map((p:any[])=>p[0].format_id)).toEqual(['1080','720'])
 })
 it.each(['http://x.bilivideo.cn/a','https://bilivideo.cn.evil.test/a','https://a:b@x.bilivideo.cn/a','https://x.bilivideo.cn:8443/a','https://127.0.0.1/a'])('rejects unsafe URL %s',url=>expect(allowedMediaUrl(url)).toBe(false))
 it('requires audio for video-only formats',()=>expect(selectFormats([video('v')])).toEqual([]))
 it('uses exact Range size, cancels response body and ignores estimates',async()=>{
  const cancel=vi.fn(async()=>{});const request=vi.fn().mockResolvedValueOnce({ok:false,headers:new Headers()}).mockResolvedValueOnce({status:206,headers:new Headers({'content-range':'bytes 0-0/12345'}),body:{cancel}})
  await expect(size({...audio('a'),filesize_approx:1},{},request as unknown as typeof fetch)).resolves.toBe(12345)
  expect(cancel).toHaveBeenCalledOnce()
 })
 it('rejects unknown size even when approximate size exists',async()=>{
  const request=vi.fn(async()=>({ok:false,status:404,headers:new Headers(),body:{cancel:async()=>{}}}))
  await expect(size({...audio('a'),filesize_approx:1},{},request as unknown as typeof fetch)).rejects.toThrow('SIZE_UNKNOWN')
 })
})
