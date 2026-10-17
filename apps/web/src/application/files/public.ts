/** File requests use the same authenticated backend identity as chat. */
export { fileApi } from '@/services/fileApi'
export { fileDraftLeases } from './draftLeases'
export type { FileRequestPlan } from '@/services/fileApi'
export type { AssetRecord, MessagePart, FileOperationRecord } from '@chery/protocol'
