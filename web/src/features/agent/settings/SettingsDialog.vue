<script setup lang="ts">
/**
 * SettingsDialog：后端 config 设置面板外壳（居中 tab 弹窗）。
 * 触发：agents.settingsOpen（AgentFab ⚙️ 入口）。
 * 打开 -> config.get 读 .chery/config.yaml 原文（除 server 段）-> 深拷贝为 draft 编辑。
 * 保存 -> config.save 校验 + 写回（保留 server 段、无注释），重启生效；失败 error 红框列出。
 *
 * 外壳只管 overlay / tab 切换 / draft 加载保存；各 tab 内容拆到 ./tabs/，删除二次确认见 ConfirmPopover。
 *
 * ⚠ 入场动画只用 opacity + y（无 scale）：scale 会让 panel 视觉上 < 720px，
 *    若 RPC 在 180ms 内 resolve，content 切换会被叠在 scale 动画里导致宽高抖动。
 */
import { computed, ref, watch } from "vue";
import { AnimatePresence, motion } from "motion-v";
import { Close, FolderOpened } from "@element-plus/icons-vue";
import { useAgentsStore, useConnectionStore } from "@/stores";
import { agentApi, type ConfigDto, type SenseToolInfo } from "@/services/agentApi";
import { wsClient } from "@/services/ws";
import { TABS, HINT_LINES, INDEX_COUNT, type TabKey } from "./constants";
import BrainsTab from "./tabs/BrainsTab.vue";
import MediaTab from "./tabs/MediaTab.vue";
import SensesTab from "./tabs/SensesTab.vue";
import RolesTab from "./tabs/RolesTab.vue";
import PresetsTab from "./tabs/PresetsTab.vue";
import McpTab from "./tabs/McpTab.vue";
import GlobalTab from "./tabs/GlobalTab.vue";
import SkeletonTab from "./tabs/SkeletonTab.vue";

const MotionDiv = motion.div;
const agents = useAgentsStore();
const connection = useConnectionStore();

const draft = ref<ConfigDto | null>(null);
const activeTab = ref<TabKey>("presets");
/** 当前 tab 的 hints 段落拆分（sect + warn），渲染与真实 hints 像素级一致。 */
const hintLines = computed(() => HINT_LINES[activeTab.value] ?? { sect: 1, warn: 0 });
/** 当前 tab 序号按钮典型数（SkeletonTab 用，让 .shell-sticky 高度与真实 tab 一致）。 */
const indexCount = computed(() => INDEX_COUNT[activeTab.value] ?? 4);
const loading = ref(false);
const saving = ref(false);
const openingConfigDir = ref(false);
const error = ref<string | null>(null);
const savedHint = ref<string | null>(null);

/** sense.tools 返回的内置工具清单（缓存，SensesTab 下拉建议 + label/description 显示用）。失败置 []。 */
const senseTools = ref<SenseToolInfo[]>([]);

/** prompts.list 返回的 .chery/prompts/ 下 .md 路径清单（RolesTab/PresetsTab systemPrompt 级联选择器用）。每次打开重新拉。 */
const prompts = ref<string[]>([]);

/** env.list 返回的 .env 变量名列表（BrainsTab/MediaTab 密钥下拉选项）。每次打开重新拉。 */
const envVars = ref<string[]>([]);

watch(
  () => agents.settingsOpen,
  async (open) => {
    if (!open) {
      draft.value = null;
      error.value = null;
      savedHint.value = null;
      activeTab.value = "presets";
      return;
    }
    loading.value = true;
    error.value = null;
    savedHint.value = null;
    try {
      const data = await agentApi.getConfig();
      draft.value = structuredClone(data);
    } catch (e) {
      error.value = (e as Error).message;
      console.error("[SettingsDialog] getConfig failed:", e);
    } finally {
      loading.value = false;
    }
    // 工具列表静态缓存：失败不阻塞编辑（下拉仍可自由输入）
    if (!senseTools.value.length) {
      try {
        senseTools.value = await agentApi.listSenseTools();
      } catch (e) {
        console.error("[SettingsDialog] listSenseTools failed:", e);
        senseTools.value = [];
      }
    }
    // prompts 列表：每次打开重新拉（磁盘文件可能变动），失败不阻塞编辑（级联框空选项 + placeholder）
    try {
      prompts.value = await agentApi.listPrompts();
    } catch (e) {
      console.error("[SettingsDialog] listPrompts failed:", e);
      prompts.value = [];
    }
    // env 变量列表：每次打开重新拉（.env 可能变动），失败不阻塞编辑（密钥下拉空选项）
    try {
      envVars.value = await agentApi.listEnvVars();
    } catch (e) {
      console.error("[SettingsDialog] listEnvVars failed:", e);
      envVars.value = [];
    }
  },
);

