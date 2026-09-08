<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Delete } from '@element-plus/icons-vue'
import { useAgentsStore, useConfigApplyStore } from '@/application/public'
import { agentApi } from '@/application/backend/public'
import { impactNextStep } from '../config/applyPresentation'
import { settingsNotices, type NoticeKind } from '../model/settingsNotices'
import { useTransientNotices } from './useTransientNotices'

const props = defineProps<{
  sequence: number
  savedHint?: string | null
  warnings?: string[] | null
  error?: string | null
  externalChange?: boolean
  busy?: boolean
}>()
const emit = defineEmits<{ reload: [] }>()
const kinds: { key: NoticeKind; label: string }[] = [
  { key: 'warning', label: '警告' },
  { key: 'error', label: '错误' },
]
const applyStore = useConfigApplyStore()
const agents = useAgentsStore()
const busyPid = ref<number>()
const actionError = ref('')
const state = computed(() => applyStore.state)
const feedback = useTransientNotices()
const messages = computed(() =>
  feedback.notices.value.filter((notice) => notice.kind === 'message'),
)
const groups = computed(() =>
  kinds
    .map((kind) => ({
      ...kind,
      notices: feedback.notices.value.filter((notice) => notice.kind === kind.key),
    }))
    .filter((group) => group.notices.length),
)
let followingSave = false
function publish(includeState = followingSave): void {
  feedback.show(
    settingsNotices({
      ...props,
      state: includeState ? state.value : undefined,
      applyError: includeState ? applyStore.error : undefined,
      actionError: actionError.value,
    }),
  )
}
// No immediate watcher: existing persistent state is never replayed on opening settings.
watch(
  () => props.sequence,
  () => {
    followingSave = !!props.savedHint
    publish()
  },
)
watch(
  () => JSON.stringify([state.value, applyStore.error]),
  () => {
    if (followingSave && !props.busy) publish()
  },
)
watch(actionError, (value) => {
  if (value) publish()
})

async function kill(chatId: string, pid: number) {
  busyPid.value = pid
  actionError.value = ''
  try {
    await agentApi.killBackgroundProcess(chatId, pid)
    await applyStore.refresh()
  } catch {
    actionError.value = '终止请求失败，请检查连接后重试'
  } finally {
    busyPid.value = undefined
  }
}

function chatLabel(chatId: string): string {
  const chat = agents.historyList.find((item) => item.chatId === chatId)
  return chat?.preview ? `${chat.preview}（${chatId}）` : chatId
}
</script>

<template>
  <section
    v-if="feedback.notices.value.length"
    class="status-capsules"
    aria-label="设置消息"
    aria-live="polite"
    @mouseenter="feedback.pause('hover')"
    @mouseleave="feedback.resume('hover')"
    @focusin="feedback.pause('focus')"
    @focusout="feedback.resume('focus')"
  >
    <span v-for="message in messages" :key="message.id" class="status-message">{{
      message.text
    }}</span>
    <el-popover
      v-for="group in groups"
      :key="group.key"
      trigger="hover"
      :show-after="0"
      :hide-after="200"
      :enterable="true"
      placement="top-end"
      :width="520"
      :disabled="!group.notices.length"
      popper-class="label-tip-popper"
      :popper-style="{ maxWidth: 'calc(100vw - 32px)' }"
      @show="feedback.pause(group.key)"
      @hide="feedback.resume(group.key)"
    >
      <template #reference>
        <button
          type="button"
          class="status-capsule"
          :class="group.key"
          :disabled="!group.notices.length"
          :aria-label="`${group.label} ${group.notices.length} 条，悬停查看详情`"
        >
          {{ group.label }} <span>{{ group.notices.length }}</span>
        </button>
      </template>
      <div class="status-notices">
        <h3>{{ group.label }} · {{ group.notices.length }}</h3>
        <article v-for="notice in group.notices" :key="notice.id">
          <p>{{ notice.text }}</p>
          <template v-if="notice.impact">
            <small>{{ impactNextStep(notice.impact) }}</small>
            <small v-if="notice.impact.affectedRootChatIds?.length">
              受影响会话：{{ notice.impact.affectedRootChatIds.map(chatLabel).join('、') }}
            </small>
          </template>
          <el-popconfirm
            v-if="notice.id === 'external'"
            title="重新载入会放弃此窗口内尚未保存的配置和 Hooks 草稿。"
            confirm-button-text="放弃草稿并载入"
            cancel-button-text="保留草稿"
            :width="300"
            @confirm="emit('reload')"
          >
            <template #reference>
              <button type="button" class="notice-action" :disabled="busy">
                重新载入服务器版本
              </button>
            </template>
          </el-popconfirm>
          <div v-if="notice.id === 'restart' && state" class="restart-block">
            <b>{{
              state.restart.status === 'failed'
                ? '重启未完成'
                : state.restart.status === 'ready'
                  ? '正在重启'
                  : '等待重启生效'
            }}</b>
            <span>{{ state.restart.reason || '正在等待任务与后台程序安全结束' }}</span>
            <ul v-if="state.restart.blockers?.length" class="blocker-list">
              <li v-for="(item, index) in state.restart.blockers" :key="index">
                <span>
                  {{ item.description }}
                  <small v-if="item.chatId">会话：{{ item.chatId }}</small>
                  <small v-if="item.pid">PID {{ item.pid }}</small>
                </span>
                <el-popconfirm
                  v-if="item.kind === 'process' && item.chatId && item.pid"
                  title="终止后，程序中未完成的工作可能丢失；所有阻塞解除后将自动重启。"
                  confirm-button-text="终止程序"
                  cancel-button-text="继续等待"
                  :width="300"
                  @confirm="kill(item.chatId!, item.pid!)"
                >
                  <template #reference>
                    <button
                      type="button"
                      :disabled="busyPid === item.pid"
                      aria-label="终止后台程序"
                    >
                      <Delete />
                    </button>
                  </template>
                </el-popconfirm>
              </li>
            </ul>
          </div>
        </article>
      </div>
    </el-popover>
  </section>
</template>

<style scoped>
.status-capsules {
  flex: 1 1 auto;
  flex-wrap: wrap;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  min-width: 0;
}
.status-message {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--ink);
  font: 400 12px/20px var(--font-ui, sans-serif);
}
.status-capsule {
  --notice-color: var(--accent);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 4px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--notice-color);
  font: 400 12px/28px var(--font-ui, sans-serif);
  cursor: pointer;
}
.status-capsule.warning {
  --notice-color: var(--warning);
}
.status-capsule.error {
  --notice-color: var(--danger);
}
.status-capsule:disabled {
  opacity: 0.45;
  cursor: default;
}
.status-capsule:focus-visible {
  outline: 2px solid var(--notice-color);
  outline-offset: 2px;
}
.status-notices {
  max-height: 55vh;
  overflow: auto;
  overflow-wrap: anywhere;
}
h3 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}
article {
  display: grid;
  gap: 5px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
p {
  margin: 0;
  white-space: pre-wrap;
}
small,
b,
p {
  font-size: 12px;
  font-weight: 400;
}
.restart-block {
  display: grid;
  gap: 5px;
}
.blocker-list {
  margin: 0;
  padding-left: 18px;
}
.blocker-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 5px 0;
}
.blocker-list li > span {
  display: grid;
  flex: 1;
  min-width: 0;
}
.notice-action,
.blocker-list button {
  justify-self: start;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--surface-soft);
  color: var(--ink);
  font: 400 12px/24px var(--font-ui, sans-serif);
  cursor: pointer;
}
button svg {
  width: 16px;
  height: 16px;
}
</style>
