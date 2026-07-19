/**
 * 判断是否为 AsyncGenerator
 */
export function isAsyncGenerator(value: unknown): value is AsyncGenerator {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncGenerator).next === 'function' &&
    typeof (value as AsyncGenerator).return === 'function' &&
    typeof (value as AsyncGenerator).throw === 'function'
  )
}