function close(): void {
  agents.settingsOpen = false;
}

/** 通过后端 RPC 打开后端主机的 .chery 配置目录。 */
async function openConfigDir(): Promise<void> {
  if (connection.status !== "connected" || openingConfigDir.value) return;
  openingConfigDir.value = true;
  error.value = null;
  try {
    await agentApi.openConfigDir();
  } catch (e) {
    error.value = (e as Error).message;
    console.error("[SettingsDialog] openConfigDir failed:", e);
  } finally {
    openingConfigDir.value = false;
  }
}

function onError(msg: string): void {
  error.value = msg || null;
}

async function save(): Promise<void> {
  if (!draft.value || saving.value) return;
  saving.value = true;
  error.value = null;
  savedHint.value = null;
  try {
    sanitizeSenseGroups(draft.value);
    // 在 worker 关闭前登记等待者，避免它已开始重启时漏掉这一次重连。
    const reconnectWatcher = wsClient.watchNextReconnect();
    const result = await agentApi.saveConfig(draft.value);
    if (result.restart === "immediate") {
      savedHint.value = "服务正在更新…";
      void reconnectWatcher.promise.then(() => {
        savedHint.value = "✓ 已保存，服务已更新";
      });
    } else if (result.restart === "scheduled") {
      reconnectWatcher.cancel();
      savedHint.value = "✓ 已保存，将在当前任务完成后自动重启";
    } else {
      reconnectWatcher.cancel();
      savedHint.value = "✓ 已保存，需重启后端生效";
    }
  } catch (e) {
    error.value = (e as Error).message;
    console.error("[SettingsDialog] saveConfig failed:", e);
  } finally {
    saving.value = false;
  }
}

/** 保存前清理：丢弃组内空工具名条目（与旧 textarea filter(Boolean) 行为一致）。 */
function sanitizeSenseGroups(cfg: ConfigDto): void {
  if (!cfg.sense_groups) return;
  for (const arr of Object.values(cfg.sense_groups)) {
    const cleaned = arr.filter((e) => {
      const idx = e.indexOf(":");
      const name = idx >= 0 ? e.slice(0, idx) : e;
      return name.trim() !== "";
    });
    arr.length = 0;
    arr.push(...cleaned);
  }
}

