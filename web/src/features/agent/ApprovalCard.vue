<script setup lang="ts">
/**
 * ApprovalCard：sense 审批卡片（CP5）。
 * 触发：interrupt notification → store routeNotification 设 stream.approval。
 * 操作：accept / reject → agentApi.approval(approvalId, action) → 成功后 dismissApproval 立即关闭
 *       （不等 accept/rejected notification 回来；store 仍会清，已 undefined 无害）。
 * 倒计时：waitTime（= global.approval_timeout）- (now - createdAt)。归零后按钮禁用，等后端超时 reject
 *        → rejected notification 清 stream.approval 卸载。waitTime=0 不超时不显倒计时。
 * 错误：console.error 上报（规则 12 fail loud），pending 复位允许重试。
 */
import { computed, onBeforeUnmount, ref } from "vue";
import { agentApi } from "@/services/agentApi";
import { useAgentsStore } from "@/stores";
import type { ApprovalState } from "@/stores/agents";
import { formatArgValue, parseArgs } from "@/utils/parseArgs";

const props = defineProps<{
  approval: ApprovalState;
  /** 审批所属 chatId（submit 后 dismissApproval 用） */
  chatId: string;
}>();

const agents = useAgentsStore();

// 待执行动作（请求中两按钮都禁用防双击；null = idle）
const pending = ref<"accept" | "reject" | null>(null);
const expanded = ref(false);

// 倒计时：now 每 250ms 刷新驱动 remaining 重算。waitTime=0 不超时不启动定时器。
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
if (props.approval.waitTime > 0) {
  timer = setInterval(() => {
    now.value = Date.now();
  }, 250);
}
onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer);
});

const showCountdown = computed(() => props.approval.waitTime > 0);
const remainingMs = computed(() =>
  Math.max(0, props.approval.waitTime - (now.value - props.approval.createdAt)),
);
const remainingSec = computed(() => Math.ceil(remainingMs.value / 1000));
// 倒计时归零：后端超时 reject 已触发，按钮禁用等 rejected notification 卸载
const expired = computed(() => showCountdown.value && remainingMs.value <= 0);

/**
 * arguments 结构化展示（复用 SenseCallBox 的 parseArgs 逻辑）。
 * description 字段作折叠标题；其余字段作 key:value 行。
 * 解析失败 → fallback JSON pretty-print。
 */
const argsParsed = computed(() => parseArgs(props.approval.args));
const argsFallback = computed(() => argsParsed.value.fallback);
const argsEntries = computed(() => argsParsed.value.parsed?.entries ?? []);
const argsToggleLabel = computed(
  () => argsParsed.value.parsed?.description ?? "arguments",
);
const hasArgs = computed(() => {
  const { parsed, fallback } = argsParsed.value;
  if (parsed) return parsed.description != null || parsed.entries.length > 0;
  return fallback.length > 0;
});

async function submit(action: "accept" | "reject"): Promise<void> {
  if (pending.value !== null) return;
  pending.value = action;
  try {
    await agentApi.approval(props.approval.approvalId, action);
    // 立即关闭：dismissApproval 清 stream.approval → 组件 v-if 卸载
    agents.dismissApproval(props.chatId);
  } catch (e) {
    // 规则 12 fail loud：上报并复位允许重试
    console.error(
      `[ApprovalCard] approval ${action} failed (id=${props.approval.approvalId}):`,
      e,
    );
    pending.value = null;
  }
}
</script>

<template>
  <div
    class="approval-card"
    role="group"
    :aria-label="`Approval request for ${approval.senseName}`"
  >
    <div class="header">
      <span class="indicator" aria-hidden="true" />
      <span class="sense-name" :title="approval.senseName">{{ approval.senseName }}</span>
      <span v-if="showCountdown" class="countdown" :class="{ expired }">{{ remainingSec }}s</span>
    </div>
    <div v-if="hasArgs" class="args">
      <button
        type="button"
        class="args-toggle"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >{{ expanded ? "▾" : "▸" }} {{ argsToggleLabel }}</button>
      <div v-if="expanded" class="args-body">
        <div v-if="argsEntries.length" class="arg-rows">
          <div v-for="entry in argsEntries" :key="entry.key" class="arg-row">
            <span class="arg-key">{{ entry.key }}:</span>
            <span class="arg-val">{{ formatArgValue(entry.value) }}</span>
          </div>
        </div>
        <pre v-else-if="argsFallback" class="args-pre">{{ argsFallback }}</pre>
        <span v-else class="arg-empty">(无其他参数)</span>
      </div>
    </div>
    <div class="actions">
      <button
        type="button"
        class="btn accept"
        :disabled="pending !== null || expired"
        @click="submit('accept')"
      >Accept</button>
      <button
        type="button"
        class="btn reject"
        :disabled="pending !== null || expired"
        @click="submit('reject')"
      >Reject</button>
    </div>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;

.approval-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 140px;
  max-width: 200px;
}

.header {
  display: flex;
  align-items: center;
  gap: 5px;

  .indicator {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #ea580c;
    box-shadow: 0 0 0 2px rgba(234, 88, 12, 0.18);
  }

  .sense-name {
    color: #23242a;
    font-size: 11px;
    font-weight: 800;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  .countdown {
    margin-left: auto;
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(234, 88, 12, 0.12);
    color: #c2410c;
    font-size: 9px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;

    &.expired {
      background: rgba(239, 68, 68, 0.14);
      color: #b91c1c;
    }
  }
}

.args {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.args-toggle {
  padding: 1px 5px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.6);
  color: fade(@ink, 70%);
  font-size: 9px;
  font-weight: 700;
  cursor: pointer;

  &:hover {
    background: #fff;
  }
}

.args-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 4px;
  width: 100%;
}

.arg-rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.arg-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}

.arg-key {
  flex-shrink: 0;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 9px;
  font-weight: 700;
  color: fade(@ink, 60%);
}

.arg-val {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 9px;
  line-height: 1.4;
  color: fade(@ink, 82%);
  max-height: 80px;
  overflow: auto;
}

.arg-empty {
  font-size: 9px;
  font-style: italic;
  color: fade(@ink, 44%);
}

.args-pre {
  margin: 0;
  padding: 3px 5px;
  border-radius: 4px;
  background: fade(@ink, 6%);
  color: fade(@ink, 82%);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 9px;
  font-weight: 500;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 80px;
  overflow: auto;
  width: 100%;
}

.actions {
  display: flex;
  gap: 4px;
  margin-top: 2px;
}

.btn {
  flex: 1;
  padding: 3px 6px;
  border: 1px solid;
  border-radius: 5px;
  font-size: 10px;
  font-weight: 800;
  cursor: pointer;
  transition:
    background 120ms ease,
    opacity 120ms ease;

  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  &.accept {
    border-color: #16a34a;
    background: #dcfce7;
    color: #166534;

    &:hover:not(:disabled) {
      background: #bbf7d0;
    }
  }

  &.reject {
    border-color: #dc2626;
    background: #fee2e2;
    color: #991b1b;

    &:hover:not(:disabled) {
      background: #fecaca;
    }
  }
}
</style>
