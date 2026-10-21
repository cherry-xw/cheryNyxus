import {it,expect,vi} from 'vitest'
import {registerWaitedChild,retainContinuousChild,feedWatchdog,getWaitedParent,setAsyncWakeHandler,clearAllWaitedChildren} from '@/agent/spawnBroker.js'
it('ongoing QQ children do not expire after silence or renewed progress',async()=>{
 vi.useFakeTimers();const timeout=vi.fn();setAsyncWakeHandler(timeout)
 try {
  registerWaitedChild('continuous-child','parent','worker','immediate')
  retainContinuousChild('continuous-child')
  await vi.advanceTimersByTimeAsync(32*86400000)
  feedWatchdog('continuous-child')
  await vi.advanceTimersByTimeAsync(32*86400000)
  expect(timeout).not.toHaveBeenCalled();expect(getWaitedParent('continuous-child')).toBeDefined()
 } finally {clearAllWaitedChildren();setAsyncWakeHandler(()=>{});vi.useRealTimers()}
})
