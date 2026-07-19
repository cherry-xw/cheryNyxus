<script setup lang="ts">
/**
 * PluginsTab：插件管理面板。
 * 插件 = 来自 Git 仓库的扩展包（整仓），存于 .chery/plugins/<name>/。
 * 版本检查 + 拉取最新。导入操作移入 PluginImportDialog 弹窗。
 */
import { ref, computed, onMounted, watch } from "vue";
import { Delete, Refresh, Search } from "@element-plus/icons-vue";
import {
  agentApi,
  type PluginInfo,
} from "@/services/agentApi";
import TabShell, { type IndexItem } from "../components/TabShell.vue";
import ConfirmDialog from "../ConfirmDialog.vue";
import PluginImportDialog from "./components/PluginImportDialog.vue";

const props = defineProps<{ plugins: PluginInfo[] }>();
const emit = defineEmits<{ (e: "error", msg: string): void; (e: "refresh-plugins"): void }>();

// 卸载插件二次确认（重删 → ConfirmDialog 居中 modal）。
// 注：PluginsTab 只持有 plugins 列表，无 draft.roles 数据，故 impact 不含"引用角色"段。
const removeDialog = ref(false);
const removePluginInfo = ref<PluginInfo | undefined>(undefined);
const removeImpact = computed(() => {
  const p = removePluginInfo.value;
  if (!p) return [] as string[];
  return [
    `插件「${p.name}」及其 ${p.skills.length} 个技能将被移除。`,
  ];
});
function startUninstall(p: PluginInfo): void {
  removePluginInfo.value = p;
  removeDialog.value = true;
}

// ── 导入弹窗 ──────────────────────────────────────────────────────
const importDialogOpen = ref(false);
const search = ref("");
const page = ref(1);
const pageSize = 24;
const filteredPlugins = computed(() => {
  const q = search.value.trim().toLowerCase();
  return props.plugins.filter((plugin) => !q || `${plugin.name} ${plugin.sourceUrl} ${plugin.branch}`.toLowerCase().includes(q));
});
const pagedPlugins = computed(() => filteredPlugins.value.slice((page.value - 1) * pageSize, page.value * pageSize));
watch(filteredPlugins, (list) => {
  const maxPage = Math.max(1, Math.ceil(list.length / pageSize));
  if (page.value > maxPage) page.value = maxPage;
});

// ── 预览 / 检查更新 ─────────────────────────────────────────────
const checkingAll = ref(false);
const checkSummary = ref<string>("");
const checkErrors = ref<Record<string, string>>({});
const pullLog = ref<Record<string, string>>({});
const updatingName = ref<string>("");

function onError(msg: string): void {
  emit("error", msg);
}
function emitError(err: unknown): void {
  const e = err as { message?: string };
  onError(e?.message ?? String(err));
}
function refresh(): void {
  emit("refresh-plugins");
}

const indexItems = computed<IndexItem[]>(() =>
  pagedPlugins.value.map((p) => ({ label: p.name, anchor: p.name, description: p.branch ? `分支 ${p.branch}` : "无分支记录" })),
);

const lastCheckTime = computed<string | undefined>(() => {
  let max = "";
  for (const p of props.plugins) {
    if (p.lastCheckedAt && p.lastCheckedAt > max) max = p.lastCheckedAt;
  }
  return max || undefined;
});

async function onCheckAll(): Promise<void> {
  if (checkingAll.value) return;
  checkingAll.value = true;
  try {
    const res = await agentApi.checkAllPluginsUpdate();
    if (res.checked === 0) {
      checkSummary.value = "无已安装插件";
    } else {
      const parts: string[] = [`已检查 ${res.checked}`];
      if (res.updatesAvailable) parts.push(`${res.updatesAvailable} 个有更新`);
      if (res.failed.length) parts.push(`${res.failed.length} 个失败`);
      checkSummary.value = parts.join("，");
    }
    const errs: Record<string, string> = {};
    for (const f of res.failed) errs[f.name] = f.reason;
    checkErrors.value = errs;
    refresh();
  } catch (err) {
    emitError(err);
  } finally {
    checkingAll.value = false;
  }
}

async function onUpdate(name: string): Promise<void> {
  if (updatingName.value) return;
  updatingName.value = name;
  try {
    const res = await agentApi.updatePlugin(name);
    pullLog.value = { ...pullLog.value, [name]: `✓ 更新成功 → ${shortSha(res.plugin.commitSha)}` };
    refresh();
  } catch (err) {
    const e = err as { message?: string };
    pullLog.value = { ...pullLog.value, [name]: `✗ 更新失败：${e?.message ?? String(err)}` };
  } finally {
    updatingName.value = "";
  }
}
function onCardClick(p: PluginInfo): void {
  if (!p.updateAvailable) return;
  if (updatingName.value) return;
  if (checkingAll.value) return;
  void onUpdate(p.name);
}
async function onUninstall(name: string): Promise<void> {
  try {
    await agentApi.uninstallPlugin(name);
    const next = { ...pullLog.value };
    delete next[name];
    pullLog.value = next;
    refresh();
  } catch (err) {
    emitError(err);
  }
}

