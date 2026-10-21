import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Adapter } from '../../../../platform/napcat-plugin/src/adapter.js'
import { ErrorCode, feedbackForRpcError, publicFileHttpFailure, publicOutcomeText, QQNotificationSchema } from '@chery/protocol'
import declarations from './fixtures/qqOutcomeDeclarationScope.json'

const root=path.resolve(import.meta.dirname,'../../../..')
describe('audited declaration applicability (not all repository strings)',()=>{
  it('accounts for exactly 166 distinct audit entries',()=>{
    expect(declarations).toHaveLength(166)
    expect(new Set(declarations.map(row=>row.id)).size).toBe(166)
  })
  it.each(declarations)('$id $scope $file:$auditLine',row=>{
    expect(['direct','related-contract','outside-outcome-mapping']).toContain(row.scope)
    expect(row.verification.length).toBeGreaterThan(20)
    expect(fs.readFileSync(path.join(root,row.file),'utf8')).toContain(row.declaration)
    expect(createHash('sha256').update(fs.readFileSync(path.join(root,row.file))).digest('hex')).toBe(row.sourceSha256)
  })
})
describe('RPC retry and unknown mapping matrix',()=>{
  it.each(Object.values(ErrorCode).flatMap(code=>[true,false].map(retryable=>({code,retryable}))))('$code retryable=$retryable',({code,retryable})=>{
    const feedback=feedbackForRpcError({code,retryable,message:'SECRET /private/path',source:'system',tracingId:'0123abcd'})
    expect(JSON.stringify(feedback)).not.toContain('SECRET')
    if(!retryable){expect(feedback.actions.some(action=>action.type==='retry')).toBe(false);expect(feedback.guidance).toContain('不会自动重试')}
  })
  it.each(['FUTURE_CODE','toString','__proto__','constructor'])('unknown %s never becomes success or unsafe exception prose',code=>{
    expect(publicOutcomeText({status:code,reasonCode:code})).toContain('结果尚未确认')
    expect(()=>feedbackForRpcError({code,retryable:false,message:'SECRET',source:'system',tracingId:'0123abcd'})).not.toThrow()
  })
})
describe('public file HTTP causes',()=>{
  it.each([['ENOENT',404],['ASSET_UNAVAILABLE',404],['PAYLOAD_TOO_LARGE',413],['ENOSPC',507],['EDQUOT',507],['EACCES',403],['EPERM',403],['FUTURE',400]] as const)('%s remains safe', (code,status)=>{
    const failure=publicFileHttpFailure(Object.assign(new Error('SECRET /private/path https://fixture/?token=SECRET'),{code}))
    expect(failure.status).toBe(status);expect(JSON.stringify(failure)).not.toContain('SECRET');expect(failure.error.message.length).toBeGreaterThan(8)
  })
})

describe('notification required-field matrix',()=>{
  const identity={selfId:'123',conversationType:'group',targetId:'456',requestId:'fixture',eventId:'fixture',seq:1}
  it.each([
    ['qq.reply.action',{actionKind:'reaction',messageId:'11',emojiId:'4',completeReply:true},['actionKind','messageId','emojiId','completeReply']],
    ['qq.reply.action',{actionKind:'quote',messageId:'11',text:'question',completeReply:false},['messageId','text']],
    ['qq.reply.action',{actionKind:'poke',userId:'789',completeReply:false},['userId']],
    ['qq.reply.action',{actionKind:'voice',character:'voice',text:'hello',completeReply:true},['character','text']],
    ['qq.reply.action',{actionKind:'mention',userId:'789',text:'hello',completeReply:true},['userId','text']],
    ['qq.message.ack',{messageId:'11',emojiId:'4'},['messageId','emojiId']],
    ['qq.tool.icon',{icon:'🔧'},['icon']],
    ['qq.lookup.request',{lookupId:'lookup',lookupKind:'members'},['lookupId','lookupKind']],
    ['qq.information.request',{lookupId:'info',information:{kind:'history',count:1,userId:'789'}},['lookupId','information']],
    ['qq.reply.file',{asset:{assetId:'asset',assetVersionId:'version',originalName:'file',mimeType:'text/plain',sizeBytes:1,sha256:'a'.repeat(64)}},['asset']],
    ['qq.reply.video',{mediaFile:'1.mp4'},['mediaFile']],
    ['qq.reply.images',{mediaFiles:['1-1.png']},['mediaFiles']],
    ['qq.waiting',{text:'waiting'},['text']],
    ['qq.request.failed',{text:'failed'},['text']],
    ['qq.reply.part',{partIndex:1,totalParts:1,text:'hello'},['partIndex','totalParts','text']],
  ] as const)('%s validates each action requirement',(type,fields,required)=>{
    expect(QQNotificationSchema.safeParse({kind:'notification',type,data:{...identity,...fields}}).success).toBe(true)
    for(const key of required){const data:Record<string,unknown>={...identity,...fields};delete data[key];expect(QQNotificationSchema.safeParse({kind:'notification',type,data}).success,key).toBe(false)}
  })
  it('rejects reply part indexes beyond totalParts',()=>{
    expect(QQNotificationSchema.safeParse({kind:'notification',type:'qq.reply.part',data:{...identity,partIndex:2,totalParts:1,text:'hello'}}).success).toBe(false)
  })
})

describe('native failed receipt durable readback (A02/A13)',()=>{
  const roots:string[]=[]
  afterEach(()=>{for(const dir of roots.splice(0))fs.rmSync(dir,{recursive:true,force:true})})
  it.each(['reaction','poke'].flatMap(kind=>[{result:false},{status:'failed'},{retcode:1400}].map(result=>({kind,result}))))('$kind $result stays failed after Adapter reconstruction without repeating native action',async({kind,result})=>{
    const dataPath=fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!,'qq-receipt-'));roots.push(dataPath)
    const call=vi.fn(async()=>result),request=vi.fn(async()=>({success:true}))
    const make=()=>{const adapter=new Adapter({dataPath,actions:{call},logger:{},pluginManager:{config:{}}} as any,{request} as any);(adapter as any).selfId='123';(adapter as any).authenticated=true;return adapter as any}
    const frame={kind:'notification',type:'qq.reply.action',data:{selfId:'123',conversationType:'group',targetId:'456',requestId:'request',eventId:'failed-native',seq:1,actionKind:kind,messageId:'11',emojiId:'4',userId:'789',completeReply:false}}
    const first=make();await first.notification(frame)
    expect(first.journal.outputs['failed-native'].status).toBe('failed')
    const restarted=make();expect(restarted.journal.outputs['failed-native'].status).toBe('failed')
    await restarted.notification(frame)
    expect(call).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(2)
    for(const args of request.mock.calls)expect((args as unknown as any[])[1]).toMatchObject({status:'failed',messageIds:[]})
  })
})
