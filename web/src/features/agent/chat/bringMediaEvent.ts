/**
 * 历史媒体「重新带进上下文」跨组件事件通道。
 *
 * 背景：历史气泡/生成结果里的媒体（MediaInlineRenderer 渲染）与底部 composer 不在同一组件树，
 * 通过 window CustomEvent 广播，AgentDialog（composer 宿主）监听后把媒体作为附件加入待发送列表
 * （文件已在服务器，不重新上传，下一轮发送即携带）。
 */
export interface BringMediaPayload {
  filename: string
  kind: 'image' | 'video' | 'audio'
  mimeType: string
}

export const BRING_MEDIA_INTO_CONTEXT_EVENT = 'chery:bring-media-into-context'

export function dispatchBringMediaIntoContext(payload: BringMediaPayload): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<BringMediaPayload>(BRING_MEDIA_INTO_CONTEXT_EVENT, { detail: payload }),
  )
}
