<script setup lang="ts">
import Dropdown from '../../../packages/manager-ui/src/Dropdown.vue'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useQq } from './useQq'
import { managerRequest } from '../../../packages/manager-ui/src/api'
const memory = ref<any[]>([])
const memoryError = ref('')
async function readMemory() {
  try { memory.value = (await managerRequest<any>('/api/modules/qq/memory')).data; memoryError.value = '' }
  catch (error) { memoryError.value = error instanceof Error ? error.message : '统计读取失败' }
}
const { state, dirty, targets, read, catalog, refresh, save, add, remove, summary, load } = useQq()
const groups = ref(''),
  users = ref('')
const emit = defineEmits<{ dirty: [value: boolean] }>()
watch(dirty, (value) => emit('dirty', value))
watch(
  () => [state.selected, state.config?.bindings[state.selected]],
  () => void summary(state.config?.bindings[state.selected] || ''),
)
const flag = (v: unknown) => (v === true ? '是' : v === false ? '否' : '未读取')
const applyLabel = (v: string) =>
  ({
    applied: '已应用',
    pending: '待应用',
    failed: '应用失败',
    restart_required: '需重启运行服务',
  })[v] || '应用状态未知'
function addTargets(kind: 'groups' | 'users') {
  if (add(kind, kind === 'groups' ? groups.value : users.value)) {
    if (kind === 'groups') groups.value = ''
    else users.value = ''
  }
}
function discard() {
  if (!dirty.value || window.confirm('重新读取会丢弃未保存草稿，继续吗？')) void read(true)
}
function beforeUnload(e: BeforeUnloadEvent) {
  if (dirty.value || state.saving) {
    e.preventDefault()
    e.returnValue = ''
  }
}
onMounted(() => {
  void load()
  void readMemory()
  window.addEventListener('beforeunload', beforeUnload)
})
onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload))
</script>
<template>
  <div class="qq-workspace">
    <section class="panel">
      <div class="section-heading">
        <h2>连接与诊断</h2>
        <button @click="refresh('status')">刷新诊断</button>
      </div>
      <p v-if="state.statusError" class="error" role="alert">
        QQ 状态读取失败：{{ state.statusError }}
      </p>
      <p v-else-if="!state.status">正在读取 QQ 状态…</p>
      <div v-else class="diagnostic-grid">
        <article>
          <h3>插件与身份</h3>
          <p>
            已安装：{{ flag(state.status.installed) }} · 已启用：{{ flag(state.status.enabled) }}
          </p>
          <p>活动版本：{{ state.status.activeVersion || '未读取' }}</p>
          <p>NapCat 已连接：{{ flag(state.status.napcatConnected) }}</p>
          <p>身份已验证：{{ flag(state.status.trustedIdentity) }}</p>
          <p>QQ 在线：{{ flag(state.status.qqOnline) }}</p>
        </article>
        <article>
          <h3>业务准备情况</h3>
          <p>业务暂停：{{ flag(state.status.paused) }}</p>
          <p>
            保存版本：{{ state.status.savedRevision ?? '未知' }} · 应用版本：{{
              state.status.appliedRevision ?? '未知'
            }}
          </p>
          <p>{{ applyLabel(state.status.apply?.state) }}</p>
          <p>缺少绑定：{{ state.status.missingBindings?.join('、') || '无' }}</p>
          <p>资源缺失：{{ state.status.missingResources?.join('、') || '无' }}</p>
          <p v-for="reason in state.status.reasons" :key="reason">{{ reason }}</p>
        </article>
      </div>
      <p class="muted">
        Manager 不启停 NapCat，不负责实时 QQ 消息。连接成功不等于目标已允许或模型可用。
      </p>
    </section>
    <slot name="token" />
    <section class="panel">
      <div class="section-heading"><h2>记忆统计</h2><button @click="readMemory">刷新统计</button></div>
      <p v-if="memoryError" class="error">{{ memoryError }}</p>
      <article v-for="item in memory" :key="item.scope">
        <p>{{ ({personal: '私聊', group: '群', member: '群成员'} as Record<string,string>)[item.scope] }}：{{ item.scopes }} 个范围 · {{ item.count }} 条记忆<span v-if="item.unreadable"> · {{ item.unreadable }} 个文件无法读取</span></p>
        <p v-for="(entry, index) in item.entries" :key="index" class="muted">{{ entry.groupId ? `群 ${entry.groupId}` : '' }} {{ entry.userId ? `用户 ${entry.userId}` : '' }}{{ entry.unidentified ? '旧记录（身份未登记）' : '' }}：{{ entry.count }} 条 · {{ new Date(entry.updatedAt).toLocaleString() }}</p>
      </article>
    </section>
    <section class="panel">
      <div class="section-heading">
        <h2>目标与预设</h2>
        <div>
          <button :disabled="state.reading || state.saving" @click="discard">重新读取配置</button
          ><button @click="catalog">刷新预设目录</button>
        </div>
      </div>
      <p v-if="state.error" class="error" role="alert">{{ state.error }}</p>
      <p v-if="state.catalogError" class="error">预设目录读取失败：{{ state.catalogError }}</p>
      <p v-if="state.reading">正在读取配置…</p>
      <p v-if="!state.config && !state.reading">
        配置尚不可用，请根据上方错误恢复连接后重新读取。不会将读取失败当作空白名单。
      </p>
      <template v-if="state.config">
        <fieldset :disabled="!state.ready || state.reading || state.saving || state.uncertain">
          <legend>群与私聊独立管理</legend>
          <div class="grid">
            <label
              >允许的群号<textarea
                v-model="groups"
                rows="2"
                placeholder="多个号码用空格或逗号分隔"
              /><button @click="addTargets('groups')">添加群</button></label
            ><label
              >允许私聊的 QQ 号<textarea
                v-model="users"
                rows="2"
                placeholder="多个号码用空格或逗号分隔"
              /><button @click="addTargets('users')">添加私聊</button></label
            >
          </div>
          <p class="muted">
            空名单不允许任何目标；未绑定预设也不会处理消息。群内需要 @ 机器人，私聊不需要。
          </p>
          <div class="grid">
            <label
              >当前目标<Dropdown v-model="state.selected"
                ><option value="">请选择目标</option>
                <option v-for="target in targets" :key="target" :value="target">
                  {{ target }}
                </option></Dropdown
              ></label
            ><label
              >已有预设<Dropdown
                v-if="state.selected"
                v-model="state.config.bindings[state.selected]"
                :disabled="!state.catalog"
                ><option value="">未绑定</option>
                <option v-for="name in state.catalog?.presets || []" :key="name" :value="name">
                  {{ name }}
                </option></Dropdown
              ><span v-else>先选择目标</span></label
            >
          </div>
          <button v-if="state.selected" @click="remove(state.selected)">
            移除此目标及绑定（保存后生效）
          </button>
          <p v-if="state.summary">{{ state.summary }}</p>
          <p v-if="state.summaryError" class="error">{{ state.summaryError }}</p>
          <ul>
            <li v-for="target in targets" :key="target">
              {{ target }} → {{ state.config.bindings[target] || '未绑定，不能聊天' }}
            </li>
          </ul>
          <p v-if="!targets.length">名单为空。</p>
        </fieldset>
      </template>
    </section>
    <section v-if="state.config" class="panel">
      <h2>回复与等待规则</h2>
      <fieldset :disabled="!state.ready || state.reading || state.saving || state.uncertain">
        <legend>QQ 独立规则</legend>
        <div class="grid">
          <label
            >等待间隔（秒）<input
              v-model.number="state.config.waitIntervalSeconds"
              type="number"
              min="10"
              max="3600" /></label
          ><label
            >同一成员免 @ 续聊条数<input
              v-model.number="state.config.continuationMaxMessages"
              type="number"
              min="0"
              max="100" /></label
          ><label
            >群续聊有效期（毫秒）<input
              v-model.number="state.config.continuationTtlMs"
              type="number"
              min="1" /></label
          ><label
            >回复分片字数<input
              v-model.number="state.config.maxMessageChars"
              type="number"
              min="1" /></label
          ><label
            >每目标队列上限<input
              v-model.number="state.config.queueLimit"
              type="number"
              min="1" /></label
          ><label
            >历史保留上限<input
              v-model.number="state.config.historyLimit"
              type="number"
              min="1" /></label
          ><label
            >等待文案顺序<Dropdown v-model="state.config.waitMessageMode"
              ><option value="cycle">循环</option>
              <option value="random">随机</option></Dropdown
            ></label
          ><label
            >等待文案（每行一条）<textarea
              :value="state.config.waitMessages.join('\n')"
              rows="4"
              @input="
                state.config.waitMessages = ($event.target as HTMLTextAreaElement).value.split('\n')
              "
            />
          </label>
        </div>
        <label
          ><input
            v-model="state.config.toolIconsEnabled"
            type="checkbox"
          />发送实际调用工具对应的图标</label
        >
        <details>
          <summary>工具图标映射</summary>
          <div class="grid">
            <label v-for="tool in state.catalog?.tools || []" :key="tool.name"
              >{{ tool.label || tool.name
              }}<input
                :value="state.config.toolIcons[tool.name] || ''"
                @input="
                  ($event.target as HTMLInputElement).value
                    ? (state.config.toolIcons[tool.name] = (
                        $event.target as HTMLInputElement
                      ).value)
                    : delete state.config.toolIcons[tool.name]
                "
            /></label>
          </div>
        </details>
        <p class="muted">
          等待间隔默认 60 秒；续聊条数为 0 时每次都需要 @。规则仅作用于
          QQ，运行中的请求保留原设置。模型与思考参数在“能力管理”中配置。
        </p>
      </fieldset>
    </section>
    <section v-if="state.config" class="panel save-bar">
      <b>{{ dirty ? '有未保存草稿' : '配置已回读' }}</b>
      <p>{{ state.message }} · {{ applyLabel(state.apply?.state) }}</p>
      <p v-if="state.uncertain" class="warning">
        写入结果未知或版本冲突，请重新读取核对；不会自动重复保存。
      </p>
      <button
        :disabled="!dirty || !state.ready || state.saving || state.reading || state.uncertain"
        @click="save"
      >
        {{ state.saving ? '保存并核对中…' : '保存并回读确认' }}
      </button>
    </section>
    <div class="grid">
      <section v-for="kind in ['queue', 'history'] as const" :key="kind" class="panel">
        <div class="section-heading">
          <h2>{{ kind === 'queue' ? '队列' : '历史' }}</h2>
          <button @click="refresh(kind)">刷新</button>
        </div>
        <p v-if="state[`${kind}Error`]" class="error">{{ state[`${kind}Error`] }}</p>
        <template v-else-if="state[kind]"
          ><p v-if="!state[kind].entries?.length">当前没有记录。</p>
          <article v-for="item in state[kind].entries" :key="item.requestId">
            <p>请求：{{ item.requestId }}</p>
            <p>状态：{{ item.state }} · {{ item.reason || '无错误' }}</p>
          </article></template
        >
        <p v-else>尚未读取。</p>
      </section>
    </div>
  </div>
</template>
