<script setup lang="ts">
/**
 * SkillImportDialog：技能导入对话框。
 *
 * 将原 SkillsTab 底部 .imp-bar 导入栏提升为独立对话框，包含：
 *   - 从 Git 仓库：URL → 拉取分支 → 选分支 + 鉴权 → 导入（三步流程）
 *   - 从本地 ZIP：上传 .zip 包
 *
 * 导入确认阶段委托 ImportConfirmDialog。
 * 所有导入相关状态与函数从 SkillsTab 迁入此组件。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { Upload } from '@element-plus/icons-vue'
import {
  agentApi,
  type SkillCommitSelection,
  type SkillPreImportResult,
  type SkillImportRequest,
  type SkillImportResponse,
  type CredentialListItemDTO,
} from '@/services/agentApi'
import ImportConfirmDialog from './ImportConfirmDialog.vue'
import ImportPortalFrame, { type PortalPhase } from './ImportPortalFrame.vue'
import LabelTip from '../../components/LabelTip.vue'
import { classifyImportError, type ImportErrorInfo } from './importError'

const props = defineProps<{ visible: boolean; resyncSourceId?: string }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'imported'): void
  (e: 'error', msg: string): void
}>()

// ── 导入栏状态 ──────────────────────────────────────────────────
const urlInput = ref('')
const branch = ref('')
const credId = ref<string>('')
const username = ref('')
const password = ref('')
const remember = ref(false)
const proxy = ref('')
const busy = ref(false)
const success = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

/** preImport 探测结果（分支列表 + needsAuth/gitNotInstalled）。 */
const pre = ref<SkillPreImportResult | null>(null)
const gitNotInstalled = ref(false)

// ── 凭据池 ─────────────────────────────────────────────────────
const credPool = ref<CredentialListItemDTO[]>([])

async function loadCredPool(): Promise<void> {
  try {
    credPool.value = await agentApi.listCredentials()
  } catch (e) {
    console.error('[SkillImportDialog] listCredentials failed:', e)
    credPool.value = []
  }
}
const isNewCred = computed(
  () => !credId.value || !credPool.value.some((c) => c.id === credId.value),
)

// ── 两阶段 stage -> commit 状态 ───────────────────────────────
const stage = ref<SkillImportResponse | null>(null)
/** re-sync 模式：原已导入项预勾选。 */
const preChecked = ref<Set<string> | undefined>(undefined)
const resyncMode = ref(false)