function shortSha(sha: string | undefined): string {
  return sha && sha.length >= 7 ? sha.slice(0, 7) : (sha || "—");
}
function formatDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  return iso.slice(0, 16).replace("T", " ");
}
function skillLabel(name: string, plugin: string): string {
  const prefix = `${plugin}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

const TAG_PALETTE: Array<{ background: string; color: string }> = [
  { background: "rgba(99,102,241,0.14)", color: "#4338ca" },
  { background: "rgba(2,132,199,0.14)", color: "#075985" },
  { background: "rgba(22,163,74,0.14)", color: "#166534" },
  { background: "rgba(225,29,72,0.14)", color: "#9f1239" },
  { background: "rgba(124,58,237,0.14)", color: "#5b21b6" },
  { background: "rgba(217,119,6,0.14)", color: "#b45309" },
];
function skillTagStyle(i: number): { background: string; color: string } {
  return TAG_PALETTE[i % TAG_PALETTE.length]!;
}
</script>

<template>
  <TabShell tab-key="plugins" :index-items="indexItems" :page="page" :page-size="pageSize" :total="filteredPlugins.length" @page-change="page = $event">
    <template #hints>
      <p class="sect-hint">
        插件是来自 Git 仓库的扩展包。填入 GitHub URL → 拉取分支 → 选择后导入；版本与更新信息自动跟踪。
      </p>
    </template>
    <template #popper="{ item }">
      <div class="index-card">
        <div class="index-card-title">{{ item.label as string }}</div>
        <div class="index-card-line"><b>分支</b><span>{{ item.description as string }}</span></div>
      </div>
    </template>

    <template #toolbar>
      <div class="plugin-toolbar">
        <el-input v-model="search" clearable size="small" placeholder="搜索插件、仓库或分支" @input="page = 1"><template #prefix><Search class="ico" /></template></el-input>
        <el-tooltip :content="checkSummary || '对比全部插件远端 HEAD，结果写入各插件 manifest'" placement="top" :show-after="200">
          <span class="toolbar-trigger">
            <button type="button" class="ghost-btn check-btn" :disabled="checkingAll || !plugins.length" @click="onCheckAll">
              <Refresh class="ico" :class="{ spinning: checkingAll }" />
              {{ checkingAll ? "检查中…" : "检查更新" }}
            </button>
          </span>
        </el-tooltip>
        <span class="last-check">{{ filteredPlugins.length }} 个 · {{ formatDateTime(lastCheckTime) }}</span>
        <span class="spacer"></span>
        <button type="button" class="ghost-btn" @click="importDialogOpen = true">+ 导入插件</button>
      </div>
    </template>

    <article
      v-for="(p, i) in pagedPlugins"
      :key="p.name"
      class="card"
      :class="p.updateAvailable ? 'clickable' : ''"
      :data-anchor="p.name"
      @click="onCardClick(p)"
    >
      <span class="card-idx">{{ i + 1 }}</span>
      <header class="card-head">
        <span class="card-title">{{ p.name }}</span>
        <span class="spacer"></span>
        <el-tooltip
          v-if="p.updateAvailable || updatingName === p.name"
          :content="pullLog[p.name] || '有新版本，点击拉取最新覆盖本地'"
          placement="top"
          :show-after="120"
        >
          <span class="tooltip-trigger">
            <button
              type="button"
              class="icon-btn update-btn"
              aria-label="拉取最新"
              :disabled="!!updatingName"
              @click.stop="onUpdate(p.name)"
            >
              <Refresh class="ico" :class="{ spinning: updatingName === p.name }" />
            </button>
          </span>
        </el-tooltip>
        <button
          type="button"
          class="icon-btn danger"
          aria-label="卸载"
          :disabled="!!updatingName"
          @click.stop="startUninstall(p)"
        >
          <Delete class="ico" />
        </button>
      </header>

      <div class="plugin-meta">
        <span v-if="p.branch" class="badge branch">{{ p.branch }}</span>
        <span v-if="p.commitSha" class="meta-item">HEAD <code class="sha">{{ shortSha(p.commitSha) }}</code></span>
        <span v-if="p.commitDate" class="meta-item">{{ p.commitDate.slice(0, 10) }}</span>
        <span v-if="p.updateAvailable" class="badge warn">有更新</span>
        <span v-else-if="p.lastCheckedAt" class="badge ok">最新</span>
        <el-tooltip
          v-if="checkErrors[p.name] || p.lastCheckError"
          :content="checkErrors[p.name] || p.lastCheckError || ''"
          placement="top"
          :show-after="200"
        >
          <span class="badge fail">刷新失败</span>
        </el-tooltip>
        <span v-if="p.lastCheckedAt" class="meta-item">检查于 {{ formatDateTime(p.lastCheckedAt) }}</span>
      </div>

      <div class="plugin-tokens">
        <el-tooltip placement="top" :show-after="200">
          <template #content>全部技能的系统提示词消耗合计（name+description+trigger）</template>
          <span class="badge tok-system">系统 ≈{{ p.totalSystemTokens }}</span>
        </el-tooltip>
        <el-tooltip placement="top" :show-after="200">
          <template #content>所含技能的正文 token 区间（激活后单技能正文消耗）</template>
          <span class="badge tok-content">内容 <template v-if="p.minContentTokens === p.maxContentTokens">{{ p.minContentTokens }}</template><template v-else>{{ p.minContentTokens }}–{{ p.maxContentTokens }}</template></span>
        </el-tooltip>
      </div>

      <p v-if="p.sourceUrl" class="plugin-src">
        <code>{{ p.sourceUrl }}</code>
      </p>

      <div v-if="p.skills.length" class="skill-tags">
        <el-tooltip
          v-for="(s, si) in p.skills"
          :key="s.name"
          placement="top"
          :show-after="200"
        >
          <template #content>
            <div style="max-width: 220px">
              <b>{{ skillLabel(s.name, p.name) }}</b><br />
              {{ s.description || '无描述' }}<br />
              <span style="opacity:.8">系统 ≈ {{ s.nameDescTokens + (s.triggerTokens ?? 0) }} tok · 内容 ≈ {{ s.contentTokens }} tok</span>
            </div>
          </template>
          <span class="skill-tag" :style="skillTagStyle(si)">{{ skillLabel(s.name, p.name) }}</span>
        </el-tooltip>
      </div>
    </article>

    <article v-if="!plugins.length" class="card empty-card">
      <span class="card-idx">·</span>
      <header class="card-head"><span class="empty-title">没有插件</span></header>
      <p class="empty-hint">通过 GitHub URL 导入插件（如 <code>obra/superpowers</code>）。</p>
    </article>

    <!-- 导入弹窗 -->
    <PluginImportDialog
      v-model:visible="importDialogOpen"
      @imported="refresh"
      @error="onError"
    />

    <!-- 卸载插件二次确认（重删 modal） -->
    <ConfirmDialog
      v-model="removeDialog"
      icon="🗑️"
      :title="`卸载插件「${removePluginInfo?.name ?? ''}」？`"
      :impact="removeImpact"
      tab-color="#a855f7"
      @confirm="onUninstall(removePluginInfo!.name)"
    />
  </TabShell>
</template>

<style scoped lang="less">
@import "../shared.less";

code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(36, 38, 45, 0.08);
}
.sha {
  background: transparent;
  padding: 0;
}
.tooltip-trigger,
.toolbar-trigger {
  display: inline-flex;
}
.plugin-toolbar {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0;
  :deep(.el-input) { width:220px; }
  .check-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .last-check {
    font-size: 11px;
    color: fade(@ink, 55%);
  }
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.spacer {
  flex: 1;
}
.card-title {
  font-size: 14px;
  font-weight: 800;
  color: fade(@ink, 88%);
}
.badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(36, 38, 45, 0.08);
  color: fade(@ink, 65%);
  &.branch {
    background: rgba(190, 132, 28, 0.14);
    color: #80560a;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  }
  &.ok {
    background: rgba(22, 101, 52, 0.14);
    color: #166534;
  }
  &.warn {
    background: rgba(185, 28, 28, 0.14);
    color: #b91c1c;
  }
}
.plugin-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 11px;
  color: fade(@ink, 60%);
  .meta-item {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
}
.plugin-src {
  margin: 4px 0 0;
  font-size: 11px;
  color: fade(@ink, 55%);
}
.plugin-tokens {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.plugin-tokens .badge.tok-system {
  background: rgba(99, 102, 241, 0.14);
  color: #4338ca;
}
.plugin-tokens .badge.tok-content {
  background: rgba(22, 163, 74, 0.14);
  color: #166534;
}
.update-btn {
  color: @accent;
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
  cursor: default;
}
.skill-tag.more { background:rgba(36,38,45,.08)!important;color:fade(@ink,55%)!important; }
.empty-card {
  text-align: center;
  .empty-title {
    font-size: 14px;
    font-weight: 800;
    color: fade(@ink, 80%);
  }
  .empty-hint {
    margin-top: 6px;
    font-size: 11px;
    color: fade(@ink, 60%);
  }
}
.ghost-btn {
  padding: 5px 10px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.7);
  color: fade(@ink, 80%);
  font-size: 11px;
  cursor: pointer;
  height: 24px;
  &:hover:not(:disabled) {
    background: #ffffff;
    color: fade(@ink, 92%);
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
.spinning {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