</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="agents.settingsOpen"
      key="overlay"
      class="settings-overlay"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      :transition="{ duration: 0.16 }"
    >
      <MotionDiv
        key="panel"
        class="settings-panel"
        :initial="{ opacity: 0 }"
        :animate="{ opacity: 1 }"
        :exit="{ opacity: 0 }"
        :transition="{ duration: 0.18, ease: 'easeOut' }"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
      >
        <header class="head">
          <div class="title-row">
            <span class="title">设置</span>
            <el-tooltip content="打开配置文件夹" placement="top" :show-after="120">
              <span class="tooltip-trigger">
                <button
                  type="button"
                  class="icon-btn open-btn"
                  :disabled="connection.status !== 'connected' || openingConfigDir"
                  aria-label="打开配置文件夹"
                  @click="openConfigDir"
                >
                  <FolderOpened class="open-ico" />
                </button>
              </span>
            </el-tooltip>
          </div>
          <button type="button" class="close-btn" aria-label="关闭" @click="close">
            <Close class="close-ico" />
          </button>
        </header>

        <nav class="tab-bar">
          <button
            v-for="t in TABS"
            :key="t.key"
            type="button"
            class="tab"
            :class="{ active: activeTab === t.key }"
            @click="activeTab = t.key"
          >
            <span class="tab-icon">{{ t.icon }}</span>
            <span class="tab-label">{{ t.label }}</span>
          </button>
        </nav>

        <div class="tab-body">
          <SkeletonTab
            v-if="loading"
            :sect-hints="hintLines.sect"
            :warn-hints="hintLines.warn"
            :index-count="indexCount"
          />
          <template v-else-if="draft">
            <BrainsTab v-show="activeTab === 'brains'" :draft="draft" :env-vars="envVars" @error="onError" />
            <MediaTab v-show="activeTab === 'media'" :draft="draft" :env-vars="envVars" @error="onError" />
            <SensesTab
              v-show="activeTab === 'senses'"
              :draft="draft"
              :sense-tools="senseTools"
              @error="onError"
            />
            <RolesTab v-show="activeTab === 'roles'" :draft="draft" :prompts="prompts" @error="onError" />
            <PresetsTab v-show="activeTab === 'presets'" :draft="draft" :sense-tools="senseTools" @error="onError" />
            <McpTab v-show="activeTab === 'mcp'" :draft="draft" @error="onError" />
            <GlobalTab v-show="activeTab === 'global'" :draft="draft" />
          </template>
        </div>

        <div v-if="error" class="error-row" role="alert">{{ error }}</div>
        <div v-if="savedHint" class="saved-row" role="status">{{ savedHint }}</div>

        <footer class="foot">
          <div class="foot-right">
            <button type="button" class="ghost-btn" @click="close">关闭</button>
            <button type="button" class="primary-btn" :disabled="!draft || saving" @click="save">
              {{ saving ? "保存中…" : "保存" }}
            </button>
          </div>
        </footer>
      </MotionDiv>
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
@import "./shared.less";

.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 310;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(15, 17, 22, 0.42);
  backdrop-filter: blur(2px);
}

.settings-panel {
  width: min(720px, 96vw);
  height: min(680px, 88vh);
  padding: 14px 16px 12px;
  border-radius: 12px;
  background: #fbf9f4;
  box-shadow:
    0 18px 36px rgba(0, 0, 0, 0.28),
    0 4px 8px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  .title-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .title {
    font-size: 15px;
    font-weight: 800;
    color: fade(@ink, 88%);
  }
  .tooltip-trigger {
    display: inline-flex;
  }
  .open-btn {
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid rgba(36, 38, 45, 0.16);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.7);
    color: fade(@ink, 70%);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    &:hover:not(:disabled) {
      background: #ffffff;
      color: fade(@ink, 88%);
    }
    &:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
  }
  .open-ico {
    width: 14px;
    height: 14px;
  }
}

.close-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.7);
  color: fade(@ink, 70%);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  &:hover {
    background: #ffffff;
    color: fade(@ink, 88%);
  }
}
.close-ico {
  width: 12px;
  height: 12px;
}

.tab-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(36, 38, 45, 0.12);
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: fade(@ink, 60%);
  font-size: 12px;
  cursor: pointer;
  &:hover {
    background: rgba(246, 183, 60, 0.1);
  }
  &.active {
    background: rgba(246, 183, 60, 0.18);
    color: fade(@ink, 90%);
    font-weight: 700;
  }
  .tab-icon {
    font-size: 13px;
  }
}

.tab-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  // 滚动交给各 tab 内部的 TabShell.shell-scroll；本层只做容器。
}

.error-row {
  padding: 6px 8px;
  border-radius: 6px;
  background: #fee2e2;
  color: #991b1b;
  font-size: 11px;
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;
}

.saved-row {
  padding: 6px 8px;
  border-radius: 6px;
  background: #dcfce7;
  color: #166534;
  font-size: 11px;
}

.foot {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid rgba(36, 38, 45, 0.1);
}

.foot-right {
  display: flex;
  gap: 8px;
}

.ghost-btn {
  padding: 6px 12px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.7);
  color: fade(@ink, 80%);
  font-size: 12px;
  cursor: pointer;
  &:hover:not(:disabled) {
    background: #ffffff;
    color: fade(@ink, 92%);
  }
  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.primary-btn {
  padding: 6px 18px;
  border: none;
  border-radius: 6px;
  background: linear-gradient(135deg, #ffd27a, #f6b73c);
  color: #3b2b12;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}
</style>
