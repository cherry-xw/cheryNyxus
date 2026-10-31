import { expect, it } from 'vitest'
import { sourceStepReason } from '@/agent/middleware/sourceStepReason.js'
import { createMockContext } from '../helpers/fakeContext.js'

it('labels fresh tasks initial even when a different task previously asked a question', () => {
  const ctx = createMockContext({messages:[{id:'old-question',role:'assistant',content:'',createdAt:1,updateAt:1,
    senseCalls:[{id:'old-ask',name:'ask_user_question',arguments:'{}'}]}]})
  expect(sourceStepReason(ctx,0)).toBe('initial')
  expect(sourceStepReason(ctx,1)).toBe('tool_continue')
  ctx.requestSourceStepStarted = true
  expect(sourceStepReason(ctx,0)).toBe('tool_continue')
})
it('labels only the explicit question continuation entry as question_resume', () => {
  const ctx = createMockContext({})
  ctx.requestExecution = {sourceStartReason:'question_resume',validate(){}}
  expect(sourceStepReason(ctx,0)).toBe('question_resume')
  expect(sourceStepReason(ctx,1)).toBe('tool_continue')
})
