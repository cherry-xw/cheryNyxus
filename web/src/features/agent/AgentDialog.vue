<script setup lang="ts">
/**
 * AgentDialog：发消息弹窗（runtime 切换合一）。
 * 触发：agents.activeDialogChatId 非空（点主 pet 设置）。
 * 内容：brain 单选 + senseGroup 单选 + mcpServers 多选下拉（三选项并排一行）+ 多行输入（auto-grow）+ 发送 icon。
 * 发送逻辑（diff runtime）：委托 agents.sendMessage(chatId, text, runtime)，
 *   store 内判定与当前 runtime 是否一致 → 同则直发，异则先 runtime.set 再发。
 * 关闭：发送成功后清 activeDialogChatId；主 pet 进 isWorking（store 内 setWorking）。
 * 错误显性化（规则 12）：error ref + console.error，禁静默吞。
 *
 * senseGroups 列表来源：/api/config 的 senseGroups 字段（{name, default}[]，fetchServerConfig 缓存复用 default）。
 *   default 标记 = 是否在 config.default.senseGroups 内（无 runtime 时预选默认项）。
 * 兜底：未暴露/拉取失败 → [{name:"default", default:true}] + console.warn。
 */
import { computed, ref, watch } from "vue";
import { AnimatePresence, motion } from "motion-v";
import { useAgentsStore } from "@/stores";
import {
  agentApi,
  fetchServerConfig,
  type BrainInfo,
  type ConfigDefault,
  type RuntimeSelection,
  type SenseGroupOption,
} from "@/services/agentApi";
import type { PetInstance } from "@/features/pets/types";

const MotionDiv = motion.div;

const agents = useAgentsStore();

// /api/config 未暴露 senseGroups 或拉取失败时的兜底（plan §9 CP3 决策）
const SENSE_GROUPS_FALLBACK = [{ name: "default", default: true }] as const;

const chatId = computed<string | null>(() => agents.activeDialogChatId);
const pet = computed<PetInstance | undefined>(() =>
  chatId.value ? agents.pets.find((p) => p.chatId === chatId.value) : undefined,
);

const brains = ref<BrainInfo[]>([]);
const mcpServers = ref<string[]>([]);
const senseGroups = ref<readonly SenseGroupOption[]>(SENSE_GROUPS_FALLBACK);

const selectedBrain = ref<string>("");
const selectedSenseGroup = ref<string>("");
const selectedMcpServers = ref<string[]>([]);
const text = ref("");
const sending = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);
const loaded = ref(false);

async function loadOptions(): Promise<void> {
  if (loaded.value || !chatId.value) return;
  loading.value = true;
  error.value = null;
  try {
    const data = await agentApi.listBrains();
    brains.value = data.brains;
    mcpServers.value = data.mcpServers;
    // senseGroups 从 /api/config 拉取（fetchServerConfig 与 default 共享缓存）
    // 拉取失败不阻塞弹窗（senseGroups 缺失降级为兜底，brain/mcp 仍可用）
    let serverCfg: ConfigDefault | null = null;
    try {
      serverCfg = await fetchServerConfig();
    } catch (e) {
      console.warn("[AgentDialog] /api/config 拉取失败，senseGroups 回退默认:", e);
    }
    if (serverCfg?.senseGroups && serverCfg.senseGroups.length > 0) {
      senseGroups.value = serverCfg.senseGroups;
    } else {
      senseGroups.value = SENSE_GROUPS_FALLBACK;
      console.warn("[AgentDialog] /api/config 未暴露 senseGroups，回退默认", serverCfg);
    }
    // 按 pet 当前 runtime 初始化选择（首次 = createMasterPet default）。
    // 无 runtime（重建场景：initFromChats 不恢复 runtime）→ 用 config.default 关联：
    //   brain 取 brains[].default 标记；senseGroups 取 senseGroups[].default 标记；mcpServers 取 default.mcpServers。
    const cur = agents.getRuntime(chatId.value);
    if (cur) {
      selectedBrain.value = cur.brain;
      // senseGroup 单选：runtime.senseGroups 取首项（后端为数组，UI 单选包装为单元素）
      selectedSenseGroup.value = cur.senseGroups[0] ?? "";
      selectedMcpServers.value = [...(cur.mcpServers ?? [])];
    } else {
      selectedBrain.value = brains.value.find((b) => b.default)?.name ?? brains.value[0]?.name ?? "";
      // 无 runtime → 预选首个 default senseGroup（无 default 取首项）
      selectedSenseGroup.value =
        senseGroups.value.find((g) => g.default)?.name ?? senseGroups.value[0]?.name ?? "";
      selectedMcpServers.value = [...(serverCfg?.default?.mcpServers ?? [])];
    }
    // brain 不在列表 → 仍保留为可选项（避免后端 list 滞后丢配置）
    if (selectedBrain.value && !brains.value.some((b) => b.name === selectedBrain.value)) {
      brains.value = [{ name: selectedBrain.value, contextLimit: 0 }, ...brains.value];
    }
    loaded.value = true;
  } catch (e) {
    error.value = (e as Error).message;
    console.error("[AgentDialog] loadOptions failed:", e);
  } finally {
    loading.value = false;
  }
}

