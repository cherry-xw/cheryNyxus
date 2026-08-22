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
} from '@/services/agentApi'
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

<style scoped lang="less">
@import '../../../config/shared.less';
.plugin-console {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.coordinate-card {
  position: relative;
  padding: 12px;
  border: 1px solid rgba(255, 157, 34, 0.2);
  border-radius: 13px;
  background: linear-gradient(145deg, rgba(255, 138, 0, 0.055), rgba(46, 242, 255, 0.025));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  overflow: hidden;
  transition: 0.2s ease;
}
.coordinate-card::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 35%;
  top: 0;
  height: 2px;
  background: linear-gradient(90deg, #ff8a00, #ff3cac, #2ef2ff, transparent);
  box-shadow: 0 0 9px rgba(255, 138, 0, 0.48);
}
.coordinate-card.connected {
  border-color: rgba(201, 255, 67, 0.42);
  box-shadow: 4px 4px 0 rgba(201, 255, 67, 0.07);
}
.coordinate-card > header {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.coordinate-card > header > span {
  width: 32px;
  height: 29px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(255, 157, 34, 0.46);
  border-radius: 7px 4px 7px 4px;
  background: #1b1620;
  color: #ffb24d;
  font:
    1000 8px/1 ui-monospace,
    monospace;
  box-shadow: 3px 3px 0 rgba(255, 60, 172, 0.18);
  transform: rotate(-3deg);
}
.coordinate-card header div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.coordinate-card header b {
  font-size: 12px;
  color: #fff;
}
.coordinate-card header small {
  font-size: 9px;
  color: #7f899e;
}
.coordinate-card header i {
  margin-left: auto;
  font:
    900 8px/1 ui-monospace,
    monospace;
  letter-spacing: 0.13em;
  color: #c9ff43;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.field :deep(.el-input),
.field :deep(.el-select) {
  width: 100%;
}
.field :deep(.el-input__wrapper),
.field :deep(.el-select__wrapper) {
  background: rgba(5, 9, 20, 0.76);
  box-shadow: 0 0 0 1px rgba(255, 157, 34, 0.16) inset;
}
.field :deep(.el-input__inner),
.field :deep(.el-select__selected-item) {
  color: #fff3e3;
  font-size: 10px;
}
.url-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 7px;
}
.url-field :deep(.label-tip) {
  grid-column: 1/-1;
}
.beam-btn,
.launch-btn {
  border: 1px solid rgba(255, 157, 34, 0.36);
  border-radius: 8px;
  background: rgba(255, 138, 0, 0.08);
  color: #ffd49a;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  transition: 0.18s ease;
}
.beam-btn {
  height: 24px;
  padding: 0 10px;
}
.beam-btn:hover:not(:disabled) {
  transform: translate(-1px, -1px);
  box-shadow: 3px 3px 0 rgba(255, 60, 172, 0.22);
}
.configuration-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.credential-vault {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
  margin-top: 10px;
  padding: 16px 8px 8px;
  border: 1px dashed rgba(46, 242, 255, 0.28);
  border-radius: 9px;
  background: rgba(46, 242, 255, 0.04);
}
.vault-label {
  position: absolute;
  left: 8px;
  top: 4px;
  font:
    900 7px/1 ui-monospace,
    monospace;
  letter-spacing: 0.14em;
  color: #2ef2ff;
}
.cred-chk {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 2px;
}
.cred-chk-hint {
  font-size: 8px;
  color: #667188;
}
.launch-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 11px;
}
.launch-btn {
  height: 30px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  border: 0;
  background: linear-gradient(105deg, #ff8a00, #ff3cac 45%, #2ef2ff 78%, #c9ff43);
  color: #071018;
  box-shadow: 4px 4px 0 rgba(201, 255, 67, 0.18);
}
.launch-btn i {
  font-size: 15px;
}
.launch-btn:hover:not(:disabled) {
  transform: translate(-2px, -2px);
  box-shadow: 6px 6px 0 rgba(201, 255, 67, 0.24);
}
button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.plugin-review {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 320px;
}
.plugin-identity {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  gap: 9px;
  align-items: center;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(46, 242, 255, 0.14);
}
.plugin-gem {
  width: 42px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 2px solid #fff;
  border-radius: 8px;
  background: linear-gradient(145deg, #ff8a00, #ff3cac 48%, #13213d 49%);
  color: #fff;
  font:
    1000 8px/1 ui-monospace,
    monospace;
  box-shadow:
    0 0 0 2px #2ef2ff,
    4px 4px 0 rgba(201, 255, 67, 0.18);
  transform: rotate(-3deg);
}
.plugin-identity span {
  font:
    900 7px/1 ui-monospace,
    monospace;
  letter-spacing: 0.16em;
  color: #c9ff43;
}
.plugin-identity h4 {
  margin: 4px 0 3px;
  font-size: 16px;
  color: #fff;
}
.plugin-identity p {
  margin: 0;
  font-size: 9px;
  color: #838da2;
}
.plugin-identity code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.07);
  color: #dffcff;
  font-family: ui-monospace, monospace;
}
.plugin-identity strong {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font:
    900 23px/1 ui-monospace,
    monospace;
  color: #ff9bcc;
  text-shadow: 2px 2px 0 rgba(46, 242, 255, 0.3);
}
.plugin-identity strong small {
  margin-top: 3px;
  font-size: 7px;
  letter-spacing: 0.13em;
  color: #7f899e;
}
.overwrite-alert {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 9px 0;
  padding: 7px 9px;
  border: 1px solid rgba(255, 138, 0, 0.34);
  border-radius: 8px;
  background: rgba(255, 138, 0, 0.08);
}
.overwrite-alert b {
  font-size: 10px;
  color: #ffc36e;
}
.overwrite-alert span {
  font-size: 9px;
  color: #a98768;
}
.preview-search {
  margin: 9px 0 6px;
}
.preview-search :deep(.el-input__wrapper) {
  background: rgba(5, 9, 20, 0.72);
  box-shadow: 0 0 0 1px rgba(46, 242, 255, 0.15) inset;
}
.preview-search :deep(.el-input__inner) {
  color: #ecfeff;
  font-size: 10px;
}
.payload-grid {
  flex: 1;
  min-height: 0;
  max-height: 224px;
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  align-content: start;
  gap: 7px;
  padding: 4px;
  scrollbar-color: rgba(46, 242, 255, 0.35) transparent;
}
.payload-chip {
  position: relative;
  min-width: 0;
  min-height: 74px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-end;
  gap: 3px;
  padding: 8px;
  border: 1px solid currentColor;
  border-radius: 8px;
  white-space: normal;
  overflow: hidden;
  cursor: default;
  box-shadow: 0 8px 14px rgba(0, 0, 0, 0.22);
  transform: rotate(var(--card-tilt, 0deg));
  transition: 0.18s ease;
}
.payload-chip:nth-child(3n + 1) {
  --card-tilt: -1deg;
}
.payload-chip:nth-child(3n) {
  --card-tilt: 1deg;
}
.payload-chip:hover {
  z-index: 2;
  transform: translateY(-3px) rotate(0);
  filter: brightness(1.18);
}
.payload-chip::after {
  content: '';
  position: absolute;
  inset: 4px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 5px;
  pointer-events: none;
}
.payload-chip i {
  position: absolute;
  right: 8px;
  top: 7px;
  width: auto;
  height: auto;
  background: none;
  border-radius: 0;
  font-size: 12px;
  text-shadow: 0 0 8px currentColor;
}
.payload-chip b {
  position: relative;
  z-index: 1;
  max-width: 100%;
  font-size: 10px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.payload-chip small {
  position: relative;
  z-index: 1;
  font:
    800 6px/1 ui-monospace,
    monospace;
  letter-spacing: 0.1em;
  opacity: 0.72;
}
.preview-pages {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 9px;
  color: #808ba1;
}
.preview-pages button {
  width: 26px;
  height: 23px;
  border: 1px solid rgba(46, 242, 255, 0.2);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  color: #8cf8ff;
  cursor: pointer;
}
.ghost-btn,
.primary-btn {
  height: 30px;
  padding: 0 13px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}
.ghost-btn {
  border: 1px solid rgba(255, 255, 255, 0.13);
  background: rgba(255, 255, 255, 0.05);
  color: #cbd5e1;
}
.primary-btn {
  border: 0;
  background: linear-gradient(105deg, #ff8a00, #ff3cac 43%, #2ef2ff 78%, #c9ff43);
  color: #071018;
  box-shadow: 4px 4px 0 rgba(255, 255, 255, 0.12);
}
.scan-panel,
.success-panel {
  height: 100%;
  min-height: 300px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.scan-panel b,
.success-panel h4 {
  margin: 14px 0 4px;
  font-size: 16px;
  color: #fff;
}
.scan-panel small,
.success-panel p {
  margin: 0;
  font-size: 10px;
  color: #8791a7;
}
.success-panel > span {
  font:
    900 8px/1 ui-monospace,
    monospace;
  letter-spacing: 0.18em;
  color: #c9ff43;
}
.success-panel p {
  max-width: 260px;
  line-height: 1.5;
}
.shuffle-cards {
  position: relative;
  width: 184px;
  height: 106px;
}
.shuffle-cards > span {
  --shift: calc((var(--i) - 3.5) * 16px);
  position: absolute;
  left: 64px;
  top: 5px;
  width: 54px;
  height: 80px;
  display: grid;
  place-items: center;
  border: 2px solid #fff;
  border-radius: 7px;
  background: linear-gradient(145deg, hsl(calc(var(--i) * 48), 88%, 55%), #111a2d 46%);
  box-shadow:
    0 0 0 2px hsl(calc(var(--i) * 61), 100%, 65%),
    0 10px 18px rgba(0, 0, 0, 0.36);
  transform: translateX(var(--shift)) rotate(calc((var(--i) - 3.5) * 7deg));
  animation: plugin-shuffle 1.1s ease-in-out infinite;
  animation-delay: calc(var(--i) * -80ms);
}
.shuffle-cards i {
  font-size: 18px;
  color: #fff;
  text-shadow: 0 0 8px currentColor;
}
.reveal-card {
  width: 82px;
  height: 116px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 2px solid #fff;
  border-radius: 9px;
  background: linear-gradient(145deg, #ff8a00, #ff3cac 34%, #12203b 35% 72%, #2ef2ff 73%);
  box-shadow:
    0 0 0 3px #c9ff43,
    0 0 32px rgba(255, 60, 172, 0.28);
  transform: rotate(4deg);
  animation: plugin-reveal 0.7s cubic-bezier(0.2, 0.9, 0.25, 1.2) both;
}
.reveal-card span {
  font:
    900 7px/1 ui-monospace,
    monospace;
  color: #091018;
  background: #c9ff43;
  padding: 3px 5px;
}
.reveal-card b {
  margin-top: 8px;
  font: 1000 16px/1 system-ui;
  color: #fff;
  text-shadow: 2px 2px 0 #ff3cac;
}
.reveal-card i {
  margin-top: 9px;
  color: #fff;
  font-size: 21px;
}
@keyframes plugin-shuffle {
  50% {
    transform: translateX(calc(var(--shift) * -1)) translateY(-8px)
      rotate(calc((var(--i) - 3.5) * -7deg));
    z-index: 8;
  }
}
@keyframes plugin-reveal {
  from {
    opacity: 0;
    transform: translateY(40px) rotate(-12deg) scale(0.62);
  }
}
@media (max-width: 680px) {
  .configuration-grid,
  .credential-vault {
    grid-template-columns: 1fr;
  }
  .url-field {
    grid-template-columns: 1fr;
  }
  .payload-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .beam-btn {
    width: 100%;
  }
}
.proxy-field {
  margin-top: 8px;
}
.import-error-banner {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin-bottom: 10px;
  padding: 9px 11px;
  border: 1px solid rgba(255, 60, 172, 0.4);
  border-radius: 10px;
  background: linear-gradient(145deg, rgba(255, 60, 172, 0.12), rgba(8, 13, 25, 0.92));
  box-shadow:
    0 0 0 1px rgba(255, 60, 172, 0.12),
    0 8px 18px rgba(0, 0, 0, 0.3);
}
.import-error-banner .ie-icon {
  flex: none;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  background: rgba(255, 60, 172, 0.22);
  color: #ff9ad4;
  font-size: 13px;
}
.import-error-banner .ie-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.import-error-banner .ie-body b {
  font-size: 11px;
  color: #fff;
}
.import-error-banner .ie-body p {
  margin: 0;
  font-size: 10px;
  color: #fda4af;
}
.import-error-banner .ie-body small {
  font-size: 9px;
  color: #9ba6ba;
}
.import-error-banner .ie-body .ie-raw {
  color: #6b7488;
  word-break: break-all;
}
.import-error-banner .ie-close {
  flex: none;
  width: 20px;
  height: 20px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  background: transparent;
  color: #cbd5e1;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0;
}
.import-error-banner .ie-close:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}
.import-error-banner.kind-proxy {
  border-color: rgba(255, 138, 0, 0.42);
  background: linear-gradient(145deg, rgba(255, 138, 0, 0.12), rgba(8, 13, 25, 0.92));
}
.import-error-banner.kind-proxy .ie-icon {
  background: rgba(255, 138, 0, 0.22);
  color: #ffc267;
}
.import-error-banner.kind-git,
.import-error-banner.kind-network {
  border-color: rgba(46, 242, 255, 0.4);
  background: linear-gradient(145deg, rgba(46, 242, 255, 0.1), rgba(8, 13, 25, 0.92));
}
.import-error-banner.kind-git .ie-icon,
.import-error-banner.kind-network .ie-icon {
  background: rgba(46, 242, 255, 0.2);
  color: #8cf8ff;
}
</style>
