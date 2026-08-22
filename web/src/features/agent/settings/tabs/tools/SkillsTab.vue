<script setup lang="ts">
/**
 * SkillsTab：技能管理面板（独立 skill + git 来源索引）。
 *
 * 两个区域：
 *   - Git 来源区：每个来源卡片（url/branch/commit/skills）+ re-sync/deleteSource 按钮。
 *   - 独立技能区：`.chery/skills/` 下不属于任何来源的 skill（可删）。
 *
 * 支持搜索 + 分页（后端 skills.list 分页 API）。
 * 导入操作移入 SkillImportDialog 弹窗。
 *
 * 列表数据：SkillsTab 自行管理分页数据（直接调 agentApi.listSkills），
 * SettingsDialog 的 `initialSkills` 仅用于首次加载和来源索引关联。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { Delete, Refresh, Search } from '@element-plus/icons-vue'
import { agentApi, type SkillInfo, type SkillSource } from '@/services/agentApi'
import TabShell, { type IndexItem } from '@/components/layout/TabShell.vue'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import SkillImportDialog from './components/SkillImportDialog.vue'

const props = defineProps<{ initialSkills: SkillInfo[]; sources: SkillSource[] }>()
const emit = defineEmits<{ (e: 'error', msg: string): void; (e: 'refresh-skills'): void }>()

// ── 分页状态 ──────────────────────────────────────────────────────
const searchQuery = ref('')
const currentPage = ref(1)
const pageSize = 50
const totalSkills = ref(0)
const skills = ref<SkillInfo[]>(props.initialSkills)
const loading = ref(false)

let searchDebounce: ReturnType<typeof setTimeout> | null = null
let fetchSeq = 0

async function fetchSkills(): Promise<void> {
  const seq = ++fetchSeq
  loading.value = true
  try {
    const result = await agentApi.listSkills({
      page: currentPage.value,
      pageSize,
      search: searchQuery.value || undefined,
      plugin: undefined, // 仅独立 skill
    })
    if (seq !== fetchSeq) return
    skills.value = result.skills
    totalSkills.value = result.total
  } catch (e) {
    console.error('[SkillsTab] listSkills failed:', e)
  } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

function onSearchInput(value: string): void {
  searchQuery.value = value
  if (searchDebounce) clearTimeout(searchDebounce)
  searchDebounce = setTimeout(() => {
    currentPage.value = 1
    void fetchSkills()
  }, 300)
}
function onSearchClear(): void {
  if (searchDebounce) clearTimeout(searchDebounce)
  searchDebounce = null
  searchQuery.value = ''
  currentPage.value = 1
  void fetchSkills()
}

function onPageChange(page: number): void {
  currentPage.value = page
  void fetchSkills()
}

// ── 导入弹窗 ──────────────────────────────────────────────────────
const importDialogOpen = ref(false)
const syncSourceId = ref<string | undefined>(undefined)

function openNewImport(): void {
  syncSourceId.value = undefined
  importDialogOpen.value = true
}

// ── 删除独立 skill ─────────────────────────────────────────────────
const busy = ref(false)

function removeSourceImpact(src: SkillSource): string[] {
  return [`将删除来源「${src.cloneUrl}」下的全部 ${src.skillCount} 个技能。`]
}

function onError(msg: string): void {
  emit('error', msg)
}
function emitError(err: unknown): void {
  const e = err as { message?: string }
  onError(e?.message ?? String(err))
}
function refresh(): void {
  emit('refresh-skills')
  void fetchSkills()
}

// ── 批量刷新状态 ───────────────────────────────────────────────
const refreshingAll = ref(false)
const checkingIds = ref<Set<string>>(new Set())

// ── 独立 skill 列表 ──────────────────────────────────────────────────
/** 技能列表与仓库展示解耦：所有独立 skill 在同一分页列表中展示。 */
const standalone = computed(() => skills.value)

const indexItems = computed<IndexItem[]>(() =>
  standalone.value.map((s) => ({
    label: s.name,
    anchor: s.name,
    description: s.description || '无描述',
  })),
)

async function onDelete(name: string): Promise<void> {
  busy.value = true
  try {
    await agentApi.deleteSkill(name)
    refresh()
  } catch (err) {
    emitError(err)
  } finally {
    busy.value = false
  }
}

