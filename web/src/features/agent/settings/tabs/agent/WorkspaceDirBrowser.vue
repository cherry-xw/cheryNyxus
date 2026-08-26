<script setup lang="ts">
/**
 * WorkspaceDirBrowser：预设工作区「浏览」弹层（config.workspace.browse.*）。
 *
 * 面包屑 + 目录列表，逐层懒加载服务端文件系统；本次仅目录（includeFiles 恒 false）。
 * 载荷加密：每请求新 nonce → encPath = xorEncrypt(nonce, 路径)；响应 encData 用同 nonce 解密。
 * 权限：列表项 accessible=false 置灰 + 「无权限」徽标（点击目标时由服务端 readdir 权威判定）。
 */
import { computed, ref } from 'vue'
import { FolderOpened, Top, WarningFilled } from '@element-plus/icons-vue'
import {
  agentApi,
  type BrowseListPayload,
  type ConfigWorkspaceBrowseStart,
} from '@/application/backend/public'
import { randomHex, xorEncrypt, xorDecrypt } from '@/utils/obfuscate'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'select', path: string): void
}>()

const sessionId = ref('')
const sep = ref<'/' | '\\'>('/')
const roots = ref<ConfigWorkspaceBrowseStart['roots']>([])
/** 当前展示目录（'' = 根选择层） */
const cwd = ref('')
const entries = ref<BrowseListPayload['entries']>([])
const listError = ref<string | null>(null)
const loading = ref(false)
const startError = ref<string | null>(null)

/** 请求序号守卫：慢响应不覆盖新导航（同 SettingsDialog.validatePresetWorkspace 模式）。 */
let navSeq = 0

/** 弹层打开：开启浏览会话 → 初始导航（单根直接列子目录；多根进根选择层）。 */
async function onOpen(): Promise<void> {
  navSeq += 1
  sessionId.value = ''
  cwd.value = ''
  entries.value = []
  listError.value = null
  startError.value = null
  try {
    const res = await agentApi.browseWorkspaceStart()
    if (res.error) {
      startError.value = res.error
      return
    }
    sessionId.value = res.sessionId
    sep.value = res.sep
    roots.value = res.roots
    await navigate('')
  } catch (e) {
    startError.value = (e as Error).message
  }
}

/** 关闭：复位（含序号守卫，丢弃在途响应）。 */
function onClosed(): void {
  navSeq += 1
  sessionId.value = ''
  roots.value = []
  cwd.value = ''
  entries.value = []
  listError.value = null
  startError.value = null
  loading.value = false
}

/** 懒加载列某目录：加密请求 → 校验 nonce 回显 → 解密载荷。 */
async function navigate(path: string): Promise<void> {
  if (!sessionId.value || loading.value) return
  const seq = ++navSeq
  loading.value = true
  listError.value = null
  const nonce = randomHex(16)
  try {
    const res = await agentApi.browseWorkspaceList({
      sessionId: sessionId.value,
      nonce,
      encPath: xorEncrypt(nonce, path),
      includeFiles: false,
    })
    if (seq !== navSeq) return
    if (res.nonce !== nonce) {
      listError.value = '响应校验失败，请重试'
      return
    }
    const payload = JSON.parse(xorDecrypt(nonce, res.encData)) as BrowseListPayload
    if (!payload.accessible) {
      cwd.value = path
      entries.value = []
      listError.value = payload.error ?? '无法加载该目录'
      return
    }
    cwd.value = payload.path
    entries.value = payload.entries
  } catch (e) {
    if (seq !== navSeq) return
    listError.value = (e as Error).message
  } finally {
    if (seq === navSeq) loading.value = false
  }
}

/** 词法判定 path 是否落在 root 内（root 以分隔符结尾如盘符 C:\ 时不再追加，避免双分隔符）。 */
function isWithin(path: string, rootPath: string): boolean {
  if (path === rootPath) return true
  const base = rootPath.endsWith(sep.value) ? rootPath : rootPath + sep.value
  return path.startsWith(base)
}

