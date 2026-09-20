<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { canReferenceFile } from '../../composables/commands'
import type { WorkspaceFileEntry } from '@/application/backend/public'
import { useWorkbenchFiles } from './useWorkbenchFiles'
import WorkbenchFileIcon from './WorkbenchFileIcon.vue'
import WorkbenchTerminal from '../terminal/WorkbenchTerminal.vue'

const props = defineProps<{ chatId: string }>()
const emit = defineEmits<{ reference: [path: string, kind: 'file' | 'directory'] }>()
const {
  directories,
  expanded,
  tabs,
  residentTabs,
  openedFiles,
  activePath,
  activate,
  active,
  rows,
  workspace,
  highlighted,
  load,
  refresh,
  open,
  close,
  closeSide,
  closeOthers,
  closeAll,
  refreshFile,
} = useWorkbenchFiles(() => props.chatId)
import { agentApi } from '@/application/backend/public'
const gitStatus = ref<Awaited<ReturnType<typeof agentApi.getWorkspaceGitStatus>> | null>(null)
const gitError = ref('')
async function loadGit() { try { gitStatus.value = await agentApi.getWorkspaceGitStatus(props.chatId); gitError.value = '' } catch { gitStatus.value = null; gitError.value = '' } }
async function checkout(branch: string) { try { await agentApi.checkoutWorkspaceGit(props.chatId, branch); await loadGit(); await refresh() } catch (e) { gitError.value = e instanceof Error ? e.message : '分支切换失败' } }
async function refreshWorkspace() { await refresh(); await loadGit() }
onMounted(() => { void loadGit() })

const mode = ref<'files' | 'terminal'>('files')
const terminalOpened = ref(false)
const terminalLabel = ref('Terminal')
const wrapLines = ref(false)
const treeWidth = ref(28)
const resizing = ref(false)
const contextMenu = ref<{ x: number; y: number; path: string } | null>(null)
function showContextMenu(event: MouseEvent, path: string) { event.preventDefault(); contextMenu.value = { x: event.clientX, y: event.clientY, path } }
function hideContextMenu() { contextMenu.value = null }
function copyPath(path: string) { void navigator.clipboard?.writeText(path); hideContextMenu() }
function referencePath(path: string, kind: 'file' | 'directory' = 'file') { emit('reference', path, kind); hideContextMenu() }

const binaryPreview = computed(() => {
  const base64 = active.value?.content?.kind === 'binary' ? active.value.content.content : undefined
  if (!base64 || typeof atob === 'undefined') return []
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  const rows: Array<{ offset: string; hex: string; ascii: string }> = []
  for (let index = 0; index < bytes.length; index += 16) {
    const chunk = bytes.slice(index, index + 16)
    rows.push({
      offset: index.toString(16).padStart(8, '0'),
      hex: Array.from(chunk, (byte) => byte.toString(16).padStart(2, '0'))
        .join(' ')
        .padEnd(47, ' '),
      ascii: Array.from(chunk, (byte) =>
        byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '·',
      ).join(''),
    })
  }
  return rows
})

