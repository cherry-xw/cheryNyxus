import { buildFileServiceToolName, FILE_SERVICE_ADAPTER_CATALOG, type FileCapabilityOperation } from '@chery/protocol'
import type { ConfigDto } from '@/application/backend/public'

export const FILE_OPERATION_LABELS: Record<FileCapabilityOperation, string> = {
  'image.inspect': '图片理解', 'image.generate': '文字生成图片', 'image.reference': '参考图片生成',
  'image.edit': '编辑图片', 'document.extract': '提取文档', 'audio.transcribe': '音频转写', 'video.inspect': '视频理解',
}
export function fileServiceTools(draft: ConfigDto) {
  return Object.entries(draft.file_services ?? {}).flatMap(([id, service]) => service.operations.map(operation => ({
    name: buildFileServiceToolName(id, operation), label: `${service.name} · ${FILE_OPERATION_LABELS[operation]}`,
    description: `${FILE_SERVICE_ADAPTER_CATALOG.find(a => a.id === service.adapter)?.label ?? service.adapter}；${service.enabled === false ? '服务已停用' : '使用前仍检查权限及连接'}`,
    icon: 'file', operations: [operation],
  })))
}
