<script setup lang="ts">
/**
 * Skill 导入确认对话框（两阶段导入的确认步）。
 *
 * 列出 stage 候选：非冲突默认勾选导入；冲突（skills_dir/<name> 已存在）默认跳过，
 * 用户可逐项勾选「覆盖」。确认后 emit confirm(selections) 供 SkillsTab 调 commitSkillImport。
 *
 * re-sync 模式（resyncMode=true）：preChecked 指定原已导入项预勾选；sourceMeta 展示分支/SHA/日期。
 * 取消勾选的已安装技能将脱离该来源（文件夹保留为独立技能）。
 */
import { computed, ref, watch } from 'vue'
import { Search } from '@element-plus/icons-vue'
import type { SkillCandidate, SkillCommitSelection } from '@/services/agentApi'

const props = defineProps<{
  visible: boolean
  candidates: SkillCandidate[]
  /** re-sync 模式：原已导入项预勾选（Set of name）。 */
  preChecked?: Set<string>
  /** git 来源 meta（分支/SHA/日期），顶部展示。 */
  sourceMeta?: { branch?: string; commitSha?: string; commitDate?: string }
  /** re-sync 模式：提示文案不同，取消勾选的已装技能脱离来源。 */
  resyncMode?: boolean
}>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'confirm', selections: SkillCommitSelection[]): void
  (e: 'cancel'): void
}>()

/** name -> 是否导入。 */
const decisions = ref<Record<string, boolean>>({})
const search = ref('')
const page = ref(1)
const pageSize = 30

watch(
  () => props.candidates,
  (list) => {
    const next: Record<string, boolean> = {}
    const pre = props.preChecked
    for (const c of list) {
      // re-sync 模式：preChecked 有则按之；否则按 conflict 默认
      next[c.name] = pre ? pre.has(c.name) : !c.conflict
    }
    decisions.value = next
  },
  { immediate: true },
)

const importCount = () => Object.values(decisions.value).filter(Boolean).length
const conflictCount = computed(
  () => props.candidates.filter((candidate) => candidate.conflict).length,
)
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return props.candidates
    .filter(
      (candidate) =>
        !q ||
        `${candidate.name} ${candidate.description} ${candidate.trigger ?? ''}`
          .toLowerCase()
          .includes(q),
    )
    .sort((a, b) => Number(b.conflict) - Number(a.conflict) || a.name.localeCompare(b.name))
})
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))
const visibleCandidates = computed(() =>
  filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize),
)
watch(search, () => {
  page.value = 1
})

function confirm(): void {
  const selections: SkillCommitSelection[] = props.candidates.map((c) => ({
    name: c.name,
    import: decisions.value[c.name] ?? false,
  }))
  emit('confirm', selections)
}
function cancel(): void {
  emit('cancel')
  emit('update:visible', false)
}

function selectVisible(value: boolean): void {
  const next = { ...decisions.value }
  for (const candidate of filtered.value) next[candidate.name] = value
  decisions.value = next
}

function shortSha(sha: string | undefined): string {
  return sha && sha.length >= 7 ? sha.slice(0, 7) : sha || '—'
}
function formatDate(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : '—'
}
</script>

