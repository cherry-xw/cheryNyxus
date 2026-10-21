import type { Writable } from 'node:stream'
export function drain(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { stream.off('drain', ready); stream.off('error', fail); stream.off('close', closed) }
    const ready = () => { cleanup(); resolve() }
    const fail = (error: Error) => { cleanup(); reject(error) }
    const closed = () => fail(new Error('Stream closed'))
    stream.once('drain', ready); stream.once('error', fail); stream.once('close', closed)
  })
}