function openEntry(entry: WorkspaceFileEntry): void {
  mode.value = 'files'
  void open(entry)
}
function openTerminal(): void {
  mode.value = 'terminal'
  terminalOpened.value = true
}
function closeTerminal(): void {
  terminalOpened.value = false
  mode.value = 'files'
}
function startTreeResize(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement
  const body = target.parentElement
  if (!body) return
  resizing.value = true
  target.setPointerCapture(event.pointerId)
  const move = (moveEvent: PointerEvent) => {
    const rect = body.getBoundingClientRect()
    treeWidth.value = Math.max(18, Math.min(55, ((moveEvent.clientX - rect.left) / rect.width) * 100))
  }
  const stop = () => {
    resizing.value = false
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', stop)
    target.removeEventListener('pointercancel', stop)
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', stop)
  target.addEventListener('pointercancel', stop)
}
</script>

<template>
  <section class="workbench-files" aria-label="工作区文件与 Terminal">
    <div class="files-body" :class="{ 'is-resizing': resizing }" :style="{ '--tree-width': `${treeWidth}%` }">
      <aside class="files-tree" aria-label="工作区文件列表">
        <div class="tree-heading">
          <span>工作区文件</span>
          <span class="tree-actions">
            <el-tooltip content="刷新工作区" placement="bottom" :show-after="450">
              <button type="button" class="tree-action-icon" aria-label="刷新工作区" @click="refreshWorkspace">
                <el-icon :size="14"><Refresh /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip content="打开 Terminal" placement="bottom" :show-after="450">
              <button type="button" class="tree-action-icon" aria-label="打开 Terminal" @click="openTerminal">
                <svg class="tree-action-svg" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m4 17 6-6-6-6" />
                  <path d="M12 19h8" />
                </svg>
              </button>
            </el-tooltip>
            <select v-if="gitStatus" :value="gitStatus.branch" aria-label="Git branch" @change="checkout(($event.target as HTMLSelectElement).value)">
              <option v-for="branch in gitStatus.branches" :key="branch" :value="branch">{{ branch }}</option>
            </select>
          </span>
        </div>
        <div class="workspace-path" :title="workspace || '当前会话工作区'">
          {{ workspace || '当前会话工作区' }}
        </div>
        <p v-if="gitError" class="tree-error">{{ gitError }}</p>
        <p
          v-if="directories.get('')?.loading && directories.get('')?.showLoading"
          role="status"
          class="tree-loading"
        >
          <span class="loading-dot" aria-hidden="true" /> 正在加载工作区…
        </p>
        <p v-if="directories.get('')?.error" role="alert" class="tree-error">
          {{ directories.get('')?.error }}
        </p>
        <p
          v-if="directories.get('') && !directories.get('')?.loading && !directories.get('')?.error && !rows.length"
          class="tree-empty"
        >
          工作区为空
        </p>
        <div v-for="{ entry, depth } in rows" :key="entry.path">
          <div class="file-row" :style="{ paddingLeft: depth * 16 + 6 + 'px' }" @contextmenu="showContextMenu($event, entry.path)">
            <button
              type="button"
              class="file-open"
              :aria-expanded="entry.kind === 'directory' ? expanded.has(entry.path) : undefined"
              @click="openEntry(entry)"
            >
              <span class="file-arrow">{{
                entry.kind === 'directory' ? (expanded.has(entry.path) ? '▾' : '▸') : ''
              }}</span>
              <WorkbenchFileIcon :name="entry.name" :kind="entry.kind" />
              <el-tooltip :content="entry.name" placement="top" :show-after="450">
                <span class="file-name">{{ entry.name }}</span>
              </el-tooltip>
              <span v-if="gitStatus?.files.some((file) => file.path === entry.path)" class="git-mark" aria-label="已修改">{{ gitStatus.files.find((file) => file.path === entry.path)?.status === 'added' ? 'A' : 'M' }}</span>
            </button>
            <el-tooltip
              :content="
                !canReferenceFile(entry.path)
                  ? '路径包含暂不支持的字符，无法引用'
                  : entry.kind === 'directory'
                    ? 'and 这个文件夹'
                    : 'and 这个文件'
              "
            >
              <span>
                <button
                  type="button"
                  class="file-reference"
                  :disabled="!canReferenceFile(entry.path)"
                  :aria-label="
                    (entry.kind === 'directory' ? 'and 这个文件夹 ' : 'and 这个文件 ') + entry.path
                  "
                  @click="emit('reference', entry.path, entry.kind)"
                >
                  &amp;
                </button>
              </span>
            </el-tooltip>
          </div>
          <p
            v-if="expanded.has(entry.path) && directories.get(entry.path)?.loading && directories.get(entry.path)?.showLoading"
            class="tree-status"
          >
            <span class="loading-dot" aria-hidden="true" /> 正在加载…
          </p>
          <button
            v-if="expanded.has(entry.path) && directories.get(entry.path)?.error"
            type="button"
            class="tree-error"
            @click="load(entry.path)"
          >
            {{ directories.get(entry.path)?.error }} · 重试
          </button>
        </div>
        <div v-for="[path, directory] in directories" :key="path">
          <button
            v-if="expanded.has(path) && directory.nextOffset !== undefined"
            type="button"
            :disabled="directory.loading"
            @click="load(path, true)"
          >
            加载更多 {{ path || '工作区' }} 文件
          </button>
        </div>
      </aside>
      <div class="files-resizer" role="separator" aria-label="调整文件列表宽度" @pointerdown="startTreeResize" />

      <main class="files-main">
        <div class="file-viewer">
          <nav v-if="tabs.length || terminalOpened" class="file-tabs" aria-label="打开的文件和 Terminal">
            <div v-for="tab in residentTabs" :key="tab.path" :class="{ active: mode === 'files' && tab.path === activePath }" @contextmenu="showContextMenu($event, tab.path)">
              <el-tooltip :content="tab.path" placement="bottom" :show-after="450">
                <button type="button" class="file-tab-label" @click="mode = 'files'; void activate(tab.path)">
                  {{ tab.path.split('/').pop() }}
                </button>
              </el-tooltip>
              <button type="button" class="file-tab-close" :aria-label="'关闭 ' + tab.path" @click="close(tab.path)">
                ×
              </button>
            </div>
            <details v-if="openedFiles.length > residentTabs.length" class="opened-files-menu">
              <summary>已打开 {{ openedFiles.length }}</summary>
              <button v-for="file in openedFiles" :key="file.path" type="button" @click="openEntry(file)">{{ file.path }}</button>
            </details>
            <div v-if="terminalOpened" :class="{ active: mode === 'terminal' }">
              <button type="button" class="file-tab-label" @click="mode = 'terminal'">{{ terminalLabel }}</button>
              <button type="button" class="file-tab-close" aria-label="关闭 Terminal" @click="closeTerminal">×</button>
            </div>
          </nav>

          <template v-if="mode === 'terminal' && terminalOpened">
            <WorkbenchTerminal :key="chatId" :chat-id="chatId" @title="terminalLabel = $event" />
          </template>
          <div v-else-if="!tabs.length" class="workspace-empty-state" aria-label="尚未打开文件">
            <span class="workspace-empty-icon" aria-hidden="true">◈</span>
            <strong>{{ workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : '当前项目' }}</strong>
            <span class="workspace-empty-icon" aria-hidden="true">◇</span>
          </div>
          <template v-else>
            <header v-if="active" class="file-path">
              <el-tooltip :content="active.path" placement="top" :show-after="450">
                <span class="active-file-path">{{ active.path }}</span>
              </el-tooltip>
              <button type="button" class="path-action" aria-label="复制路径" title="复制路径" @click="copyPath(active.path)">复制路径</button>
              <button type="button" class="path-action" aria-label="一键引用" title="一键引用" @click="referencePath(active.path)">一键引用</button>
              <button
                v-if="active.content?.kind === 'text'"
                type="button"
                class="wrap-toggle"
                :aria-pressed="wrapLines"
                :title="wrapLines ? '取消折行' : '行内折行'"
                @click="wrapLines = !wrapLines"
              >
                {{ wrapLines ? '取消折行' : '行内折行' }}
              </button>
            </header>
            <p v-if="active?.loading && active.showLoading" role="status" class="file-loading">
              <span class="loading-dot" aria-hidden="true" /> 正在读取…
            </p>
            <p v-else-if="active?.loading" class="file-loading-placeholder" aria-hidden="true" />
            <p v-else-if="active?.error" role="alert" class="file-error">{{ active.error }}</p>
            <template v-else-if="active?.content">
              <p v-if="active.content.truncated" class="file-notice">
                文件较大，当前只显示前一部分内容。
              </p>
              <div class="file-content">
                <img
                  v-if="active.content.kind === 'image'"
                  :src="'data:' + active.content.mimeType + ';base64,' + active.content.content"
                  :alt="active.path"
                />
                <pre v-else-if="active.content.kind === 'text'" class="file-code" :class="{ 'is-wrapped': wrapLines }"><code v-html="highlighted" /></pre>
                <div v-else-if="active.content.kind === 'binary' && binaryPreview.length" class="binary-viewer">
                  <div class="binary-heading">
                    <span class="file-type-glyph" aria-hidden="true">0x</span>
                    <div><strong>二进制预览</strong><small>{{ active.content.size.toLocaleString() }} 字节 · 仅显示前 {{ Math.min(active.content.size, 65536).toLocaleString() }} 字节</small></div>
                  </div>
                  <pre class="binary-code"><code v-for="row in binaryPreview" :key="row.offset"><span class="binary-offset">{{ row.offset }}</span>  <span class="binary-hex">{{ row.hex }}</span>  <span class="binary-ascii">|{{ row.ascii }}|</span>
</code></pre>
                </div>
                <div v-else class="unsupported-file">
                  <span class="unsupported-icon" aria-hidden="true">◈</span>
                  <strong>暂时无法预览此文件</strong>
                  <span>{{ active.content.size.toLocaleString() }} 字节</span>
                </div>
              </div>
            </template>
            <p v-else class="file-empty">从左侧选择文件查看。文件内容仅支持只读预览。</p>
          </template>
        </div>
      </main>
    </div>
    <div v-if="contextMenu" class="file-context-backdrop" @click="hideContextMenu" />
    <div v-if="contextMenu" class="file-context-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }" @click.stop>
      <button type="button" @click="closeSide('left'); hideContextMenu()">关闭左侧文件</button>
      <button type="button" @click="closeSide('right'); hideContextMenu()">关闭右侧文件</button>
      <button type="button" @click="closeOthers(); hideContextMenu()">关闭其他文件</button>
      <button type="button" @click="close(contextMenu.path); hideContextMenu()">关闭当前文件</button>
      <button type="button" @click="closeAll(); hideContextMenu()">全部关闭</button>
      <button type="button" @click="refreshFile(contextMenu.path); hideContextMenu()">刷新该文件</button>
      <button type="button" @click="copyPath(contextMenu.path)">复制路径</button>
      <button type="button" @click="referencePath(contextMenu.path)">一键引用</button>
    </div>
  </section>
</template>

<style scoped>
.workbench-files { display: flex; height: 100%; min-height: 0; color: var(--nx-text); background: var(--nx-bg); font-size: 14px; }
button { border: 1px solid transparent; border-radius: 0; color: inherit; background: transparent; font: inherit; font-weight: 400; cursor: pointer; padding: 5px 8px; }
button:hover:not(:disabled), button[aria-pressed='true'] { background: color-mix(in srgb, var(--accent) 10%, var(--el-fill-color)); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
.files-body { position: relative; display: grid; grid-template-columns: minmax(180px, var(--tree-width, 28%)) minmax(0, 1fr); flex: 1; min-height: 0; width: 100%; }
.files-resizer { position: absolute; top: 0; bottom: 0; left: calc(var(--tree-width, 28%) - 3px); z-index: 3; width: 6px; cursor: col-resize; }
.files-resizer:hover, .files-body.is-resizing .files-resizer { background: color-mix(in srgb, var(--accent) 35%, transparent); }
.files-body.is-resizing { user-select: none; cursor: col-resize; }
.files-tree { overflow: auto; border-right: 1px solid var(--el-border-color); min-width: 0; background: color-mix(in srgb, var(--el-fill-color) 18%, var(--nx-bg)); scrollbar-color: color-mix(in srgb, var(--accent) 38%, var(--el-border-color)) color-mix(in srgb, var(--el-fill-color) 30%, transparent); scrollbar-width: thin; }
.files-tree::-webkit-scrollbar, .file-tabs::-webkit-scrollbar, .file-code::-webkit-scrollbar, .binary-code::-webkit-scrollbar { width: 8px; height: 8px; }
.files-tree::-webkit-scrollbar-track, .file-tabs::-webkit-scrollbar-track, .file-code::-webkit-scrollbar-track, .binary-code::-webkit-scrollbar-track { background: color-mix(in srgb, var(--el-fill-color) 30%, transparent); }
.files-tree::-webkit-scrollbar-thumb, .file-tabs::-webkit-scrollbar-thumb, .file-code::-webkit-scrollbar-thumb, .binary-code::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--accent) 38%, var(--el-border-color)); border-radius: 0; }
.tree-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; position: sticky; top: 0; z-index: 1; background: color-mix(in srgb, var(--nx-bg) 90%, transparent); backdrop-filter: blur(8px); }
.tree-actions { display: flex; align-items: center; gap: 4px; min-width: 0; }.tree-actions button { padding-inline: 5px; font-size: 12px; white-space: nowrap; }
.tree-actions button.tree-action-icon { display: grid; place-items: center; width: 24px; height: 22px; padding: 0; color: var(--el-text-color-secondary); }
.tree-actions button.tree-action-icon:hover { color: var(--accent); }
.tree-action-svg { display: block; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.workspace-path { padding: 3px 12px 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--el-text-color-secondary); font-size: 12px; }
.file-row { display: flex; align-items: center; gap: 2px; min-height: 25px; border-left: 2px solid transparent; transition: background-color 120ms ease, border-color 120ms ease; }
.file-row:hover, .file-row:focus-within { background: color-mix(in srgb, var(--accent) 10%, var(--el-fill-color)); border-left-color: color-mix(in srgb, var(--accent) 70%, transparent); }
.file-open { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; text-align: left; padding: 2px 4px 2px 0; background: transparent !important; border: 0; }
.file-open:hover, .file-open:focus-visible { background: transparent !important; }
.file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.path-action { width: 24px; height: 22px; padding: 0; color: var(--el-text-color-secondary); font-size: 0; line-height: 20px; }
.path-action::before { font-size: 15px; }
.path-action:first-of-type::before { content: '⧉'; }
.path-action:nth-of-type(2)::before { content: '&'; }
.path-action:hover { color: var(--accent); background: transparent; }
.file-context-backdrop { position: fixed; inset: 0; z-index: 20; }
.file-context-menu { position: fixed; z-index: 21; display: grid; min-width: 150px; padding: 4px; border: 1px solid var(--el-border-color); background: var(--nx-bg); box-shadow: 0 8px 24px rgb(0 0 0 / 18%); }
.file-context-menu button { text-align: left; white-space: nowrap; }
.git-mark { flex: none; color: var(--el-color-warning); font-size: 11px; font-weight: 600; }
.file-arrow { width: 11px; flex: none; color: var(--el-text-color-secondary); font-size: 11px; line-height: 1; }
.file-reference { visibility: hidden; flex: none; width: 22px; height: 22px; padding: 0; margin-right: 3px; color: color-mix(in srgb, var(--accent) 80%, var(--nx-text)); font-size: 13px; line-height: 20px; border: 0; background: transparent !important; }
.file-row:hover .file-reference, .file-row:focus-within .file-reference { visibility: visible; }
.file-reference:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 18%, transparent) !important; }
.file-reference:disabled { opacity: .35; cursor: not-allowed; }
.tree-status, .tree-loading, .tree-empty, .tree-error { margin: 6px 12px; font-size: 12px; line-height: 1.5; }
.tree-error { color: var(--el-color-danger); }
.loading-dot { display: inline-block; width: 8px; height: 8px; margin-right: 5px; border: 1px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: file-spin .8s linear infinite; vertical-align: -1px; }
@keyframes file-spin { to { transform: rotate(360deg); } }
.files-main, .file-viewer { min-width: 0; min-height: 0; height: 100%; }
.files-main { display: flex; flex-direction: column; }
.file-viewer { display: flex; flex: 1; flex-direction: column; }
.workspace-empty-state { display: flex; flex: 1; min-height: 0; align-items: center; justify-content: center; gap: 14px; color: var(--el-text-color-secondary); font-size: 16px; }
.workspace-empty-icon { color: var(--accent); font-size: 0; line-height: 1; }
.workspace-empty-icon::before { content: '▣'; font-size: 28px; }
.workspace-empty-icon + strong + .workspace-empty-icon { display: none; }
.file-viewer { display: flex; flex-direction: column; }
.file-tabs { display: flex; flex: none; overflow: auto; border-bottom: 1px solid var(--el-border-color); background: color-mix(in srgb, var(--el-fill-color) 25%, transparent); }
.opened-files-menu { margin-left: auto; position: relative; flex: none; }
.opened-files-menu summary { cursor: pointer; padding: 6px 8px; color: var(--el-text-color-secondary); font-size: 12px; }
.opened-files-menu button { display: block; width: 240px; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.file-tabs > div { position: relative; display: flex; flex: none; min-width: 100px; max-width: 220px; border-right: 1px solid var(--el-border-color); transition: background-color 120ms ease; }
.file-tabs > div:hover, .file-tabs > div:focus-within { background: color-mix(in srgb, var(--accent) 10%, var(--el-fill-color)); }
.file-tabs > div.active { border-bottom: 2px solid var(--accent); background: color-mix(in srgb, var(--accent) 7%, transparent); }
.file-tab-label { min-width: 0; flex: 1; padding: 7px 28px 7px 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; background: transparent !important; border: 0; }
.file-tab-close { position: absolute; top: 50%; right: 4px; width: 20px; height: 20px; padding: 0; transform: translateY(-50%); opacity: 0; color: var(--el-text-color-secondary); background: transparent !important; border: 0; line-height: 18px; }
.file-tabs > div:hover .file-tab-close, .file-tabs > div:focus-within .file-tab-close, .file-tab-close:focus-visible { opacity: 1; }
.file-tab-close:hover { color: var(--el-text-color-primary); background: color-mix(in srgb, var(--accent) 18%, var(--el-fill-color)) !important; }
.file-path { display: flex; align-items: center; gap: 5px; flex: none; min-height: 28px; padding: 3px 8px; border-bottom: 1px solid var(--el-border-color); color: var(--el-text-color-secondary); }
.active-file-path { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.wrap-toggle { flex: none; width: 24px; height: 22px; padding: 0; font-size: 0; color: var(--el-text-color-secondary); }
.wrap-toggle::before { content: '↔'; font-size: 15px; }
.file-loading, .file-error, .file-notice, .file-empty { margin: 12px; line-height: 1.5; }
.file-loading { color: var(--el-text-color-secondary); }
.file-loading-placeholder { min-height: 1.5em; margin: 12px; }
.file-error { color: var(--el-color-danger); }
.file-notice { flex: none; color: var(--el-text-color-secondary); font-size: 12px; }
.file-content { display: flex; flex: 1; min-height: 0; min-width: 0; justify-content: center; align-items: flex-start; overflow: hidden; padding: 14px; }
.file-content img { max-width: min(100%, 1100px); max-height: 100%; object-fit: contain; margin: auto; }
.file-code { width: min(100%, 1100px); height: 100%; margin: 0; padding: 14px 18px; overflow: auto; box-sizing: border-box; font: 14px/1.6 var(--font-mono); tab-size: 2; white-space: pre; }
.file-code.is-wrapped { white-space: pre-wrap; overflow-wrap: anywhere; }
.binary-viewer { width: min(100%, 900px); height: 100%; min-height: 0; display: flex; flex-direction: column; }
.binary-heading { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--el-border-color); background: color-mix(in srgb, var(--accent) 7%, transparent); }
.binary-heading strong, .binary-heading small { display: block; }
.binary-heading small { margin-top: 3px; color: var(--el-text-color-secondary); font-size: 12px; }
.file-type-glyph { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 0; color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); font: 700 12px ui-monospace, monospace; }
.binary-code { flex: 1; min-height: 0; overflow: auto; margin: 8px 0 0; padding: 12px; background: color-mix(in srgb, var(--el-fill-color) 35%, transparent); font: 12px/1.7 var(--font-mono); }
.binary-offset { color: var(--accent); }.binary-hex { color: var(--el-text-color-primary); }.binary-ascii { color: var(--el-text-color-secondary); }
.unsupported-file { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-width: 220px; margin: auto; color: var(--el-text-color-secondary); text-align: center; }
.unsupported-file strong { color: var(--el-text-color-primary); }.unsupported-icon { display: grid; place-items: center; width: 48px; height: 48px; border: 1px solid var(--el-border-color); border-radius: 0; color: var(--accent); font-size: 24px; }
@media (max-width: 600px) { .files-body { grid-template-columns: minmax(150px, 38%) minmax(0, 1fr); } .file-reference { visibility: visible; } }
</style>
