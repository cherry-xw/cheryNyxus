import type { FileHandle } from 'node:fs/promises'
export interface SourceWorkspaceScope {
  ownerId: string; selfId: string; conversationType: 'group' | 'private'; targetId: string; scopeId: string; permissionRevision: number
}
export interface SourceWorkspaceAccess {
  sourceRoot: string; sharedRoot: string; scope: SourceWorkspaceScope; validate(): void | Promise<void>; signal?: AbortSignal
}
export interface SourceZipMount {
  slotKey: string; scope: 'source'; scopeId: string; containerPath: string; cwd: string; extractedDir: string
  entryFile: 'archive.zip'; sizeBytes: number; sha256: string
}
export function sourceDirectory(scope: SourceWorkspaceScope): string
export function separateSourceRoot(sourceRoot: string, sharedRoot: string): string
export function openSourceDirectory(root: string, segments?: string[], create?: boolean): Promise<FileHandle>
export function stageSourceZip(input: SourceWorkspaceAccess & {
  source: { recordId: string; revision: number; partId: string }; senderId: string; originalName: string
  asset: { assetId: string; assetVersionId: string; sizeBytes: number; sha256: string }; body: Uint8Array
}): Promise<SourceZipMount>
export function readSourceZipText(input: SourceWorkspaceAccess & { slotKey: string; path: string; start?: number; length?: number }): Promise<{
  startCodePoint: number; endCodePoint: number; text: string; nextStart: number | null; complete: boolean
}>
