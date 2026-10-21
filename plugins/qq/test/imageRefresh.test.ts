import { describe, expect, it, vi } from 'vitest'
import { prepareQQFileInputs } from '../src/assetMessages.js'
import { normalize } from '../../../platform/napcat-plugin/src/adapter.js'
import { QQNotificationSchema } from '@chery/protocol'
const message=()=>({eventId:'qq:123:group:456:10',selfId:'123',conversationType:'group' as const,targetId:'456',senderId:'789',senderName:'fixture',messageId:'10',occurredAt:1,content:'',mentionedBot:false,attachments:[{type:'image',url:'https://example.invalid/image?rkey=old'}]})
describe('QQ images have no URL fallback',()=>{
 it.each(['current','history','quote'])('uncollected %s image never downloads or refreshes',async origin=>{
  const image=message(),load=vi.fn(),trigger={...image,messageId:'11',content:'question',attachments:[],...(origin==='quote'?{replyToMessageId:'10'}:{})}
  const parts=await prepareQQFileInputs(origin==='current'?[image]:[trigger],load,new AbortController().signal,{background:origin==='history'?[image]:[],messages:[image],known:{},validate:async()=>{},save(){}})
  expect(load).not.toHaveBeenCalled();expect(parts?.some(p=>p.type==='asset')).toBe(false);expect(JSON.stringify(parts)).toContain('不能读取其内容');expect(JSON.stringify(parts)).not.toContain('rkey')
 })
 it('reuses fixed asset and verifies current grant before historical or quoted input',async()=>{
  const image=message(),load=vi.fn(),validate=vi.fn(),part={type:'asset' as const,partId:'fixed',assetId:'asset',assetVersionId:'version',variant:'original' as const,usage:'content' as const}
  const known={[JSON.stringify(['123','group','456','10',0])]:part}
  const parts=await prepareQQFileInputs([image],load,new AbortController().signal,{messages:[image],known,validate,save(){}})
  expect(parts?.some(p=>p.type==='asset')).toBe(true);expect(validate).toHaveBeenCalledOnce();expect(load).not.toHaveBeenCalled()
  validate.mockRejectedValue(Error('revoked'))
  const rejected=await prepareQQFileInputs([image],load,new AbortController().signal,{messages:[image],known,validate,save(){}})
  expect(rejected?.some(p=>p.type==='asset')).toBe(false)
 })
 it('normalization never retains image URL and shared schema rejects image_refresh',()=>{
  const input=normalize({post_type:'message',message_type:'group',self_id:123,user_id:789,group_id:456,message_id:10,time:1,message:[{type:'image',data:{url:'https://example.invalid/?rkey=secret'}}]},'123')
  expect(JSON.stringify(input)).not.toContain('rkey')
  expect(QQNotificationSchema.safeParse({kind:'notification',type:'qq.information.request',data:{eventId:'refresh',requestId:'request',selfId:'123',conversationType:'group',targetId:'456',seq:1,information:{kind:'image_refresh',count:1,userId:'789',messageId:'10',attachmentIndex:0,occurredAt:1}}}).success).toBe(false)
 })
})