const portalPhase = computed<PortalPhase>(() => {
  if (success.value) return 'success'
  if (stage.value && busy.value) return 'committing'
  if (stage.value) return 'review'
  if (busy.value) return 'scanning'
  if (pre.value) return 'configure'
  return 'source'
})
const portalStatus = computed(() => {
  if (success.value) return { text: '稀有卡已收入收藏', detail: '技能写入完成，正在刷新卡册索引' }
  if (stage.value && busy.value) return { text: '正在收拢卡组', detail: '选择已经锁定，请稍候' }
  if (stage.value)
    return { text: '新卡等待翻选', detail: `${stage.value.candidates.length} 张技能卡等待确认` }
  if (busy.value)
    return {
      text: resyncMode.value ? '正在重洗卡组' : '正在撕开卡包',
      detail: '读取来源、整理技能与检查重复卡',
    }
  if (pre.value)
    return { text: '卡包信息已确认', detail: `${pre.value.branches.length} 个版本可以开包` }
  return { text: '今晚开点什么？', detail: '挑选 Git 补充包或本地 ZIP 卡包' }
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

// ── seq-guard ───────────────────────────────────────────────────
let preImportSeq = 0

/** 确认拉取：分支列表 + needsAuth/gitNotInstalled 探测。 */
async function onPreImport(): Promise<void> {
  const u = urlInput.value.trim()
  if (!u || busy.value) return
  importError.value = null
  const seq = ++preImportSeq
  busy.value = true
  try {
    const res = await agentApi.preImportSkillUrl(
      u,
      credId.value || undefined,
      proxy.value.trim() || undefined,
    )
    if (seq !== preImportSeq) return
    pre.value = res
    gitNotInstalled.value = res.gitNotInstalled
    if (res.gitNotInstalled) {
      onError('Git 导入需系统安装 git CLI（当前未检测到）')
      return
    }
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

/** 导入按钮：按选定分支 clone 到 staging。 */
async function onImport(): Promise<void> {
  const u = urlInput.value.trim()
  if (!u || !branch.value || busy.value) return
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
  busy.value = true
  importError.value = null
  const proxyVal = proxy.value.trim() || undefined
  try {
    const req: SkillImportRequest = !pre.value?.needsAuth
      ? { url: u, branch: branch.value, ...(proxyVal ? { proxy: proxyVal } : {}) }
      : isNewCred.value
        ? {
            url: u,
            branch: branch.value,
            ...(username.value ? { username: username.value } : {}),
            ...(password.value ? { password: password.value } : {}),
            remember: remember.value,
            ...(credId.value ? { label: credId.value } : {}),
            ...(proxyVal ? { proxy: proxyVal } : {}),
          }
        : {
            url: u,
            branch: branch.value,
            credentialId: credId.value,
            ...(proxyVal ? { proxy: proxyVal } : {}),
          }
    const res = await agentApi.importSkillUrl(req)
    stage.value = res
    preChecked.value = undefined
    resyncMode.value = false
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

async function startResync(sourceId: string): Promise<void> {
  if (busy.value) return
  importError.value = null
  busy.value = true
  try {
    const res = await agentApi.resyncSkillSource(sourceId)
    stage.value = res
    preChecked.value = new Set(res.selected)
    resyncMode.value = true
  } catch (err) {
    emitError(err)
  } finally {
    busy.value = false
  }
}

/** ZIP 上传。 */
function triggerZip(): void {
  fileInput.value?.click()
}
async function onZipFile(e: Event): Promise<void> {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (!file) return
  await processZip(file)
}
async function processZip(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    onError('本地卡包只接受 .zip 文件')
    return
  }
  importError.value = null
  busy.value = true
  try {
    const res = await agentApi.importSkillZip(file)
    stage.value = {
      ...res,
      branch: undefined,
      commitSha: undefined,
      commitDate: undefined,
      savedCredentialId: undefined,
    }
    preChecked.value = undefined
    resyncMode.value = false
  } catch (err) {
    emitError(err)
  } finally {
    busy.value = false
  }
}
async function onZipDrop(event: DragEvent): Promise<void> {
  const file = event.dataTransfer?.files?.[0]
  if (file) await processZip(file)
}

/** 确认导入/同步。 */
async function onConfirm(selections: SkillCommitSelection[]): Promise<void> {
  if (!stage.value) return
  importError.value = null
  busy.value = true
  try {
    await agentApi.commitSkillImport(stage.value.stagingId, selections)
    success.value = true
    emit('imported')
    await wait(900)
    stage.value = null
    resetImportBar()
    success.value = false
    emit('update:visible', false)
  } catch (err) {
    emitError(err)
  } finally {
    busy.value = false
  }
}
function onCancelImport(): void {
  stage.value = null
}
function resetImportBar(): void {
  branch.value = ''
  credId.value = ''
  username.value = ''
  password.value = ''
  remember.value = false
  proxy.value = ''
  importError.value = null
  pre.value = null
}

// ── 对话框关闭时重置 ────────────────────────────────────────────
function onDialogClose(): void {
  if (busy.value) return
  resetImportBar()
  urlInput.value = ''
  stage.value = null
  success.value = false
  emit('update:visible', false)
}

// ── 生命周期 ────────────────────────────────────────────────────
onMounted(() => {
  void loadCredPool()
})
watch(
  () => props.visible,
  (v) => {
    if (v) {
      void loadCredPool()
      if (props.resyncSourceId) void startResync(props.resyncSourceId)
    }
  },
)
</script>

<template>
  <ImportPortalFrame
    :visible="visible"
    :title="resyncSourceId ? '同步技能仓库' : '导入技能'"
    eyebrow="SKILL BOOSTER NIGHT"
    tone="skill"
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
      <div class="reveal-card"><span>NEW</span><b>SKILL</b><i>★</i></div>
      <span>COLLECTION UPDATED</span>
      <h4>好卡！已经收入技能卡册</h4>
      <p>新技能马上会出现在列表里。</p>
    </div>

    <ImportConfirmDialog
      v-else-if="stage"
      :visible="true"
      :candidates="stage.candidates"
      :pre-checked="preChecked"
      :source-meta="{
        branch: stage.branch,
        commitSha: stage.commitSha,
        commitDate: stage.commitDate,
      }"
      :resync-mode="resyncMode"
      @confirm="onConfirm"
      @cancel="onCancelImport"
      @update:visible="
        (v: boolean) => {
          if (!v) onCancelImport()
        }
      "
    />

    <div v-else-if="busy" class="scan-panel">
      <div class="shuffle-cards">
        <span v-for="n in 5" :key="n" :style="{ '--i': n }"><i>?</i></span>
      </div>
      <b>{{ resyncSourceId ? '正在重洗这套技能卡' : '卡包拆开了，正在洗牌' }}</b>
      <small>读取分支、SKILL.md 与重复卡…</small>
    </div>

    <div v-else-if="!resyncSourceId" class="source-console">
      <section class="source-card git-source" :class="{ connected: pre }">
        <header>
          <span class="source-symbol">GIT</span>
          <div><b>远程补充包</b><small>连接仓库，挑选想开的版本</small></div>
          <i>{{ pre ? 'PICKED' : 'SEALED' }}</i>
        </header>
        <div class="field url-field">
          <LabelTip label="仓库坐标" tip="支持 GitHub HTTPS、SSH 与 tree/branch URL" />
          <el-input
            v-model="urlInput"
            size="small"
            placeholder="https://github.com/user/skill-repo"
            :disabled="gitNotInstalled"
            @keydown.enter="onPreImport"
          />
          <button
            type="button"
            class="beam-btn"
            :disabled="busy || gitNotInstalled || !urlInput.trim()"
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
        <div v-if="pre && !pre.gitNotInstalled && pre.branches.length" class="configuration-grid">
          <div class="field branch-field">
            <LabelTip label="目标分支" tip="默认分支会自动选中" />
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
          <div v-if="pre.needsAuth" class="field">
            <LabelTip label="安全密钥" tip="选择已保存凭据或输入新标签" />
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
        </div>
        <div v-if="pre && pre.needsAuth && isNewCred" class="credential-vault">
          <span class="vault-label">PRIVATE PACK CODE</span>
          <template v-if="isNewCred">
            <div class="field">
              <LabelTip label="用户名" tip="GitHub 用户名" />
              <el-input v-model="username" size="small" placeholder="GitHub username" />
            </div>
            <div class="field">
              <LabelTip label="密令 / Token" tip="GitHub PAT 或密码" />
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
            </div>
          </template>
        </div>
        <div v-if="pre && !pre.gitNotInstalled && pre.branches.length" class="launch-row">
          <button
            type="button"
            class="launch-btn"
            :disabled="!urlInput.trim() || !branch || busy || gitNotInstalled"
            @click="onImport"
          >
            <span>撕开补充包</span><i>↗</i>
          </button>
        </div>
      </section>

      <section class="source-card zip-source" @dragover.prevent @drop.prevent="onZipDrop">
        <header>
          <span class="source-symbol">ZIP</span>
          <div><b>本地限定包</b><small>拖入或选择技能压缩包</small></div>
          <i>LIMITED</i>
        </header>
        <div class="drop-core" @click="triggerZip">
          <span class="drop-orbit"><Upload /></span>
          <b>把 .zip 卡包放到桌上</b>
          <small>单次开包，不建立 Git 来源</small>
          <input
            ref="fileInput"
            type="file"
            accept=".zip"
            class="hidden-file"
            @change="onZipFile"
          />
        </div>
      </section>
    </div>
  </ImportPortalFrame>
</template>

<style scoped lang="less">
@import '../../shared.less';
.source-console {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.source-card {
  position: relative;
  padding: 11px;
  border: 1px solid rgba(46, 242, 255, 0.16);
  border-radius: 13px;
  background: linear-gradient(145deg, rgba(46, 242, 255, 0.055), rgba(255, 255, 255, 0.018));
  overflow: hidden;
  transition: 0.2s ease;
}
.source-card::before {
  content: '';
  position: absolute;
  left: -22px;
  top: -19px;
  width: 62px;
  height: 62px;
  background: #ff3cac;
  filter: blur(25px);
  opacity: 0.1;
}
.source-card::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 38%;
  top: 0;
  height: 2px;
  background: linear-gradient(90deg, #2ef2ff, #c9ff43, transparent);
  box-shadow: 0 0 8px #2ef2ff;
}
.source-card.connected {
  border-color: rgba(201, 255, 67, 0.42);
  box-shadow: 4px 4px 0 rgba(201, 255, 67, 0.07);
}
.source-card header {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 9px;
}
.source-symbol {
  width: 31px;
  height: 29px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(46, 242, 255, 0.38);
  border-radius: 7px 4px 7px 4px;
  background: #101a2c;
  color: #2ef2ff;
  font:
    1000 8px/1 ui-monospace,
    monospace;
  transform: rotate(-3deg);
  box-shadow: 3px 3px 0 rgba(255, 60, 172, 0.18);
}
.source-card header div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.source-card header b {
  font-size: 12px;
  color: #f8fafc;
}
.source-card header small {
  font-size: 9px;
  color: #758096;
}
.source-card header i {
  margin-left: auto;
  font:
    900 8px/1 ui-monospace,
    monospace;
  letter-spacing: 0.12em;
  color: #c9ff43;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.field :deep(.label-tip-label) {
  color: #9ba6ba;
}
.field :deep(.el-input),
.field :deep(.el-select) {
  width: 100%;
}
.field :deep(.el-input__wrapper),
.field :deep(.el-select__wrapper) {
  background: rgba(5, 9, 20, 0.76);
  box-shadow: 0 0 0 1px rgba(46, 242, 255, 0.15) inset;
}
.field :deep(.el-input__inner),
.field :deep(.el-select__selected-item) {
  color: #edf9ff;
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
  border: 1px solid rgba(46, 242, 255, 0.35);
  border-radius: 8px;
  background: rgba(46, 242, 255, 0.08);
  color: #c9fbff;
  font-size: 10px;
  font-weight: 900;
  cursor: pointer;
  transition: 0.18s ease;
}
.beam-btn {
  height: 24px;
  padding: 0 10px;
}
.beam-btn:hover:not(:disabled) {
  box-shadow: 3px 3px 0 rgba(255, 60, 172, 0.22);
  transform: translate(-1px, -1px);
}
.configuration-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
  margin-top: 8px;
}
.credential-vault {
  position: relative;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
  margin-top: 8px;
  padding: 15px 8px 8px;
  border: 1px dashed rgba(255, 138, 0, 0.32);
  border-radius: 9px;
  background: rgba(255, 138, 0, 0.045);
}
.vault-label {
  position: absolute;
  left: 8px;
  top: 4px;
  font:
    900 7px/1 ui-monospace,
    monospace;
  letter-spacing: 0.15em;
  color: #ffb03d;
}
.cred-chk {
  display: flex;
  align-items: flex-end;
  font-size: 10px;
}
.launch-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
.launch-btn {
  height: 30px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  border: 0;
  background: linear-gradient(105deg, #c9ff43, #2ef2ff 52%, #ff8a00);
  color: #081018;
  box-shadow: 4px 4px 0 rgba(255, 60, 172, 0.22);
}
.launch-btn i {
  font-size: 15px;
}
.launch-btn:hover:not(:disabled) {
  transform: translate(-2px, -2px);
  box-shadow: 6px 6px 0 rgba(255, 60, 172, 0.3);
}
button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.zip-source {
  border-color: rgba(255, 60, 172, 0.18);
}
.zip-source::after {
  background: linear-gradient(90deg, #ff3cac, #ff8a00, transparent);
  box-shadow: 0 0 8px #ff3cac;
}
.zip-source .source-symbol {
  border-color: rgba(255, 60, 172, 0.44);
  color: #ff83c9;
  box-shadow: 3px 3px 0 rgba(255, 138, 0, 0.2);
}
.drop-core {
  min-height: 82px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border: 1px dashed rgba(255, 60, 172, 0.32);
  border-radius: 9px;
  background: linear-gradient(135deg, rgba(255, 60, 172, 0.06), rgba(255, 138, 0, 0.045));
  cursor: pointer;
  transition: 0.2s ease;
}
.drop-core:hover {
  border-color: #ff3cac;
  background: linear-gradient(135deg, rgba(255, 60, 172, 0.12), rgba(255, 138, 0, 0.09));
  transform: translateY(-1px);
}
.drop-orbit {
  width: 32px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(255, 138, 0, 0.48);
  border-radius: 6px 3px 6px 3px;
  color: #ffb44d;
  background: #171422;
  box-shadow: 3px 3px 0 rgba(255, 60, 172, 0.2);
  animation: zip-pack 2s ease-in-out infinite;
}
.drop-orbit svg {
  width: 13px;
}
.drop-core b {
  font-size: 11px;
  color: #ffeaf7;
}
.drop-core small {
  font-size: 9px;
  color: #758096;
}
.hidden-file {
  display: none;
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
  color: #f8fafc;
}
.scan-panel small,
.success-panel p {
  margin: 0;
  font-size: 10px;
  color: #8590a6;
}
.shuffle-cards {
  position: relative;
  width: 170px;
  height: 104px;
}
.shuffle-cards > span {
  --shift: calc((var(--i) - 3) * 18px);
  position: absolute;
  left: 57px;
  top: 4px;
  width: 54px;
  height: 80px;
  display: grid;
  place-items: center;
  border: 2px solid #eef7ff;
  border-radius: 7px;
  background: repeating-linear-gradient(135deg, #11192c 0 7px, #223152 7px 14px);
  box-shadow:
    0 0 0 2px hsl(calc(var(--i) * 67), 100%, 62%),
    0 10px 18px rgba(0, 0, 0, 0.35);
  transform: translateX(var(--shift)) rotate(calc((var(--i) - 3) * 8deg));
  animation: shuffle 1.1s ease-in-out infinite;
  animation-delay: calc(var(--i) * -90ms);
}
.shuffle-cards i {
  font: 1000 22px/1 system-ui;
  color: #fff;
  text-shadow:
    2px 1px 0 #ff3cac,
    -2px -1px 0 #2ef2ff;
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
.reveal-card {
  width: 78px;
  height: 112px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 2px solid #fff;
  border-radius: 9px;
  background: linear-gradient(145deg, #ff3cac, #ff8a00 32%, #13213d 33% 72%, #2ef2ff 73%);
  box-shadow:
    0 0 0 3px #c9ff43,
    0 0 30px rgba(46, 242, 255, 0.3);
  transform: rotate(-4deg);
  animation: reveal-card 0.7s cubic-bezier(0.2, 0.9, 0.25, 1.2) both;
}
.reveal-card span {
  font:
    900 7px/1 ui-monospace,
    monospace;
  color: #081018;
  background: #c9ff43;
  padding: 3px 5px;
}
.reveal-card b {
  margin-top: 8px;
  font: 1000 17px/1 system-ui;
  color: #fff;
  text-shadow: 2px 2px 0 #ff3cac;
}
.reveal-card i {
  margin-top: 9px;
  color: #fff;
  font-size: 20px;
}
.success-panel h4 {
  margin-top: 9px;
}
@keyframes zip-pack {
  50% {
    transform: translateY(-3px) rotate(3deg);
    box-shadow: 5px 5px 0 rgba(255, 60, 172, 0.3);
  }
}
@keyframes shuffle {
  50% {
    transform: translateX(calc(var(--shift) * -1)) translateY(-8px)
      rotate(calc((var(--i) - 3) * -7deg));
    z-index: 8;
  }
}
@keyframes reveal-card {
  from {
    opacity: 0;
    transform: translateY(38px) rotate(13deg) scale(0.62);
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
  .beam-btn {
    width: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .drop-orbit,
  .shuffle-cards > span,
  .reveal-card {
    animation: none !important;
  }
  .source-card,
  .drop-core,
  .beam-btn,
  .launch-btn {
    transition: none !important;
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
