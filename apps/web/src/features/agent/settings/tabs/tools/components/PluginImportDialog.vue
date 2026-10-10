<script setup lang="ts">
/**
 * PluginImportDialog：插件导入弹窗（三步流程）。
 *
 * 从 PluginsTab 的 .imp-bar + 内联预览 el-dialog 抽出，封装为独立弹窗。
 * 三步流程：
 *   ① preImportPluginUrl（拉分支列表 + needsAuth/gitNotInstalled/suggestedName/nameConflict 探测）
 *   ② importPluginUrl（按选定分支 clone → staging 预览；nameConflict 时可传 pluginName 改名）
 *   ③ commitPlugin（落盘，overwrite=true 覆盖同名）
 * 鉴权：credentialId（凭据池）优先；否则 inline {username,password}（remember=true 入池）。
 */
import { ref, computed, onMounted, watch } from 'vue'
import {
  agentApi,
  type PluginImportPreview,
  type PluginPreImportResult,
  type CredentialListItemDTO,
} from '@/application/backend/public'
import LabelTip from '../../../tabs/config/LabelTip.vue'
import ImportPortalFrame, { type PortalPhase } from './ImportPortalFrame.vue'
import { classifyImportError, type ImportErrorInfo } from './importError'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'imported'): void
  (e: 'error', msg: string): void
}>()

// ── 导入栏状态 ──────────────────────────────────────────────────
const url = ref('')
const branch = ref('')
/** 文件夹名（preImport nameConflict=true 时展示输入框；默认填 suggestedName）。 */
const folderName = ref('')
const credId = ref<string>('')
const username = ref('')
const password = ref('')
const remember = ref(false)
const proxy = ref('')
const busy = ref(false)
const success = ref(false)
const previewSearch = ref('')
const previewPage = ref(1)
const previewPageSize = 40

/** preImport 探测结果（分支列表 + needsAuth/gitNotInstalled/suggestedName/nameConflict）。 */
const pre = ref<PluginPreImportResult | null>(null)
/** git CLI 缺失（preImport 探测后置 true，禁用导入入口）。 */
const gitNotInstalled = ref(false)

// ── 凭据池 ─────────────────────────────────────────────────────
const credPool = ref<CredentialListItemDTO[]>([])

async function loadCredPool(): Promise<void> {
  try {
    credPool.value = await agentApi.listCredentials()
  } catch (e) {
    console.error('[PluginImportDialog] listCredentials failed:', e)
    credPool.value = []
  }
}

/** allow-create 输入的新 label 不在池中 → 视为新凭据，显示 username/password/remember。 */
const isNewCred = computed(
  () => !credId.value || !credPool.value.some((c) => c.id === credId.value),
)

// ── 预览 ────────────────────────────────────────────────────────
/** 导入预览（importUrl 返回；existing=true 时确认覆盖）。 */
const preview = ref<PluginImportPreview | null>(null)
const previewFiltered = computed(() => {
  const q = previewSearch.value.trim().toLowerCase()
  return (preview.value?.skills ?? []).filter(
    (skill) => !q || `${skill.name} ${skill.description}`.toLowerCase().includes(q),
  )
})
const previewSkills = computed(() => {
  return previewFiltered.value.slice(
    (previewPage.value - 1) * previewPageSize,
    previewPage.value * previewPageSize,
  )
})
const previewPageCount = computed(() =>
  Math.max(1, Math.ceil(previewFiltered.value.length / previewPageSize)),
)
watch(previewSearch, () => {
  previewPage.value = 1
})

