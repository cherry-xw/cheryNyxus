import { describe, it, expect } from 'vitest'
import { searchProviders, parseSearchResponse, searchSettingsSchema } from '../../../src/agent/sense/web/searchService.js'
const settings = { providers: ['anysearch', 'parallel', 'exa'] as ('anysearch'|'parallel'|'exa')[], proxyEnabled: false, proxyUrl: '' }
describe('multi search routing', () => {
 it('falls back on invalid response and records actual selected provider', async () => {
  let calls=0
  const result = await searchProviders({query:'test',limit:2},settings,new AbortController().signal,async () => {
   calls++; if(calls===1)return JSON.stringify({code:0,data:{results:[]}})
   return JSON.stringify({result:{content:[{type:'text',text:JSON.stringify({results:[{title:'Example',url:'https://example.org',excerpts:['verified fixture']} ]})}]}})
  })
  expect(calls).toBe(2); expect(result.selectedProvider).toBe('parallel'); expect(result.attempts?.[0].ok).toBe(false)
 })
 it('rejects rate limit disguised as HTTP success', () => expect(() => parseSearchResponse('exa',JSON.stringify({result:{_meta:{'ai.exa/rateLimited':true},content:[]}}))).toThrow())
 it('never continues after cancellation', async () => {const c=new AbortController();c.abort();await expect(searchProviders({query:'test',limit:1},settings,c.signal)).rejects.toThrow()})
 it('rejects credential proxy and DuckDuckGo settings', () => {expect(searchSettingsSchema.safeParse({...settings,proxyUrl:'http://user:pass@host:7890'}).success).toBe(false);expect(searchSettingsSchema.safeParse({...settings,providers:['duckduckgo']}).success).toBe(false)})
})
