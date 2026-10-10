/**
 * 异步控制原语：单飞（去重并发）与过期守卫（丢弃迟到回写）。
 *
 * 两类原语语义不同、不可互换：
 * - `runSingleFlight`：相同操作正在进行时直接复用同一个 Promise，不发第二个请求
 *   （适合「参数相同、重复触发无意义」的场景，如订阅打开、配置刷新）。
 * - `createStaleGuard`：每次新调用都使旧调用作废，允许并发重叠，响应回来时比对
 *   序号决定是否应用（适合「参数会变、新请求必须作废旧请求」的场景，如搜索、
 *   tab 切换、分页加载）。
 */

/** 单飞执行：key 相同的并发调用共享同一个 Promise；结束后仅清理自己的登记。 */
export function runSingleFlight<K, T>(
  inFlight: Map<K, Promise<T>>,
  key: K,
  task: () => Promise<T>,
): Promise<T> {
  const current = inFlight.get(key)
  if (current) return current
  const promise = task()
  inFlight.set(key, promise)
  return promise.finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key)
  })
}

/** 过期守卫：递增序号 + 当前性比对，丢弃迟到的异步回写。 */
export interface StaleGuard {
  /** 开启新一轮调用，返回本轮序号。 */
  next(): number
  /** 读取当前序号（不递增；沿用当前轮的在途调用用）。 */
  peek(): number
  /** 判断序号是否仍是当前轮（不是则应丢弃回写）。 */
  isCurrent(seq: number): boolean
  /** 使所有在途回写作废（如重置面板时）。 */
  invalidate(): void
}

export function createStaleGuard(): StaleGuard {
  let seq = 0
  return {
    next: () => {
      seq += 1
      return seq
    },
    peek: () => seq,
    isCurrent: (candidate) => candidate === seq,
    invalidate: () => {
      seq += 1
    },
  }
}