const portalPhase = computed<PortalPhase>(() => {
  if (success.value) return 'success'
  if (preview.value && busy.value) return 'committing'
  if (preview.value) return 'review'
  if (busy.value) return 'scanning'
  if (pre.value) return 'configure'
  return 'source'
})
const portalStatus = computed(() => {
  if (success.value) return { text: '整套卡组已收藏', detail: '插件技能已经加入运行时索引' }
  if (preview.value && busy.value)
    return { text: '正在装入卡册', detail: '卡组已锁定，正在写入插件目录' }
  if (preview.value)
    return { text: '主题卡组全部亮相', detail: `${preview.value.skills.length} 张技能卡等待收藏` }
  if (busy.value) return { text: '正在撕开整包卡组', detail: '克隆仓库并整理插件技能卡' }
  if (pre.value)
    return { text: '卡包版本已确认', detail: `${pre.value.branches.length} 个版本可以选择` }
  return { text: '来一套新的扩展卡组', detail: '输入 Git 仓库，打开完整插件包' }
})
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

// ── 错误处理（内联分类显示，不再冒泡到全局红框） ────────────────
const importError = ref<ImportErrorInfo | null>(null)
function onError(msg: string): void {
  importError.value = classifyImportError(msg)
}
function emitError(err: unknown): void {
  const e = err as { message?: string }
  onError(e?.message ?? String(err))
}
function dismissError(): void {
  importError.value = null
}

// ── seq-guard：丢弃陈旧 preImport 响应（用户连按回车或粘 URL 时） ────
let preImportSeq = 0

/** 确认拉取：分支列表 + needsAuth/gitNotInstalled/suggestedName/nameConflict 探测。 */
async function onPreImport(): Promise<void> {
  const u = url.value.trim()
  if (!u || busy.value) return
  importError.value = null
  const seq = ++preImportSeq
  busy.value = true
  try {
    const res = await agentApi.preImportPluginUrl(
      u,
      credId.value || undefined,
      proxy.value.trim() || undefined,
    )
    if (seq !== preImportSeq) return // 已被新请求覆盖
    pre.value = res
    gitNotInstalled.value = res.gitNotInstalled
    folderName.value = res.suggestedName
    if (res.gitNotInstalled) {
      onError('Git 导入需系统安装 git CLI（当前未检测到）')
      return
    }
    // 默认选 defaultBranch；不存在则取第一个
    const def =
      res.defaultBranch && res.branches.includes(res.defaultBranch)
        ? res.defaultBranch
        : res.branches[0]
    branch.value = def ?? ''
  } catch (err) {
    if (seq !== preImportSeq) return
    emitError(err)
  } finally {
    if (seq === preImportSeq) busy.value = false
  }
}

/**
 * 落盘前 staging 预览。鉴权优先级：
 *   - 选中池中已有凭据（credId 且 !isNewCred）→ credentialId
 *   - 否则 inline {username, password, remember, label=typed credId}
 * nameConflict=true 且 folderName 非空 → 附 pluginName 覆盖默认文件夹名。
 * needsAuth=true 但凭据未填 → 友好错误（不调后端）。
 */
async function onImport(): Promise<void> {
  if (!url.value.trim() || !branch.value || busy.value) return
  if (pre.value?.needsAuth) {
    if (!credId.value && !username.value && !password.value) {
      onError('该仓库需鉴权：请选择凭据或输入用户名/Token')
      return
    }
    if (isNewCred.value && !username.value && !password.value) {
      onError('请输入用户名与 Token/密令')
      return
    }
  }
  const useRename = !!pre.value?.nameConflict && folderName.value.trim().length > 0
  importError.value = null
  const proxyVal = proxy.value.trim() || undefined
  busy.value = true
  try {
    const needsAuth = pre.value?.needsAuth ?? false
    const base = !needsAuth
      ? { url: url.value.trim(), branch: branch.value, ...(proxyVal ? { proxy: proxyVal } : {}) }
      : isNewCred.value
        ? {
            url: url.value.trim(),
            branch: branch.value,
            ...(username.value ? { username: username.value } : {}),
            ...(password.value ? { password: password.value } : {}),
            remember: remember.value,
            ...(credId.value ? { label: credId.value } : {}),
            ...(proxyVal ? { proxy: proxyVal } : {}),
          }
        : {
            url: url.value.trim(),
            branch: branch.value,
            credentialId: credId.value,
            ...(proxyVal ? { proxy: proxyVal } : {}),
          }
    const req = useRename ? { ...base, pluginName: folderName.value.trim() } : base
    const res = await agentApi.importPluginUrl(req)
    preview.value = res
    // remember + inline 入池成功 → 重拉池（让下次复用）
    if (res.savedCredentialId) {
      await loadCredPool()
      credId.value = res.savedCredentialId
    }
  } catch (err) {
    emitError(err)
  } finally {
    busy.value = false
  }
}

