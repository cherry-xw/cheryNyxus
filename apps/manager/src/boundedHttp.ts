/** Consume a response within a fixed memory bound, including error responses. */
export async function readResponse(response: Response, maxBytes = 65_536): Promise<string> {
  if (!response.body) throw new Error('response_missing')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks).toString('utf8')
      size += value.byteLength
      if (size > maxBytes) throw new Error('response_too_large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Editable health targets never receive credentials or redirect requests. */
export async function relayReachable(url: string): Promise<boolean> {
  try {
    const target = new URL(`${url.replace(/\/$/, '')}/healthz`)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) return false
    const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(5_000) })
    await readResponse(response)
    return response.ok
  } catch {
    return false
  }
}