/** 当前 cwd 所属的根（多根下识别前缀）。 */
const currentRoot = computed(() => roots.value.find((r) => isWithin(cwd.value, r.path)))

/** 段是否可点击：仅落在某 root 内（=== root 或其下）才可导航；roots 外（含 POSIX '/'）仅展示不可点。 */
function crumbClickable(path: string): boolean {
  if (!path) return false
  return roots.value.some((r) => isWithin(path, r.path))
}

interface Crumb {
  label: string
  path: string
  clickable: boolean
}

/**
 * 面包屑：**绝对路径累积样式**——从 `/`（POSIX）或盘符 `C:\`（Windows）起，
 * 段间用 sep 分隔，每段显示段名、其 path 为到该段为止的完整绝对路径（点击跳转该前缀）。
 * 分隔符跟随平台（win 显示 `\`），不硬编码 `/`。
 */
const breadcrumb = computed<Crumb[]>(() => {
  if (!cwd.value) return []
  const parts = cwd.value.split(sep.value).filter(Boolean)
  const crumbs: Crumb[] = []
  if (sep.value === '/') {
    // POSIX：首段 '/' + 逐段累积
    crumbs.push({ label: '/', path: '/', clickable: crumbClickable('/') })
    let acc = ''
    for (const s of parts) {
      acc += '/' + s
      crumbs.push({ label: s, path: acc, clickable: crumbClickable(acc) })
    }
  } else {
    // Windows：盘符段 'C:' → 补 sep 为 'C:\'，其后逐段累积
    for (let i = 0; i < parts.length; i += 1) {
      const s = parts[i]!
      const acc = i === 0 ? s + sep.value : (crumbs[i - 1]!.path as string) + s + sep.value
      crumbs.push({ label: s, path: acc, clickable: crumbClickable(acc) })
    }
  }
  return crumbs
})

/** 上级目录（绝对路径）：cwd 在某 root 内时取 root 起的前缀；已在根（或根选择层）返回 null（无路径级上级）。 */
function parentOf(path: string): string | null {
  const r = currentRoot.value
  if (!r || !path) return null
  if (path === r.path) return null
  const rest = path.slice(r.path.length).replace(/^[\\/]/, '')
  const segs = rest.split(sep.value).filter(Boolean)
  segs.pop()
  let acc = r.path
  for (const s of segs) {
    acc = acc.endsWith(sep.value) ? acc + s : acc + sep.value + s
  }
  return acc
}

/**
 * 可否退回：有路径级上级 → 退回上级目录；已在根目录本身 → 仅**多根**时可退回根选择层
 * （单根根之上是安全边界 roots 外，服务端会拒，故不可退）。
 */
const canGoUp = computed(() => {
  if (parentOf(cwd.value)) return true
  return cwd.value !== '' && roots.value.length > 1
})

/** 不可退时的原因说明（明确告知，规则 12 fail loud）。 */
const upTitle = computed(() => {
  if (canGoUp.value) return '退回上级目录'
  if (!cwd.value) return '已在根目录选择层'
  return '已到文件系统根目录，无更上级'
})

function goUp(): void {
  const p = parentOf(cwd.value)
  if (p) {
    void navigate(p)
    return
  }
  // 在根目录且多根：退回根选择层
  if (cwd.value && roots.value.length > 1) void navigate('')
}

const canConfirm = computed(() => !startError.value && !loading.value && !!cwd.value)

function onCrumb(crumb: Crumb): void {
  if (crumb.clickable) void navigate(crumb.path)
}

function onItem(e: BrowseListPayload['entries'][number]): void {
  if (e.isDir) void navigate(e.path)
}

function confirm(): void {
  if (!cwd.value) return
  emit('select', cwd.value)
  emit('update:open', false)
}
</script>