async function onConfirmInstall(): Promise<void> {
  if (!preview.value) return
  const { stagingId, existing } = preview.value
  importError.value = null
  busy.value = true
  try {
    await agentApi.commitPlugin(stagingId, existing)
    success.value = true
    emit('imported')
    await wait(900)
    preview.value = null
    resetImportBar()
    success.value = false
    emit('update:visible', false)
  } catch (err) {
    emitError(err)
  } finally {
    busy.value = false
  }
}
function onCancelInstall(): void {
  preview.value = null
}
/** commit 成功 / 用户取消后清空导入栏（保留 url 方便连续导入同站不同仓可手改）。 */
function resetImportBar(): void {
  branch.value = ''
  folderName.value = ''
  credId.value = ''
  username.value = ''
  password.value = ''
  remember.value = false
  proxy.value = ''
  importError.value = null
  pre.value = null
}

/** 弹窗关闭时重置所有导入状态。 */
function onDialogClose(): void {
  if (busy.value) return
  preview.value = null
  success.value = false
  resetImportBar()
  emit('update:visible', false)
}

/** 去掉 `<plugin>__` 前缀，展示技能原名。 */
function skillLabel(name: string, plugin: string): string {
  const prefix = `${plugin}__`
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}
function shortSha(sha: string | undefined): string {
  return sha && sha.length >= 7 ? sha.slice(0, 7) : sha || '—'
}

/** 技能 tag 彩色调色板（按 index 轮转）。 */
const TAG_PALETTE: Array<{ background: string; color: string }> = [
  {
    background: 'linear-gradient(145deg,rgba(46,242,255,.22),rgba(12,18,34,.92))',
    color: '#8cf8ff',
  },
  {
    background: 'linear-gradient(145deg,rgba(255,60,172,.23),rgba(23,15,32,.92))',
    color: '#ff9ad4',
  },
  {
    background: 'linear-gradient(145deg,rgba(201,255,67,.2),rgba(18,25,25,.92))',
    color: '#dcff7d',
  },
  {
    background: 'linear-gradient(145deg,rgba(255,138,0,.22),rgba(29,19,13,.92))',
    color: '#ffc267',
  },
  {
    background: 'linear-gradient(145deg,rgba(72,123,255,.24),rgba(13,18,34,.92))',
    color: '#9db6ff',
  },
  {
    background: 'linear-gradient(145deg,rgba(255,225,71,.2),rgba(28,24,13,.92))',
    color: '#fff18c',
  },
]
function skillTagStyle(i: number): { background: string; color: string } {
  return TAG_PALETTE[i % TAG_PALETTE.length]!
}

/** 弹窗打开时加载凭据池。 */
watch(
  () => props.visible,
  (v) => {
    if (v) void loadCredPool()
  },
)

onMounted(() => {
  if (props.visible) void loadCredPool()
})
</script>

