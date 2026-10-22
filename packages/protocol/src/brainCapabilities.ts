import type { CapabilityField, CapabilityState } from './llm.js'
import type { ImageOutputCapabilities, ImageOutputCapability, ImageOutputOperation } from './imageGeneration.js'

type Value = CapabilityState | boolean
export interface MergeableBrainCapabilities {
  toolCall?: boolean
  input?: Partial<Record<'image' | 'video' | 'audio' | 'pdf', Value>>
  output?: Partial<Record<'image' | 'video' | 'audio', Value>>
  serverTools?: Partial<Record<'webSearch' | 'webReader' | 'imageInspect', Value>>
  imageInput?: { formats?: Array<'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'>; animation?: 'supported' | 'first-frame' | 'unsupported' | 'unknown'; maxBytes?: number; maxBase64Bytes?: number }
}
export function mergeBrainCapabilities(user?: MergeableBrainCapabilities, recommend?: MergeableBrainCapabilities, facts?: MergeableBrainCapabilities) {
  const field = (u?: Value, r?: Value, f?: Value): CapabilityField => {
    const value = u ?? r ?? f
    return { state: value === true ? 'supported' : value === false ? 'unsupported' : value ?? 'unknown', source: u !== undefined ? 'user' : (r ?? f) !== undefined ? 'catalog' : 'default' }
  }
  const group = <K extends string>(keys: K[], u?: Partial<Record<K, Value>>, r?: Partial<Record<K, Value>>, f?: Partial<Record<K, Value>>) =>
    Object.fromEntries(keys.map(key => [key, field(u?.[key], r?.[key], f?.[key])])) as Record<K, CapabilityField>
  return {
    toolCall: { enabled: user?.toolCall ?? recommend?.toolCall ?? facts?.toolCall ?? true, source: user?.toolCall !== undefined ? 'user' as const : (recommend?.toolCall ?? facts?.toolCall) !== undefined ? 'catalog' as const : 'default' as const },
    input: group(['image', 'video', 'audio', 'pdf'], user?.input, recommend?.input, facts?.input),
    output: group(['image', 'video', 'audio'], user?.output, recommend?.output, facts?.output),
    serverTools: group(['webSearch', 'webReader', 'imageInspect'], user?.serverTools, recommend?.serverTools, facts?.serverTools),
    imageInput: { ...facts?.imageInput, ...recommend?.imageInput, ...user?.imageInput },
  }
}
export function mergeImageOutputCapability(operation: ImageOutputOperation, user?: ImageOutputCapabilities, recommend?: ImageOutputCapabilities, facts?: ImageOutputCapabilities) {
  const value: ImageOutputCapability = user?.[operation] ?? recommend?.[operation] ?? facts?.[operation] ?? { nativeMultiImage: 'unknown', countControl: 'unknown' }
  return { value, source: user?.[operation] ? 'user' as const : recommend?.[operation] || facts?.[operation] ? 'catalog' as const : 'default' as const }
}