/** re-sync 来源。 */
async function onResyncSource(src: SkillSource): Promise<void> {
  if (refreshingAll.value) return
  syncSourceId.value = src.id
  importDialogOpen.value = true
}
async function onCheckSource(src: SkillSource): Promise<void> {
  if (checkingIds.value.has(src.id)) return
  checkingIds.value.add(src.id)
  try {
    await agentApi.checkSkillSource(src.id)
    refresh()
  } catch (err) {
    emitError(err)
  } finally {
    checkingIds.value.delete(src.id)
  }
}
/** 批量刷新全部来源。 */
async function onResyncAllSources(): Promise<void> {
  if (refreshingAll.value || props.sources.length === 0) return
  refreshingAll.value = true
  try {
    const res = await agentApi.checkAllSkillSources()
    if (res.failed.length > 0) {
      onError(res.failed.map((r) => `${r.sourceId}: ${r.reason}`).join('\n'))
    }
    refresh()
  } catch (err) {
    emitError(err)
  } finally {
    refreshingAll.value = false
  }
}
async function onDeleteSource(src: SkillSource): Promise<void> {
  if (busy.value || refreshingAll.value) return
  busy.value = true
  try {
    await agentApi.deleteSkillSource(src.id)
    refresh()
  } catch (err) {
    emitError(err)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void fetchSkills()
})
onBeforeUnmount(() => {
  if (searchDebounce) clearTimeout(searchDebounce)
})

// ── helpers ──────────────────────────────────────────────────────────
function shortSha(sha: string | undefined): string {
  return sha && sha.length >= 7 ? sha.slice(0, 7) : sha || '—'
}
function formatDate(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : '—'
}
function formatDateTime(iso: string | undefined): string {
  if (!iso) return '—'
  return iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso
}
</script>