<template>
  <ImportPortalFrame
    :visible="visible"
    title="导入插件"
    eyebrow="PLUGIN EXPANSION NIGHT"
    tone="plugin"
    :phase="portalPhase"
    :status-text="portalStatus.text"
    :status-detail="portalStatus.detail"
    :closable="!busy"
    @close="onDialogClose"
  >
    <div v-if="importError" class="import-error-banner" :class="`kind-${importError.kind}`">
      <span class="ie-icon">{{
        importError.kind === 'auth'
          ? '⚿'
          : importError.kind === 'proxy'
            ? '⇅'
            : importError.kind === 'git'
              ? '⎇'
              : importError.kind === 'network'
                ? '⌁'
                : '⚠'
      }}</span>
      <div class="ie-body">
        <b>{{ importError.title }}</b>
        <p v-if="importError.detail">{{ importError.detail }}</p>
        <small v-if="importError.hint">{{ importError.hint }}</small>
        <small v-if="importError.raw" class="ie-raw">{{ importError.raw }}</small>
      </div>
      <button type="button" class="ie-close" aria-label="关闭错误" @click="dismissError">×</button>
    </div>

    <div v-if="success" class="success-panel">
      <div class="reveal-card plugin-card"><span>FULL SET</span><b>PLUGIN</b><i>✦</i></div>
      <span>EXPANSION COLLECTED</span>
      <h4>整套插件卡组已收入收藏</h4>
      <p>技能命名空间和版本信息正在刷新。</p>
    </div>

    <div v-else-if="busy && !preview" class="scan-panel">
      <div class="shuffle-cards">
        <span v-for="n in 6" :key="n" :style="{ '--i': n }"><i>✦</i></span>
      </div>
      <b>大包正在拆封，卡组马上亮相</b><small>克隆仓库、读取 manifest 与技能卡…</small>
    </div>

    <div v-else-if="!preview" class="plugin-console">
      <section class="coordinate-card" :class="{ connected: pre }">
        <header>
          <span>SET</span>
          <div><b>远程扩展卡包</b><small>整仓收藏 · 自动追踪版本</small></div>
          <i>{{ pre ? 'PICKED' : 'SEALED' }}</i>
        </header>
        <div class="field url-field">
          <LabelTip
            label="Git 坐标"
            tip="支持 https://github.com/<owner>/<repo>[.git] 或 /tree/<branch>；SSH git@；subpath 忽略，整仓安装"
          />
          <el-input
            v-model="url"
            size="small"
            placeholder="https://github.com/obra/superpowers"
            :disabled="gitNotInstalled"
            @keydown.enter="onPreImport"
          />
          <button
            type="button"
            class="beam-btn"
            :disabled="busy || gitNotInstalled || !url.trim()"
            @click="onPreImport"
          >
            {{ pre ? '换一个包' : '看看卡面' }}
          </button>
        </div>
        <div class="field proxy-field">
          <LabelTip label="网络代理" tip="拉取失败时填 http(s)://host:port；留空直连" />
          <el-input
            v-model="proxy"
            size="small"
            placeholder="留空直连，例 http://127.0.0.1:7890"
            :disabled="gitNotInstalled"
          />
        </div>

        <template v-if="pre && !pre.gitNotInstalled && pre.branches.length">
          <div class="configuration-grid">
            <div class="field branch-field">
              <LabelTip label="轨道分支" tip="选择整仓安装的目标分支" />
              <el-select
                v-model="branch"
                filterable
                size="small"
                placeholder="选择分支"
                popper-class="pack-select-popper"
              >
                <el-option
                  v-for="b in pre.branches"
                  :key="b"
                  :label="b === pre.defaultBranch ? `${b} (默认)` : b"
                  :value="b"
                />
              </el-select>
            </div>
            <div v-if="pre.nameConflict" class="field folder-field">
              <LabelTip
                label="新卡组名"
                :tip="`默认 ${pre.suggestedName} 已存在；改名以安装到新目录（仅 [a-zA-Z0-9_-]）`"
              />
              <el-input v-model="folderName" size="small" :placeholder="pre.suggestedName" />
            </div>
          </div>

          <div v-if="pre.needsAuth" class="credential-vault">
            <span class="vault-label">PRIVATE PACK CODE</span>
            <div class="field">
              <LabelTip label="安全密钥" tip="从凭据池选已存 Token，或创建新的本地加密凭据" />
              <el-select
                v-model="credId"
                filterable
                allow-create
                clearable
                size="small"
                placeholder="选凭据或输入新标签"
                popper-class="pack-select-popper"
              >
                <el-option
                  v-for="c in credPool"
                  :key="c.id"
                  :label="`${c.label} · ${c.username}`"
                  :value="c.id"
                />
              </el-select>
            </div>
            <template v-if="isNewCred">
              <div class="field">
                <LabelTip label="用户名" tip="GitHub 用户名（PAT 时随意，主要填 token）" />
                <el-input v-model="username" size="small" placeholder="GitHub username" />
              </div>
              <div class="field">
                <LabelTip
                  label="密令 / Token"
                  tip="GitHub PAT 或密码；不勾「记住」则用后即弃，不入盘"
                />
                <el-input
                  v-model="password"
                  type="password"
                  show-password
                  size="small"
                  placeholder="ghp_..."
                />
              </div>
              <div class="cred-chk">
                <el-checkbox v-model="remember">记住（加密存储）</el-checkbox>
                <el-tooltip
                  content="勾选后用 AES-256-GCM 加密存入 .chery/.secrets（obfuscation 级）"
                  placement="top"
                  :show-after="120"
                >
                  <span class="cred-chk-hint">仅本地加密，非 OS keychain</span>
                </el-tooltip>
              </div>
            </template>
          </div>

          <div class="launch-row">
            <button
              type="button"
              class="launch-btn"
              :disabled="!url.trim() || !branch || busy || gitNotInstalled"
              @click="onImport"
            >
              <span>撕开扩展包</span><i>↗</i>
            </button>
          </div>
        </template>
      </section>
    </div>

    <section v-else class="plugin-review">
      <header class="plugin-identity">
        <div class="plugin-gem">SET</div>
        <div>
          <span>NEW EXPANSION</span>
          <h4>{{ preview.pluginName }}</h4>
          <p>
            <code>{{ preview.branch }}</code> · HEAD <code>{{ shortSha(preview.commitSha) }}</code
            ><template v-if="preview.commitDate"> · {{ preview.commitDate.slice(0, 10) }}</template>
          </p>
        </div>
        <strong>{{ preview.skills.length }}<small>CARDS</small></strong>
      </header>
      <div v-if="preview.existing" class="overwrite-alert">
        <b>发现同名卡组</b><span>收藏后会用这套新卡替换旧版本</span>
      </div>
      <el-input
        v-if="preview.skills.length > 12"
        v-model="previewSearch"
        clearable
        size="small"
        placeholder="搜索这套卡组"
        class="preview-search"
      />
      <div v-if="preview.skills.length" class="payload-grid">
        <el-tooltip
          v-for="(s, si) in previewSkills"
          :key="s.name"
          :content="s.description || '无描述'"
          placement="top"
          :show-after="200"
        >
          <span class="payload-chip" :style="skillTagStyle(si)"
            ><i>✦</i><b>{{ skillLabel(s.name, preview.pluginName) }}</b
            ><small>SKILL CARD</small></span
          >
        </el-tooltip>
      </div>
      <div v-if="previewPageCount > 1" class="preview-pages">
        <button type="button" :disabled="previewPage <= 1" @click="previewPage--">‹</button
        ><span>{{ previewPage }} / {{ previewPageCount }}</span
        ><button type="button" :disabled="previewPage >= previewPageCount" @click="previewPage++">
          ›
        </button>
      </div>
    </section>

    <template #footer>
      <template v-if="preview && !success">
        <button type="button" class="ghost-btn" @click="onCancelInstall">取消</button>
        <button type="button" class="primary-btn" :disabled="busy" @click="onConfirmInstall">
          {{ preview?.existing ? '收藏并替换旧卡组' : '收入插件卡册' }}
        </button>
      </template>
    </template>
  </ImportPortalFrame>
</template>

<style scoped lang="less" src="./PluginImportDialog.styles.less"></style>
