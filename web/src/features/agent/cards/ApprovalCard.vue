<script setup lang="ts">
/**
 * ApprovalCard：sense 审批卡片（CP5）。
 * 触发：interrupt notification → store routeNotification 设 stream.approval（或入队 approvalQueue）。
 * 操作：
 *   - accept / reject → agentApi.approval(approvalId, action) → 成功后 dismissApproval 立即关闭
 *     （不等 accept/rejected notification 回来；store 仍会清，已 undefined 无害）。
 *     清空后自动从 queue pop 下一个（连续处理多审批）。
 *   - ✕ 关闭 → dismissApprovalToQueue 移到 queue 末尾（不丢失，PetIcons 渲染闪烁 icon）。
 *     同样自动 pop 下一个进当前 approval（多审批堆叠连续推进）。
 * 倒计时：waitTime（= global.approval_timeout）- (now - createdAt）。归零后按钮禁用，等后端超时 reject
 *        → rejected notification 清 stream.approval 卸载。waitTime=0 不超时不显倒计时。
 * 错误：console.error 上报（规则 12 fail loud），pending 复位允许重试。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useChatSessionsStore } from '@/stores'
import type { ApprovalState } from '@/stores/agents'
import ParsedArgs from './ParsedArgs.vue'
import { toSenseNameZh } from '@/utils/senseName'

const props = defineProps<{
  approval: ApprovalState
  /** 审批所属 chatId（submit 后 dismissApproval 用） */
  chatId: string
}>()

const chatSessions = useChatSessionsStore()

// 待执行动作（请求中两按钮都禁用防双击；null = idle）
const pending = ref<'accept' | 'reject' | null>(null)
const submitError = ref('')

// 倒计时：now 每 250ms 刷新驱动 remaining 重算。waitTime=0 不超时不启动定时器。
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
if (props.approval.waitTime > 0) {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 250)
}
onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer)
})

const showCountdown = computed(() => props.approval.waitTime > 0)
const remainingMs = computed(() =>
  Math.max(0, props.approval.waitTime - (now.value - props.approval.createdAt)),
)
const remainingSec = computed(() => Math.ceil(remainingMs.value / 1000))
// 倒计时归零：后端超时 reject 已触发，按钮禁用等 rejected notification 卸载
const expired = computed(() => showCountdown.value && remainingMs.value <= 0)
const security = computed(() => props.approval.security)
const riskLevel = computed(() => {
  const findings = security.value?.findings ?? []
  if (findings.some((item) => item.severity === 'unknown')) return '未知'
  if (findings.some((item) => item.severity === 'high')) return '高风险'
  if (findings.some((item) => item.severity === 'medium')) return '中风险'
  return '低风险'
})

watch(expired, (value) => {
  if (value) chatSessions.expireApproval(props.chatId, props.approval.approvalId)
})

async function submit(action: 'accept' | 'reject'): Promise<void> {
  if (pending.value !== null || expired.value) return
  pending.value = action
  submitError.value = ''
  try {
    await chatSessions.submitApproval(props.chatId, props.approval.approvalId, action)
    // 立即关闭：dismissApproval 清 stream.approval → 组件 v-if 卸载；自动 pop 下一个
  } catch (e) {
    // 规则 12 fail loud：上报并复位允许重试
    console.error(`[ApprovalCard] approval ${action} failed (id=${props.approval.approvalId}):`, e)
    submitError.value = (e as Error)?.message || '审批提交失败，请重试'
    pending.value = null
  }
}

/**
 * ✕ 关闭：把当前 approval 移到 queue 末尾（保留）；PetIcons 渲染闪烁 icon 提示待处理。
 * 触发时机：用户主动关闭但不想立即决定。
 * 不调 RPC（未告知服务端）；服务端超时后会通过 rejected notification 清理。
 */
function closeToQueue(): void {
  if (pending.value !== null) return // 请求中禁止关闭，避免双触发
  chatSessions.dismissApprovalToQueue(props.chatId)
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
      <span class="sense-name" :title="approval.senseName">{{ toSenseNameZh(approval.senseName) }}</span>
      <span v-if="showCountdown" class="countdown" :class="{ expired }">{{ remainingSec }}s</span>
      <button
        type="button"
        class="close-btn"
        :disabled="pending !== null"
        aria-label="关闭审批（保留到队列）"
        title="关闭审批（保留到队列，可从 pet icon 重新唤起）"
        @click="closeToQueue"
      >
        ✕
      </button>
    </div>
    <div v-if="security" class="security-summary">
      <div class="security-meta">
        <span>角色：{{ security.roleType }}</span>
        <span>{{ riskLevel }}</span>
        <span v-if="security.requiredSandboxMode">沙箱：{{ security.requiredSandboxMode }}</span>
      </div>
      <ul v-if="security.findings.length" class="security-findings">
        <li v-for="(finding, index) in security.findings" :key="`${finding.code}-${index}`">
          {{ finding.message }}
          <code v-if="finding.fragment">{{ finding.fragment }}</code>
        </li>
      </ul>
    </div>
    <ParsedArgs :args="approval.args" />
    <p v-if="submitError" class="submit-error" role="alert">{{ submitError }}</p>
    <div class="actions">
      <button
        type="button"
        class="btn accept"
        :disabled="pending !== null || expired"
        @click="submit('accept')"
      >
        批准本次执行
      </button>
      <button
        type="button"
        class="btn reject"
        :disabled="pending !== null || expired"
        @click="submit('reject')"
      >
        拒绝
      </button>
    </div>
  </div>
</template>

<style scoped lang="less">
@ink: var(--ink);

.approval-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 140px;
  max-width: 320px;
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
    background: #dcfce7;
    box-shadow: 0 0 0 2px rgba(234, 88, 12, 0.18);
  }

  .sense-name {
    color: color-mix(in srgb, #dc2626 80%, var(--ink));
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
    color: color-mix(in srgb, #16a34a 80%, var(--ink));
    font-size: 9px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;

    &.expired {
      background: rgba(239, 68, 68, 0.14);
      color: color-mix(in srgb, #dc2626 80%, var(--ink));
    }
  }

  .close-btn {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface-soft);
    color: color-mix(in srgb, var(--ink) 56%, transparent);
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    transition:
      background 100ms ease,
      color 100ms ease;

    &:hover:not(:disabled) {
      background: #fee2e2;
      color: color-mix(in srgb, var(--ink) 86%, transparent);
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.4;
    }
  }
}

.actions {
  display: flex;
  gap: 4px;
  margin-top: 2px;
}

.security-summary {
  padding: 5px;
  border: 1px solid color-mix(in srgb, #dc2626 22%, var(--border));
  border-radius: 5px;
  background: color-mix(in srgb, #fef2f2 55%, var(--surface));
  font-size: 9px;
}
.security-meta { display: flex; flex-wrap: wrap; gap: 3px 7px; font-weight: 700; }
.security-findings { margin: 4px 0 0; padding-left: 14px; }
.security-findings li { margin-top: 2px; overflow-wrap: anywhere; }
.security-findings code { display: block; margin-top: 2px; white-space: pre-wrap; color: var(--ink); }

.submit-error {
  margin: 1px 0 0;
  color: color-mix(in srgb, #dc2626 80%, var(--ink));
  line-height: 1.35;
  overflow-wrap: anywhere;
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
    color: #14532d;

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
