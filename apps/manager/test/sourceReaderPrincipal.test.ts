import { Readable } from 'node:stream'
import type { IncomingMessage,ServerResponse } from 'node:http'
import { describe,expect,it,vi } from 'vitest'
import { ManagerAuth } from '../src/auth.js'
import type { AccountStore } from '../src/accountStore.js'

function response(){
  const headers=new Map<string,string>();let body=''
  return {setHeader:(key:string,value:string)=>headers.set(key.toLowerCase(),value),getHeader:(key:string)=>headers.get(key.toLowerCase()),
    writeHead:vi.fn(),end:(value:string)=>{body=value},headers,json:()=>JSON.parse(body)}
}
const origin='http://localhost:39980'
function request(method='GET',cookie='',body?:object){
  return Object.assign(Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]),{method,headers:{origin,cookie,'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}}) as IncomingMessage
}
describe('Manager non-secret source reading identity',()=>{
  it('keeps reading identities private and distinct across login sessions, and revokes them on logout and account replacement',async()=>{
    let revision='one',now=1000
    const store={read:vi.fn(async()=>({revision,username:'owner'})),verify:vi.fn(async()=>true)} as unknown as AccountStore
    const auth=new ManagerAuth(store,{sessionTtlMs:1000},()=>now)
    const login=async()=>{
      const res=response()
      await auth.authorize(request('POST','',{username:'owner',password:'not-used-by-mock'}),res as unknown as ServerResponse,'/api/auth/login',origin)
      expect(res.json()).toEqual({authenticated:true})
      const cookie=res.headers.get('set-cookie')!.split(';')[0]
      return {cookie,principal:auth.managementPrincipal(request('GET',cookie))!}
    }
    const first=await login(),second=await login()
    expect(first.principal).toMatch(/^[a-f0-9]{48}$/)
    expect(first.principal).not.toBe(second.principal);expect(first.cookie).not.toContain(first.principal)
    const me=response()
    await auth.authorize(request('GET',first.cookie),me as unknown as ServerResponse,'/api/auth/me',origin)
    expect(me.json()).toEqual({authenticated:true,username:'owner',provider:'password',expiresAt:2000})
    const logout=response()
    await auth.authorize(request('POST',first.cookie),logout as unknown as ServerResponse,'/api/auth/logout',origin)
    expect(auth.managementPrincipal(request('GET',first.cookie))).toBeUndefined()
    expect(auth.managementPrincipal(request('GET',second.cookie))).toBe(second.principal)
    revision='two'
    await auth.authorize(request('GET',second.cookie),response() as unknown as ServerResponse,'/api/status',origin)
    expect(auth.managementPrincipal(request('GET',second.cookie))).toBeUndefined()
    const third=await login();now=2001
    expect(auth.managementPrincipal(request('GET',third.cookie))).toBeUndefined()
  })
})
