import { expect, it, vi } from 'vitest'
import { prepareQQFileInputs } from '../../../../plugins/qq/src/assetMessages.js'
it('old QQ historical image URLs remain unavailable without network or refresh',async()=>{
 const image={eventId:'old',selfId:'123',targetId:'456',conversationType:'group' as const,senderId:'789',senderName:'fixture',messageId:'100',content:'old image',mentionedBot:false,occurredAt:1,attachments:[{type:'image',url:'https://example.invalid/image?rkey=expired'}]}
 const trigger={...image,eventId:'current',messageId:'101',content:'question',mentionedBot:true,attachments:[]}
 const download=vi.fn()
 const parts=await prepareQQFileInputs([trigger],download,new AbortController().signal,{messages:[image],background:[image],known:{},validate:async()=>{},save(){}})
 expect(download).not.toHaveBeenCalled();expect(parts?.some(p=>p.type==='asset')).toBe(false);expect(JSON.stringify(parts)).toContain('不能读取其内容');expect(JSON.stringify(parts)).not.toContain('rkey')
})