<template>
  <TabShell
    tab-key="skills"
    :index-items="indexItems"
    :page="currentPage"
    :page-size="pageSize"
    :total="totalSkills"
    @page-change="onPageChange"
  >
    <template #hints>
      <p class="sect-hint">
        技能存于 <code>.chery/skills</code>。ZIP/URL 导入后实时生效，无需重启。Git 来源支持
        re-sync。
      </p>
    </template>
    <template #popper="{ item }">
      <div class="index-card">
        <div class="index-card-title">{{ item.label as string }}</div>
        <div class="index-card-line">
          <b>说明</b><span>{{ item.description as string }}</span>
        </div>
      </div>
    </template>

    <template #toolbar>
      <div class="search-bar fixed-search">
        <el-input
          v-model="searchQuery"
          placeholder="搜索技能名、说明或触发词"
          clearable
          size="small"
          @input="onSearchInput"
          @clear="onSearchClear"
        >
          <template #prefix><Search class="ico" /></template>
        </el-input>
        <span class="search-status">{{ loading ? '扫描中…' : `${totalSkills} 个技能` }}</span>
      </div>
    </template>

    <!-- Git 来源区 -->
    <section class="section">
      <header class="sect-head">
        <h3 class="sect-title">已挂载仓库</h3>
        <div class="source-actions">
          <button type="button" class="ghost-btn" @click="openNewImport">+ 导入新仓库</button>
          <button
            type="button"
            class="ghost-btn refresh-all-btn"
            :disabled="refreshingAll || !sources.length"
            @click="onResyncAllSources"
          >
            <Refresh class="ico" :class="{ spinning: refreshingAll }" />
            {{ refreshingAll ? '检查中…' : '检查全部更新' }}
          </button>
        </div>
      </header>
      <div v-if="sources.length" class="source-grid">
        <article v-for="src in sources" :key="src.id" class="card source-card">
          <header class="card-head" style="padding-left: 0">
            <span class="card-title">{{ src.cloneUrl }}</span>
            <el-tooltip
              v-if="src.lastCheckError || src.lastSyncError"
              :content="src.lastCheckError || src.lastSyncError"
              placement="top"
              :show-after="200"
            >
              <span class="badge fail">检查失败</span>
            </el-tooltip>
            <span v-if="src.updateAvailable" class="badge warn">有更新</span>
            <span v-else-if="src.lastCheckedAt" class="badge ok">最新</span>
            <el-tooltip content="只检查远端 HEAD，不修改本地技能" placement="top" :show-after="200">
              <button
                type="button"
                class="icon-btn"
                :disabled="checkingIds.has(src.id) || refreshingAll"
                @click.stop="onCheckSource(src)"
              >
                <Refresh class="ico" :class="{ spinning: checkingIds.has(src.id) }" />
              </button>
            </el-tooltip>
            <ConfirmPopover
              :title="`删除来源「${src.cloneUrl}」？`"
              :impact="removeSourceImpact(src)"
              @confirm="onDeleteSource(src)"
            >
              <template #trigger>
                <button
                  type="button"
                  class="icon-btn danger"
                  aria-label="删除来源"
                  :disabled="refreshingAll"
                  @click.stop
                >
                  <Delete class="ico" />
                </button>
              </template>
            </ConfirmPopover>
          </header>
          <div class="src-meta">
            <span class="badge branch">{{ src.branch }}</span>
            <span class="meta-item"
              >HEAD <code>{{ shortSha(src.commitSha) }}</code></span
            >
            <span class="meta-item">{{ formatDate(src.commitDate) }}</span>
            <span class="meta-item">上次同步 {{ formatDateTime(src.lastSyncedAt) }}</span>
            <span class="meta-item">上次检查 {{ formatDateTime(src.lastCheckedAt) }}</span>
          </div>
          <div class="source-foot">
            <span>{{ src.skillCount }} 个技能</span>
            <button
              v-if="src.updateAvailable"
              type="button"
              class="sync-btn"
              @click="onResyncSource(src)"
            >
              同步并选择候选
            </button>
          </div>
        </article>
      </div>
      <div v-else class="source-empty">尚未挂载技能仓库，可从 Git URL 导入。</div>
    </section>

    <!-- 独立技能区 -->
    <section class="section">
      <div class="sect-head">
        <h3 class="sect-title">技能列表</h3>
        <button type="button" class="ghost-btn" @click="openNewImport">+ 导入技能</button>
      </div>
      <div class="standalone-grid">
        <article v-for="(s, i) in standalone" :key="s.name" class="card" :data-anchor="s.name">
          <span class="card-idx">{{ (currentPage - 1) * pageSize + i + 1 }}</span>
          <header class="card-head skill-head">
            <div class="title-row">
              <div class="title-cell">
                <el-tooltip :content="s.name" placement="top" :show-after="300">
                  <span class="card-title">{{ s.name }}</span>
                </el-tooltip>
              </div>
              <ConfirmPopover :title="`确认删除技能「${s.name}」？`" @confirm="onDelete(s.name)">
                <template #trigger>
                  <button type="button" class="icon-btn danger" aria-label="删除" :disabled="busy">
                    <Delete class="ico" />
                  </button>
                </template>
              </ConfirmPopover>
            </div>
            <div class="token-row">
              <el-tooltip placement="top" :show-after="300">
                <template #content>
                  <div style="max-width: 220px">
                    系统提示词 ≈ {{ s.nameDescTokens + (s.triggerTokens ?? 0) }} tok<br />
                    内容提示词 ≈ {{ s.contentTokens }} tok
                  </div>
                </template>
                <span class="badge system"
                  >系统 ≈{{ s.nameDescTokens + (s.triggerTokens ?? 0) }}</span
                >
              </el-tooltip>
              <span class="badge content">内容 ≈{{ s.contentTokens }}</span>
            </div>
          </header>
          <div v-if="s.description || s.trigger" class="skill-body">
            <span v-if="s.description"><span class="k">说明：</span>{{ s.description }}</span>
            <span v-if="s.trigger"> <span class="k">触发：</span>{{ s.trigger }}</span>
          </div>
        </article>
        <article v-if="!standalone.length && !loading" class="card empty-card">
          <span class="card-idx">·</span>
          <header class="card-head"><span class="empty-title">没有独立技能</span></header>
          <p class="empty-hint">通过 ZIP 或 GitHub URL 导入技能。</p>
        </article>
      </div>
    </section>

    <!-- 导入弹窗 -->
    <SkillImportDialog
      v-model:visible="importDialogOpen"
      :resync-source-id="syncSourceId"
      @imported="refresh"
      @error="onError"
      @update:visible="
        (v: boolean) => {
          importDialogOpen = v
          if (!v) syncSourceId = undefined
        }
      "
    />
  </TabShell>
