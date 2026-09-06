<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Delete } from '@element-plus/icons-vue'
import type { ConfigPreview } from '@chery/protocol'
import { useAgentsStore, useConfigApplyStore } from '@/application/public'
import { agentApi } from '@/application/backend/public'
import {
  applyHeadline,
  destructiveTargetLabel,
  impactLabel,
  impactNextStep,
} from '../config/applyPresentation'

defineProps<{ preview?: ConfigPreview | null }>()
const applyStore = useConfigApplyStore()
const agents = useAgentsStore()
const busyPid = ref<number>()
const actionError = ref('')
const state = computed(() => applyStore.state)

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

onMounted(() => void applyStore.refresh())
</script>

<template>
  <section class="apply-status" aria-live="polite">
    <template v-if="preview">
      <strong>
        {{
          preview.destructiveTargets.length
            ? '尚未保存：请确认删除影响'
            : '尚未保存：请确认运行影响'
        }}
      </strong>
      <p v-if="preview.destructiveTargets.length">
        再次点击保存才会提交。保存不会终止当前任务；删除生效后，相关任务不能再从已删除的角色或预设继续。
      </p>
      <p v-else>再次点击保存才会提交。当前任务会保留已有能力，等待可安全切换时再采用新权限。</p>
      <ul v-if="preview.destructiveTargets.length" class="impact-list">
        <li v-for="target in preview.destructiveTargets" :key="target">
          {{ destructiveTargetLabel(target) }}
        </li>
      </ul>
      <details v-if="preview.impacts.length">
        <summary>查看服务器计算的影响（{{ preview.impacts.length }}）</summary>
        <article v-for="impact in preview.impacts" :key="impact.resource">
          <b>{{ impactLabel(impact) }}</b>
          <span>{{ impact.reason || impactNextStep(impact) }}</span>
          <small v-if="impact.affectedRootChatIds?.length">
            受影响会话：{{ impact.affectedRootChatIds.map(chatLabel).join('、') }}
          </small>
        </article>
      </details>
    </template>
    <template v-else-if="state">
      <strong>{{ applyHeadline(state) }}</strong>
      <p v-if="state.status === 'applied' && !state.impacts.length">所有已保存内容均已生效。</p>
      <details v-if="state.impacts.length" :open="state.status !== 'applied'">
        <summary>查看生效明细（{{ state.impacts.length }}）</summary>
        <article v-for="impact in state.impacts" :key="impact.resource">
          <b
            >{{ impactLabel(impact) }} ·
            {{
              impact.status === 'applied'
                ? '已生效'
                : impact.status === 'failed'
                  ? '失败'
                  : '待生效'
            }}</b
          >
          <span v-if="impact.reason">{{ impact.reason }}</span>
          <small>{{ impactNextStep(impact) }}</small>
          <small v-if="impact.affectedRootChatIds?.length">
            受影响会话：{{ impact.affectedRootChatIds.map(chatLabel).join('、') }}
          </small>
        </article>
      </details>
      <div v-if="state.restart.required" class="restart-block">
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
                <button type="button" :disabled="busyPid === item.pid" aria-label="终止后台程序">
                  <Delete />
                </button>
              </template>
            </el-popconfirm>
          </li>
        </ul>
      </div>
    </template>
    <p v-if="actionError || applyStore.error" role="alert">
      {{ actionError || applyStore.error }}
    </p>
  </section>
</template>

<style scoped>
.apply-status {
  flex-shrink: 0;
  max-height: 240px;
  overflow: auto;
  padding: 8px 16px;
  border-top: 1px solid var(--el-border-color);
  font-size: 12px;
}
p {
  margin: 4px 0;
}
summary {
  cursor: pointer;
}
.impact-list,
.blocker-list {
  margin: 6px 0;
  padding-left: 18px;
}
article,
.restart-block {
  display: grid;
  gap: 3px;
  margin: 7px 0;
  padding-left: 10px;
  border-left: 2px solid var(--tab-color, var(--el-color-primary));
}
article span,
article small,
.restart-block span,
.restart-block small {
  overflow-wrap: anywhere;
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
button {
  display: inline-flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
}
button svg {
  width: 16px;
}
</style>
