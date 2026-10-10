import { existsSync, readFileSync as nodeReadFileSync } from 'node:fs'
import { readFile as nodeReadFile } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMPANIONS: Record<string, string[]> = {
  WorkbenchDialog: [
    'WorkbenchFoldTool.vue',
    'WorkbenchWindowControls.vue',
    'useWorkbenchDialogController.ts',
    'useWorkbenchContextInspector.ts',
    'useWorkbenchTaskController.ts',
    'useWorkbenchTreeSession.ts',
    'useWorkbenchViewPreferences.ts',
    'WorkbenchDialog.scoped.less',
    'WorkbenchDialog.popovers.less',
  ],
  LiteView: ['useLiteViewController.ts', 'LiteView.styles.css'],
  MessageBranchTree: ['useMessageBranchTreeController.ts', 'MessageBranchTree.styles.less'],
  ExecutionNodePopover: [
    'useExecutionNodePopoverController.ts',
    'ExecutionNodePopover.styles.less',
    'QuestionAnswerDetail.vue',
  ],
  HistoryDrawerPanel: ['useHistoryDrawerPanelController.ts', 'HistoryDrawerPanel.styles.less'],
  SettingsDialog: ['useSettingsDialogController.ts', 'SettingsDialog.styles.less'],
  RolesTab: ['useRolesTabController.ts', 'RolesTab.styles.less'],
  AgentDialog: ['AgentDialog.scoped.less', 'AgentDialog.popovers.less', 'AgentDialog.editor.less'],
  PaperGameCard: ['PaperGameCard.styles.less'],
  NodePaperStack: ['NodePaperStack.styles.less'],
  NyxusPianoStrip: ['NyxusPianoStrip.styles.less'],
  TaskCenterAttentionWorkspace: ['TaskCenterAttentionWorkspace.styles.less'],
  BrainCard: ['BrainCard.styles.less', 'brainFormHelpers.ts'],
  ServerLoginDialog: ['ServerLoginDialog.styles.less'],
  PluginImportDialog: ['PluginImportDialog.styles.less'],
}

function pathOf(input: string | URL): string {
  const path = input instanceof URL ? fileURLToPath(input) : input
  if (existsSync(path)) return path

  const webPath = resolve(process.cwd(), 'apps/web', relative(process.cwd(), path))
  return existsSync(webPath) ? webPath : path
}

function companionPaths(input: string | URL): string[] {
  const path = pathOf(input)
  if (extname(path) !== '.vue') return []
  const name = basename(path, '.vue')
  const declaredStyles = [...nodeReadFileSync(path, 'utf8').matchAll(/<style\b[^>]*\bsrc=["']([^"']+)["']/g)]
    .map((match) => resolve(dirname(path), match[1]!))
  const viewControllers = ['useAgentDialogViewController', 'useWorkbenchDialogViewController',
    'useLiteViewBindings', 'useExecutionNodePopoverViewController']
    .filter((binding) => nodeReadFileSync(path, 'utf8').includes(`from './${binding}'`))
    .map((binding) => resolve(dirname(path), `${binding}.ts`))
  return [...new Set([
    ...(COMPANIONS[name] ?? []).map((file) => resolve(dirname(path), file)),
    ...declaredStyles, ...viewControllers,
  ])].filter(existsSync)
}

export async function readComponentSource(
  input: string | URL,
  encoding: BufferEncoding = 'utf8',
): Promise<string> {
  const sourcePath = pathOf(input)
  const sources = await Promise.all([
    nodeReadFile(sourcePath, encoding),
    ...companionPaths(sourcePath).map((path) => nodeReadFile(path, encoding)),
  ])
  return sources.join('\n').replace(/\r\n/g, '\n')
}

export function readComponentSourceSync(
  input: string | URL,
  encoding: BufferEncoding = 'utf8',
): string {
  const sourcePath = pathOf(input)
  return [
    nodeReadFileSync(sourcePath, encoding),
    ...companionPaths(sourcePath).map((path) => nodeReadFileSync(path, encoding)),
  ]
    .join('\n')
    .replace(/\r\n/g, '\n')
}
