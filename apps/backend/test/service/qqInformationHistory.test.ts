import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import { createIngressCoreAdapter } from '@/service/ingress/coreAdapter.js'
import { addMessage, getRecentConversationMessages } from '@/db/message.js'

describe('bounded ingress local message query',()=>{
  it('reads saved text before compaction without tool records or other owners',async()=>{
    await bootstrapAgentRuntime()
    const core=createIngressCoreAdapter(),key=randomUUID()
    const {chatId}=await core.ensureConversation('history-test',key,'detail-test')
    const add=(v:any)=>addMessage(randomUUID(),chatId,v)
    add({role:'user',content:'old visible'})
    add({role:'assistant',content:'summary',contextCompaction:true})
    add({role:'sense',content:'private tool result'})
    add({role:'user',content:'revoked',revoked:true})
    add({role:'assistant',content:'excluded',modelExcluded:true})
    add({role:'assistant',content:'x'.repeat(1000)})
    const rows=JSON.parse(await core.recentConversationMessages!('history-test',key,100))
    expect(rows.map((r:any)=>r.content)).toEqual(['old visible','x'.repeat(400)])
    expect(getRecentConversationMessages(chatId,1)).toHaveLength(1)
    await expect(core.recentConversationMessages!('foreign',key,50)).rejects.toThrow()
    await expect(core.recentConversationMessages!('history-test',key,101)).rejects.toThrow()
  })
})