<template>
  <section v-if="visible" class="cargo-review">
    <header class="review-head">
      <div>
        <span class="review-kicker">CARD REVEAL</span>
        <h4>{{ resyncMode ? '重新整理这套技能卡' : '翻出你想收藏的技能卡' }}</h4>
      </div>
      <div class="review-count">
        <b>{{ importCount() }}</b
        ><span>/ {{ candidates.length }}</span>
      </div>
    </header>
    <p class="dlg-hint">
      {{
        resyncMode
          ? '取消原有技能会让它脱离来源，但保留本地文件。'
          : '重复卡默认不收藏；主动翻亮后会替换现有技能。'
      }}
    </p>
    <div v-if="sourceMeta && (sourceMeta.branch || sourceMeta.commitSha)" class="source-meta">
      <span v-if="sourceMeta.branch" class="meta-item"
        >分支：<code>{{ sourceMeta.branch }}</code></span
      >
      <span v-if="sourceMeta.commitSha" class="meta-item"
        >HEAD <code>{{ shortSha(sourceMeta.commitSha) }}</code></span
      >
      <span v-if="sourceMeta.commitDate" class="meta-item">{{
        formatDate(sourceMeta.commitDate)
      }}</span>
    </div>
    <div class="candidate-tools">
      <el-input v-model="search" clearable size="small" placeholder="搜索名称、说明或触发词"
        ><template #prefix><Search class="search-icon" /></template
      ></el-input>
      <button type="button" @click="selectVisible(true)">全选结果</button>
      <button type="button" @click="selectVisible(false)">清空结果</button>
    </div>
    <div class="manifest-summary">
      <span>重复卡 {{ conflictCount }}</span
      ><i /><span>本轮翻出 {{ filtered.length }}</span>
    </div>
    <TransitionGroup tag="ul" name="cargo" class="cand-list">
      <li
        v-for="(c, index) in visibleCandidates"
        :key="c.name"
        class="cand"
        :class="{ conflict: c.conflict, selected: decisions[c.name] }"
        :style="{ '--delay': `${index * 24}ms` }"
        @click="decisions[c.name] = !decisions[c.name]"
      >
        <div class="card-foil" :style="{ '--hue': `${(index * 67) % 360}` }">
          <span>{{ c.conflict ? 'DUPLICATE' : 'NEW DROP' }}</span
          ><i>✦</i>
        </div>
        <div class="cargo-main">
          <div class="cargo-title">
            <span class="cand-name">{{ c.name }}</span>
            <span v-if="c.conflict" class="badge">重复</span>
            <span v-if="c.conflict && decisions[c.name]" class="badge overwrite">替换旧卡</span>
          </div>
          <div v-if="c.description || c.trigger" class="cand-meta">
            <p v-if="c.description" class="meta-row clamp">
              <span class="k">说明：</span>{{ c.description }}
            </p>
            <p v-if="c.trigger" class="meta-row"><span class="k">触发词：</span>{{ c.trigger }}</p>
          </div>
          <footer class="card-foot">
            <span>SKILL CARD</span>
            <div class="cargo-toggle" :class="{ on: decisions[c.name] }">
              <i>{{ decisions[c.name] ? '✓ 已收藏' : '点击翻选' }}</i>
            </div>
          </footer>
        </div>
      </li>
    </TransitionGroup>
    <div class="review-actions">
      <div v-if="pageCount > 1" class="candidate-pages">
        <button type="button" :disabled="page <= 1" @click="page--">‹</button
        ><span>{{ page }} / {{ pageCount }}</span
        ><button type="button" :disabled="page >= pageCount" @click="page++">›</button>
      </div>
      <span class="action-spacer" />
      <button type="button" class="ghost-btn" @click="cancel">取消</button>
      <button type="button" class="primary-btn" :disabled="importCount() === 0" @click="confirm">
        {{ resyncMode ? `更新卡组 · ${importCount()}` : `收入卡册 · ${importCount()}` }}
      </button>
    </div>
  </section>
</template>

<style scoped lang="less">
@import '../../../config/shared.less';