<template>
  <el-dialog
    :model-value="props.open"
    title="选择工作区目录"
    width="440px"
    :append-to-body="true"
    class="workspace-dir-browser"
    @update:model-value="(v: boolean) => emit('update:open', v)"
    @open="onOpen"
    @closed="onClosed"
  >
    <div class="browser-body">
      <p v-if="startError" class="browser-error">{{ startError }}</p>
      <template v-else>
        <div class="browser-bar">
          <div class="browser-crumbs">
            <template v-for="(c, i) in breadcrumb" :key="`${c.path}-${i}`">
              <!-- 段间分隔符：POSIX 首段 '/' 本身已是分隔符，紧跟其后不再重复（避免 // 双斜杠） -->
              <span
                v-if="i > 0 && (sep !== '/' || i > 1)"
                class="crumb-sep"
              >{{ sep }}</span>
              <button
                type="button"
                class="crumb"
                :class="{ 'is-current': i === breadcrumb.length - 1 }"
                :disabled="!c.clickable"
                :title="c.clickable ? c.path : '可浏览范围之外（根锚定限制），不可进入'"
                @click="onCrumb(c)"
              >
                {{ c.label }}
              </button>
            </template>
            <span v-if="!breadcrumb.length" class="crumb-root-hint">根目录</span>
          </div>
          <button
            type="button"
            class="ghost-btn up-btn"
            :title="upTitle"
            :disabled="!canGoUp"
            @click="goUp"
          >
            <el-icon><Top /></el-icon>
            上级
          </button>
        </div>
        <div v-loading="loading" class="browser-list">
          <p v-if="listError" class="browser-error">{{ listError }}</p>
          <p v-else-if="!entries.length && !loading" class="browser-empty">空目录</p>
          <button
            v-for="e in entries"
            :key="e.path"
            type="button"
            class="browser-item"
            :disabled="!e.accessible || !e.isDir"
            @click="onItem(e)"
          >
            <el-icon class="item-ico"><FolderOpened /></el-icon>
            <span class="item-name">{{ e.name }}</span>
            <span v-if="!e.accessible" class="item-badge">
              <el-icon><WarningFilled /></el-icon>
              无权限
            </span>
          </button>
        </div>
      </template>
    </div>
    <template #footer>
      <el-button size="small" @click="emit('update:open', false)">取消</el-button>
      <el-button
        type="primary"
        size="small"
        :disabled="!canConfirm"
        @click="confirm"
      >
        选择此文件夹
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="less">
@import '../../config/shared.less';

.browser-body {
  min-height: 180px;
}

.browser-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);

  .up-btn {
    flex: 0 0 auto;
    display: inline-flex;
    gap: 3px;
    align-items: center;
    padding: 2px 8px;
    font-size: 11px;
  }
}

// 绝对路径样式面包屑：段 + 分隔符（跟随平台 sep）
.browser-crumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  align-items: center;
  min-width: 0;
  flex: 1 1 auto;

  .crumb-sep {
    color: color-mix(in srgb, var(--ink) 40%, transparent);
    font-size: 11px;
    user-select: none;
  }
  .crumb {
    padding: 2px 4px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: color-mix(in srgb, var(--ink) 75%, transparent);
    font-size: 11px;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: color-mix(in srgb, var(--ink) 6%, transparent);
      color: var(--tab-color, @accent);
    }
    &:disabled {
      opacity: 0.6;
      cursor: default;
    }
    &.is-current {
      color: var(--tab-color, @accent);
      font-weight: 600;
    }
  }
  .crumb-root-hint {
    color: color-mix(in srgb, var(--ink) 50%, transparent);
    font-size: 11px;
  }
}

.browser-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 260px;
  overflow-y: auto;

  .browser-item {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 6px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: color-mix(in srgb, var(--ink) 88%, transparent);
    font-size: 12px;
    text-align: left;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: color-mix(in srgb, var(--ink) 6%, transparent);
    }
    &:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .item-ico {
      flex: 0 0 auto;
      color: var(--tab-color, @accent);
    }
    .item-name {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .item-badge {
      display: inline-flex;
      gap: 3px;
      align-items: center;
      flex: 0 0 auto;
      color: var(--danger);
      font-size: 10px;
    }
  }
}

.browser-error,
.browser-empty {
  margin: 0;
  padding: 12px;
  color: var(--danger);
  font-size: 12px;
}

.browser-empty {
  color: color-mix(in srgb, var(--ink) 50%, transparent);
}
</style>
