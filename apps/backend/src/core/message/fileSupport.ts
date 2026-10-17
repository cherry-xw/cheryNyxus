/** 只列已实现的文件传输格式；模型能力声明不能扩大此表。 */
export function supportsNativeFile(protocol: string | undefined, mime: string): boolean {
  if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime))
    return ['openai-chat-completions', 'openai-responses', 'anthropic-messages'].includes(protocol ?? '')
  if (mime === 'application/pdf') return ['anthropic-messages', 'openai-responses'].includes(protocol ?? '')
  if (protocol === 'openai-chat-completions') return ['audio/wav', 'audio/mpeg', 'video/mp4'].includes(mime)
  return false
}