.cargo-review {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 320px;
}
.review-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.review-kicker {
  font:
    800 8px/1 ui-monospace,
    monospace;
  letter-spacing: 0.18em;
  color: #67e8f9;
}
.review-head h4 {
  margin: 4px 0 0;
  font-size: 15px;
  color: #fff;
}
.review-count {
  display: flex;
  align-items: baseline;
  gap: 3px;
  color: #94a3b8;
}
.review-count b {
  font:
    800 24px/1 ui-monospace,
    monospace;
  color: #67e8f9;
  text-shadow: 0 0 12px rgba(103, 232, 249, 0.5);
}
.review-count span {
  font-size: 10px;
}
.dlg-hint {
  margin: 8px 0;
  font-size: 10px;
  line-height: 1.45;
  color: #8290aa;
}
.source-meta {
  margin: 0 0 8px;
  font-size: 11px;
  color: #8290aa;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  .meta-item {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 10px;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.08);
    color: #dbeafe;
  }
}
.cand-list {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1;
  min-height: 0;
  max-height: 244px;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  scrollbar-color: rgba(103, 232, 249, 0.35) transparent;
}
.candidate-tools {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 6px;
}
.candidate-tools :deep(.el-input) {
  flex: 1;
}
.candidate-tools :deep(.el-input__wrapper) {
  background: rgba(6, 10, 25, 0.62);
  box-shadow: 0 0 0 1px rgba(103, 232, 249, 0.16) inset;
}
.candidate-tools :deep(.el-input__inner) {
  color: #e2e8f0;
  font-size: 10px;
}
.candidate-tools button {
  height: 24px;
  padding: 0 7px;
  border: 1px solid rgba(103, 232, 249, 0.18);
  border-radius: 7px;
  background: rgba(103, 232, 249, 0.06);
  color: #a5f3fc;
  font-size: 9px;
  cursor: pointer;
}
.search-icon {
  width: 12px;
}
.manifest-summary {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 6px;
  font-size: 9px;
  color: #64748b;
}
.manifest-summary i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #475569;
}
.candidate-pages {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  font-size: 9px;
  color: #8290aa;
}
.candidate-pages button {
  width: 25px;
  height: 23px;
  border: 1px solid rgba(103, 232, 249, 0.18);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  color: #a5f3fc;
  cursor: pointer;
}
.cand {
  min-width: 0;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 7px;
  padding: 8px;
  border: 1px solid rgba(148, 163, 184, 0.11);
  border-radius: 10px 6px 11px 7px;
  background: rgba(255, 255, 255, 0.035);
  cursor: pointer;
  transition: 0.18s ease;
  &.conflict {
    border-color: rgba(251, 113, 133, 0.22);
    background: rgba(127, 29, 29, 0.1);
  }
  &.selected {
    border-color: rgba(103, 232, 249, 0.45);
    background: linear-gradient(145deg, rgba(8, 145, 178, 0.15), rgba(124, 58, 237, 0.09));
    box-shadow:
      0 0 14px rgba(103, 232, 249, 0.08),
      inset 0 0 0 1px rgba(103, 232, 249, 0.05);
  }
  &:hover {
    transform: translateY(-1px);
    border-color: rgba(103, 232, 249, 0.4);
  }
}
.cargo-toggle {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 7px 4px 7px 4px;
  color: #06151b;
}
.cargo-toggle span {
  font-size: 10px;
  font-weight: 900;
}
.cargo-toggle.on {
  border-color: #67e8f9;
  background: #67e8f9;
  box-shadow: 0 0 10px rgba(103, 232, 249, 0.48);
}
.cargo-main {
  min-width: 0;
}
.cargo-title {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.cand-name {
  font-weight: 700;
  font-size: 13px;
  color: #f1f5f9;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  margin-left: 6px;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(251, 113, 133, 0.16);
  color: #fda4af;
  &.overwrite {
    background: rgba(250, 204, 21, 0.14);
    color: #fde047;
  }
}
.cand-meta {
  margin: 4px 0 0;
  .meta-row {
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: #94a3b8;
    word-break: break-all;
    & + .meta-row {
      margin-top: 1px;
    }
    .k {
      font-weight: 600;
      color: #64748b;
    }
  }
  .clamp {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
}
.ghost-btn {
  padding: 6px 14px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  color: #cbd5e1;
  font-size: 12px;
  cursor: pointer;
  &:hover {
    background: rgba(255, 255, 255, 0.1);
  }
}
.primary-btn {
  margin-left: 8px;
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  background: linear-gradient(135deg, #67e8f9, #818cf8);
  color: #07111e;
  font-weight: 800;
  font-size: 12px;
  cursor: pointer;
  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}
.cargo-review {
  min-height: 328px;
}
.review-kicker {
  color: #c9ff43;
  text-shadow: 0 0 9px rgba(201, 255, 67, 0.38);
}
.review-count b {
  color: #ff7fc7;
  text-shadow: 2px 2px 0 rgba(46, 242, 255, 0.28);
}
.source-meta code {
  color: #dffcff;
}
.candidate-tools :deep(.el-input__wrapper) {
  background: rgba(5, 9, 20, 0.76);
  box-shadow: 0 0 0 1px rgba(46, 242, 255, 0.15) inset;
}
.candidate-tools button {
  border-color: rgba(255, 60, 172, 0.22);
  background: rgba(255, 60, 172, 0.06);
  color: #ffaddb;
}
.manifest-summary i {
  background: #ff8a00;
}
.cand-list {
  max-height: 254px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  padding: 8px;
  scrollbar-color: rgba(46, 242, 255, 0.35) transparent;
}
.cand {
  position: relative;
  min-height: 142px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 7px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 9px;
  background: linear-gradient(155deg, rgba(255, 255, 255, 0.055), rgba(8, 13, 25, 0.94));
  box-shadow: 0 9px 16px rgba(0, 0, 0, 0.24);
  transform-style: preserve-3d;
  overflow: hidden;
}
.cand::after {
  content: '';
  position: absolute;
  inset: 4px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 6px;
  pointer-events: none;
}
.cand.conflict {
  border-color: rgba(255, 138, 0, 0.42);
  background: linear-gradient(155deg, rgba(255, 138, 0, 0.09), rgba(21, 13, 12, 0.94));
}
.cand.selected {
  border-color: #2ef2ff;
  background: linear-gradient(
    155deg,
    rgba(46, 242, 255, 0.13),
    rgba(255, 60, 172, 0.07),
    rgba(8, 13, 25, 0.94)
  );
  box-shadow:
    0 0 0 2px rgba(201, 255, 67, 0.34),
    0 12px 22px rgba(0, 0, 0, 0.3);
  transform: translateY(-3px) rotateY(-2deg);
}
.cand:hover {
  transform: translateY(-3px) rotate(1deg);
  border-color: #ff7fc7;
}
.cand.selected:hover {
  transform: translateY(-4px) rotateY(-2deg);
}
.card-foil {
  position: relative;
  min-height: 38px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 7px;
  border-radius: 6px;
  background: linear-gradient(
    120deg,
    hsl(var(--hue), 88%, 55%),
    #ff3cac 42%,
    #14233d 43% 68%,
    #2ef2ff
  );
  overflow: hidden;
}
.card-foil::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    105deg,
    transparent 18%,
    rgba(255, 255, 255, 0.55) 36%,
    transparent 52%
  );
  transform: translateX(-120%);
  transition: 0.45s ease;
}
.cand.selected .card-foil::after {
  transform: translateX(115%);
}
.card-foil span {
  position: relative;
  z-index: 1;
  font:
    1000 6px/1 ui-monospace,
    monospace;
  letter-spacing: 0.12em;
  color: #09101c;
  background: #c9ff43;
  padding: 3px 4px;
}
.conflict .card-foil span {
  background: #ffb044;
}
.card-foil i {
  position: relative;
  z-index: 1;
  color: #fff;
  font-size: 16px;
  text-shadow: 0 0 9px currentColor;
}
.cargo-main {
  position: relative;
  z-index: 1;
  min-width: 0;
  flex: 1;
}
.cargo-title {
  align-items: flex-start;
  flex-wrap: wrap;
}
.cand-name {
  width: 100%;
  font-size: 12px;
  line-height: 1.15;
  color: #fff;
}
.badge {
  margin-left: 0;
  font-size: 7px;
  padding: 2px 5px;
  border-radius: 4px;
}
.cand-meta {
  margin-top: 3px;
}
.cand-meta .meta-row {
  font-size: 9px;
  line-height: 1.35;
}
.cand-meta .clamp {
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.card-foot {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding-top: 5px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}
.card-foot > span {
  font:
    900 6px/1 ui-monospace,
    monospace;
  letter-spacing: 0.12em;
  color: #69758b;
}
.cargo-toggle {
  width: auto;
  height: 18px;
  padding: 0 5px;
  display: flex;
  align-items: center;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 5px;
  color: #8d98ad;
}
.cargo-toggle i {
  font: 800 7px/1 system-ui;
  font-style: normal;
}
.cargo-toggle.on {
  border-color: #c9ff43;
  background: #c9ff43;
  color: #071018;
  box-shadow: 0 0 10px rgba(201, 255, 67, 0.32);
}
.primary-btn {
  border-radius: 8px;
  background: linear-gradient(105deg, #ff8a00, #ff3cac 40%, #2ef2ff 76%, #c9ff43);
  color: #071018;
  font-weight: 900;
  box-shadow: 3px 3px 0 rgba(255, 255, 255, 0.1);
}
.candidate-pages button {
  border-color: rgba(46, 242, 255, 0.2);
  color: #8cf8ff;
}
.review-actions {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-top: 8px;
}
.action-spacer {
  flex: 1;
}
.cargo-enter-active {
  animation: cargo-in 0.34s cubic-bezier(0.2, 0.8, 0.25, 1.08) both;
  animation-delay: var(--delay);
}
.cargo-leave-active {
  position: absolute;
  opacity: 0;
}
.cargo-move {
  transition: transform 0.25s ease;
}
@keyframes cargo-in {
  from {
    opacity: 0;
    transform: translateY(18px) rotateY(28deg) scale(0.9);
  }
}
@media (max-width: 680px) {
  .cand-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .candidate-tools button {
    display: none;
  }
}
@media (max-width: 470px) {
  .cand-list {
    grid-template-columns: 1fr;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cand,
  .card-foil::after,
  .cargo-enter-active {
    animation: none !important;
    transition: none !important;
    transform: none !important;
  }
}
</style>
