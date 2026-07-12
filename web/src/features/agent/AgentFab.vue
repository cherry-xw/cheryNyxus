<script setup lang="ts">
/**
 * AgentFab：页面右下角常驻圆形按钮。
 * - 启动即显，按钮下方小字显连接状态（disconnected 灰 / connecting 黄 / connected 绿）
 * - 点击 → 有预设则弹预设选择器（选预设 → createMasterPet(preset)，含「默认」预设）；无预设兜底
 *   brain.list[0] + 空组（旧 config.default 已并入「默认」预设，零预设时无编制可用）
 * - 连接非 connected 时禁用（避免在断连下创建无意义 chat）
 * 创建失败显性化（规则 12）：error ref + console.error，不静默吞。
 */
import { computed, ref } from "vue";
import { useAgentsStore, useConnectionStore } from "@/stores";
import { agentApi } from "@/services/agentApi";
import PresetPicker from "./PresetPicker.vue";

const agents = useAgentsStore();
const conn = useConnectionStore();

const creating = ref(false);
const error = ref<string | null>(null);

const statusColor = computed(() => {
  switch (conn.status) {
    case "connected":
      return "#22c55e";
    case "connecting":
      return "#eab308";
    default:
      return "#9ca3af";
  }
});

const disabled = computed(() => creating.value || conn.status !== "connected");

async function pickPreset(name: string): Promise<void> {
  await runCreate({ preset: name });
}

/** 无预设兜底：brain.list[0] + 空感官组（旧 config.default 已并入「默认」预设，零预设时无编制可用） */
async function createFallback(): Promise<void> {
  let firstBrain = "longcat";
  try {
    const list = await agentApi.listBrains();
    firstBrain = list.brains[0]?.name ?? "longcat";
  } catch (e) {
    console.warn("[AgentFab] brain.list unavailable, fallback brain longcat:", (e as Error).message);
  }
  await runCreate({ brain: firstBrain, senseGroup: "", mcpServers: [] });
}

async function runCreate(opts: { preset?: string; brain?: string; senseGroup?: string; mcpServers?: string[] }): Promise<void> {
  creating.value = true;
  error.value = null;
  try {
    await agents.createMasterPet(opts);
  } catch (e) {
    error.value = (e as Error).message;
    console.error("[AgentFab] createMasterPet failed:", e);
  } finally {
    creating.value = false;
  }
}

/** CP8：打开历史会话列表（SessionList 抽屉 watch historyListOpen→true 时 fetchHistoryList）。 */
function openSessions(): void {
  if (conn.status !== "connected") return;
  agents.historyListOpen = true;
}
</script>

<template>
  <div class="agent-fab-wrap">
    <PresetPicker :disabled="disabled" @pick="pickPreset" @fallback="createFallback">
      <button
        type="button"
        class="agent-fab"
        :disabled="disabled"
        :aria-label="creating ? 'Creating master agent' : 'Create master agent'"
      >
        <span class="plus">{{ creating ? "…" : "+" }}</span>
      </button>
    </PresetPicker>
    <button
      type="button"
      class="session-fab"
      aria-label="历史会话"
      :disabled="conn.status !== 'connected'"
      @click="openSessions"
    >
      <span class="icon">☰</span>
    </button>
    <button
      type="button"
      class="session-fab settings-fab"
      aria-label="设置"
      :disabled="conn.status !== 'connected'"
      @click="agents.settingsOpen = true"
    >
      <span class="icon">⚙</span>
    </button>
    <div class="status-line" :style="{ color: statusColor }">
      <span class="dot" :style="{ background: statusColor }" />
      <span class="label">{{ conn.status }}</span>
    </div>
    <div v-if="error" class="fab-error" role="alert">{{ error }}</div>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;

.agent-fab-wrap {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: auto;
}

.agent-fab {
  width: 52px;
  height: 52px;
  padding: 0;
  border: 1px solid rgba(36, 38, 45, 0.2);
  border-radius: 50%;
  background: linear-gradient(135deg, #ffd27a, #f6b73c);
  color: #3b2b12;
  font-size: 28px;
  font-weight: 800;
  line-height: 1;
  cursor: pointer;
  box-shadow:
    0 6px 14px rgba(246, 183, 60, 0.42),
    0 2px 4px rgba(0, 0, 0, 0.18);
  transition:
    transform 120ms ease,
    box-shadow 120ms ease;

  &:hover:not(:disabled) {
    transform: translateY(-1px) scale(1.04);
    box-shadow:
      0 10px 18px rgba(246, 183, 60, 0.5),
      0 3px 6px rgba(0, 0, 0, 0.22);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .plus {
    display: inline-block;
    line-height: 1;
  }
}

.session-fab {
  width: 40px;
  height: 40px;
  padding: 0;
  border: 1px solid rgba(36, 38, 45, 0.2);
  border-radius: 50%;
  background: linear-gradient(135deg, #8dd0c8, #5fb3a8);
  color: #0f2a26;
  font-size: 20px;
  font-weight: 800;
  line-height: 1;
  cursor: pointer;
  box-shadow:
    0 4px 10px rgba(95, 179, 168, 0.4),
    0 2px 4px rgba(0, 0, 0, 0.16);
  transition:
    transform 120ms ease,
    box-shadow 120ms ease;

  &:hover:not(:disabled) {
    transform: translateY(-1px) scale(1.04);
    box-shadow:
      0 8px 14px rgba(95, 179, 168, 0.5),
      0 3px 6px rgba(0, 0, 0, 0.2);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .icon {
    display: inline-block;
    line-height: 1;
  }
}

.settings-fab {
  background: linear-gradient(135deg, #c4b5e0, #9b86d6);
  color: #2a1f4a;
  box-shadow:
    0 4px 10px rgba(155, 134, 214, 0.4),
    0 2px 4px rgba(0, 0, 0, 0.16);

  &:hover:not(:disabled) {
    box-shadow:
      0 8px 14px rgba(155, 134, 214, 0.5),
      0 3px 6px rgba(0, 0, 0, 0.2);
  }
}

.status-line {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: capitalize;
  user-select: none;

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
}

.fab-error {
  max-width: 200px;
  padding: 4px 8px;
  border-radius: 5px;
  background: fade(@ink, 88%);
  color: #ffd2d2;
  font-size: 10px;
  line-height: 1.3;
  text-align: center;
  word-break: break-word;
}
</style>