// 弹窗打开：重置状态 + 拉选项；关闭：清文本/错误
watch(
  chatId,
  (v) => {
    if (v) {
      text.value = "";
      error.value = null;
      loaded.value = false;
      void loadOptions();
    }
  },
  { immediate: true },
);

function currentSelection(): RuntimeSelection {
  return {
    brain: selectedBrain.value,
    // 单选包装为单元素数组（后端 RuntimeSelection.senseGroups 为非空数组）
    senseGroups: selectedSenseGroup.value ? [selectedSenseGroup.value] : [],
    mcpServers: [...selectedMcpServers.value],
  };
}

function close(): void {
  agents.activeDialogChatId = null;
}

async function handleSend(): Promise<void> {
  if (!chatId.value || !text.value.trim() || sending.value) return;
  sending.value = true;
  error.value = null;
  try {
    await agents.sendMessage(chatId.value, text.value.trim(), currentSelection());
    text.value = "";
    close();
  } catch (e) {
    error.value = (e as Error).message;
    console.error("[AgentDialog] sendMessage failed:", e);
  } finally {
    sending.value = false;
  }
}

function onTextareaKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void handleSend();
  } else if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

function onOverlayClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) close();
}

const selectedBrainInfo = computed<BrainInfo | undefined>(() =>
  brains.value.find((b) => b.name === selectedBrain.value),
);
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="chatId"
      key="overlay"
      class="dialog-overlay"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      :transition="{ duration: 0.16 }"
      @pointerdown="onOverlayClick"
    >
      <MotionDiv
        key="panel"
        class="dialog-panel"
        :initial="{ opacity: 0, y: 16, scale: 0.96 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :exit="{ opacity: 0, y: 12, scale: 0.97 }"
        :transition="{ duration: 0.18, ease: 'easeOut' }"
        role="dialog"
        aria-modal="true"
        :aria-label="`Send message to ${pet?.name ?? 'agent'}`"
      >
        <header class="dialog-head">
          <span class="title">
            <span class="who">{{ pet?.name ?? "agent" }}</span>
            <span class="hint">Cmd/Ctrl+Enter 发送 · Esc 关闭</span>
          </span>
          <button type="button" class="close-btn" aria-label="Close" @click="close">✕</button>
        </header>

        <div v-if="loading" class="loading-row">加载配置…</div>

        <div v-else class="config-row">
          <label class="field">
            <span class="lbl">brain</span>
            <el-select v-model="selectedBrain">
              <el-option
                v-for="b in brains"
                :key="b.name"
                :label="b.contextLimit ? `${b.name} · ${b.contextLimit}` : b.name"
                :value="b.name"
              />
            </el-select>
          </label>

          <label class="field">
            <span class="lbl">senseGroup</span>
            <el-select v-model="selectedSenseGroup">
              <el-option v-for="g in senseGroups" :key="g.name" :label="g.name" :value="g.name" />
            </el-select>
          </label>

          <label class="field">
            <span class="lbl">mcpServers</span>
            <el-select
              v-model="selectedMcpServers"
              multiple
              collapse-tags
              collapse-tags-tooltip
              placeholder="未选"
            >
              <el-option v-for="m in mcpServers" :key="m" :label="m" :value="m" />
            </el-select>
          </label>
        </div>

        <div class="textarea-row">
          <el-input
            v-model="text"
            type="textarea"
            class="msg-input"
            :autosize="{ minRows: 6, maxRows: 24 }"
            placeholder="输入消息…"
            :disabled="sending"
            resize="none"
            @keydown="onTextareaKeydown"
          />
          <button
            type="button"
            class="send-btn"
            :disabled="!text.trim() || sending || loading || !selectedBrain || !selectedSenseGroup"
            aria-label="Send message"
            @click="handleSend"
          >
            <svg
              class="send-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </button>
        </div>

        <div v-if="selectedBrainInfo?.contextLimit" class="ctx-hint">
          context limit: {{ selectedBrainInfo.contextLimit }}
        </div>

        <div v-if="error" class="error-row" role="alert">{{ error }}</div>
      </MotionDiv>
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
@ink: #14161a;

