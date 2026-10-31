import { describe, expect, it } from 'vitest'
import { discussionInputChunks, splitMaintenanceBlock } from '../src/sourceMaintenance.js'

describe('QQ source maintenance budgets',()=>{
  it('splits only the rejected block without changing completed receipt indices or dropping Unicode',()=>{
    const raw='中文😀\\"\n'.repeat(4000),inputs=['completed-block',...discussionInputChunks(raw),'later-block']
    const original=inputs[1]!
    splitMaintenanceBlock(inputs,1)
    expect(inputs[0]).toBe('completed-block');expect(inputs.at(-1)).toBe('later-block')
    const fragments=inputs.slice(1,-1)
    expect(fragments.length).toBeGreaterThan(1)
    // A split wraps the entire rejected serialized fragment, including all offsets.
    expect(fragments.flatMap(block=>JSON.parse(block)).map(fragment=>fragment.text).join('')).toBe(original)
    expect(fragments.every(block=>block.length<original.length)).toBe(true)
  })
  it('rejects fixed overhead that leaves no useful room instead of repeating the same call',()=>{
    expect(()=>splitMaintenanceBlock(['small'],0)).toThrow('SUMMARY_BUDGET_FAILED')
  })
})