</template>

<style scoped lang="less">
@import '../../config/shared.less';

// 技能列表网格：卡结构一致，grid 比 columns 整齐；套霓虹玻璃底 + hover 渐变描边。
.standalone-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px;
}
.standalone-grid > .card {
  .neon-glass();
  border-color: color-mix(in srgb, var(--neon-indigo) 20%, transparent);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
  &:hover {
    .neon-border(@neon-indigo);
  }
}

code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}
.fixed-search {
  flex: 1;
  min-width: 0;
  padding: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  .search-status {
    flex: 0 0 auto;
    font-size: 10px;
    color: color-mix(in srgb, var(--ink) 66%, transparent);
    font-variant-numeric: tabular-nums;
  }
}
.sect-hint {
  margin: 0 0 8px;
  font-size: 11px;
  color: color-mix(in srgb, var(--ink) 60%, transparent);
}
.section {
  margin-bottom: 12px;
}
.source-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
  gap: 7px;
}
.source-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.source-empty {
  padding: 14px 10px;
  border: 1px dashed color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 8px;
  color: color-mix(in srgb, var(--ink) 64%, transparent);
  font-size: 10px;
  text-align: center;
}
.source-card {
  min-width: 0;
}
.source-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
  margin-top: 7px;
  font-size: 10px;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
}
.sync-btn {
  border: 1px solid color-mix(in srgb, var(--tab-color, @accent) 42%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--tab-color, @accent) 14%, transparent);
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
  font-size: 10px;
  font-weight: 600;
  padding: 3px 9px;
  cursor: pointer;
}
.sect-title {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 70%, transparent);
  border-bottom: 1px dashed color-mix(in srgb, var(--ink) 12%, transparent);
  padding-bottom: 3px;
}
.sect-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  .sect-title {
    margin: 0;
    flex: 1;
    min-width: 0;
  }
  .refresh-all-btn {
    flex-shrink: 0;
  }
}
.card-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.spacer {
  flex: 1;
}
.card-title {
  flex: 1 1 180px;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.35;
}
// 技能卡 card-head：标题行 + token 行纵向堆叠（source-card 的 card-head 不受影响）
.skill-head {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  .title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  // el-tooltip 在 trigger 外包 .el-tooltip__trigger wrapper，需显式 cell 收缩 + :deep 穿透
  .title-cell {
    flex: 1 1 auto;
    min-width: 0;
    :deep(.el-tooltip__trigger) {
      display: block;
      max-width: 100%;
    }
  }
  .token-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  // 技能名单行截断，hover 由 el-tooltip 显示完整名
  .card-title {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
.badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;
  cursor: default;
  &.system {
    background: color-mix(in srgb, var(--ink) 8%, transparent);
    color: color-mix(in srgb, var(--ink) 65%, transparent);
  }
  &.content {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent-ink);
  }
  &.branch {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent-ink);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  }
  &.warn {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    color: var(--accent-ink);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  }
  &.ok {
    background: color-mix(in srgb, var(--success) 14%, transparent);
    color: var(--success);
  }
}
.skill-body {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--ink) 82%, transparent);
  word-break: break-word;
  display: flex;
  flex-direction: column;
  gap: 3px;
  .k {
    font-weight: 400;
    color: color-mix(in srgb, var(--ink) 88%, transparent);
  }
}
.src-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 11px;
  color: color-mix(in srgb, var(--ink) 60%, transparent);
  .meta-item {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
}
.skill-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.skill-tag {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--neon-indigo) 14%, transparent);
  color: var(--neon-indigo);
  cursor: default;
}
.empty-card {
  text-align: center;
  .empty-title {
    font-size: 14px;
    font-weight: 600;
    color: color-mix(in srgb, var(--ink) 80%, transparent);
  }
  .empty-hint {
    margin-top: 6px;
    font-size: 11px;
    color: color-mix(in srgb, var(--ink) 60%, transparent);
  }
}
.ghost-btn {
  height: 24px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 6px;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 80%, transparent);
  font-size: 11px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  line-height: 1;
  &:hover:not(:disabled) {
    background: var(--surface);
    color: color-mix(in srgb, var(--ink) 92%, transparent);
  }
  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}
.ico {
  width: 12px;
  height: 12px;
}
</style>