.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(15, 17, 22, 0.42);
  backdrop-filter: blur(2px);
}

.dialog-panel {
  width: min(560px, 96vw);
  max-height: 88vh;
  padding: 14px 16px 12px;
  border-radius: 12px;
  background: #fbf9f4;
  box-shadow:
    0 18px 36px rgba(0, 0, 0, 0.28),
    0 4px 8px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: auto;
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;

  .title {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .who {
    font-size: 14px;
    font-weight: 800;
    color: fade(@ink, 86%);
  }

  .hint {
    font-size: 10px;
    color: fade(@ink, 52%);
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
  font-size: 12px;
  line-height: 1;
  cursor: pointer;

  &:hover {
    background: #ffffff;
    color: fade(@ink, 88%);
  }
}

.loading-row {
  padding: 8px;
  color: fade(@ink, 60%);
  font-size: 12px;
  text-align: center;
}

.config-row {
  display: flex;
  flex-direction: row;
  gap: 8px;
}

.field {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  margin: 0;
  border: none;
}

.lbl {
  font-size: 11px;
  font-weight: 700;
  color: fade(@ink, 64%);
  letter-spacing: 0.02em;
}

.textarea-row {
  position: relative;
  display: flex;
  align-items: flex-end;
}

.msg-input {
  flex: 1;

  // el-input textarea 内层留右内边距避让 send-btn 浮层；边框/聚焦交由 element 主题
  :deep(.el-textarea__inner) {
    padding-right: 44px;
    font-size: 13px;
    line-height: 1.5;
  }
}

.send-btn {
  position: absolute;
  right: 8px;
  bottom: 8px;
  width: 32px;
  height: 32px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: fade(@ink, 50%);
  border-radius: 6px;
  cursor: pointer;
  transition: color 120ms ease;

  &:hover:not(:disabled) {
    color: #f6b73c;
  }

  &:hover:not(:disabled) .send-icon {
    fill: currentColor;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
}

.send-icon {
  width: 18px;
  height: 18px;
  transition: fill 120ms ease;
}

.ctx-hint {
  font-size: 10px;
  color: fade(@ink, 48%);
  text-align: right;
}

.error-row {
  padding: 6px 8px;
  border-radius: 6px;
  background: #fee2e2;
  color: #991b1b;
  font-size: 11px;
  line-height: 1.4;
  word-break: break-word;
}
</style>
