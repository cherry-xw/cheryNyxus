<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { managerRequest } from '../../../packages/manager-ui/src/api'
import {
  BACKEND_PLUGIN_ID,
  BACKEND_PLUGIN_TITLE,
  backendStateLabels,
  type useBackendPlugin,
} from './useBackendPlugin'

const props = defineProps<{
  controller: ReturnType<typeof useBackendPlugin>
  request?: typeof managerRequest
}>()
const req = props.request ?? managerRequest
const { state, read, start, cancelRetry, saveAutoStart, stop, setEnabled, resolveStop } = props.controller

const expanded = ref(false)
const subTab = ref<'monitor' | 'business-login'>('monitor')

const businessLogin = ref({
  username: '',
  passwordConfigured: false,
  businessPreset: 'full',
  browserOrigin: '',
  browserBasePath: '',
  remoteEnabled: false,
  proofIssuer: '',
  proofBackendId: '',
  proofKeys: {} as Record<string, string>,
})
const proofKeysText = ref('{}')
const businessPassword = ref('')
const businessSaving = ref(false)
const businessMessage = ref('')

const status = computed(() => state.status)
const external = computed(() => status.value?.managedBy === 'external')
const runtimeState = computed(() => status.value?.state ?? 'inactive')
const lifecycle = computed(() => status.value?.lifecycle)
const stopping = computed(() => !!lifecycle.value && !['running', 'stopped'].includes(lifecycle.value.phase))
const pluginEnabled = computed(() => status.value?.intent?.pluginEnabled !== false)
const now = ref(Date.now())
const forceSeconds = computed(() => lifecycle.value?.forceDeadlineAt == null ? null : Math.max(0, Math.ceil((lifecycle.value.forceDeadlineAt - now.value) / 1000)))
const stopLabel = computed(() => lifecycle.value?.phase === 'force_stopping' ? '正在中断任务并关闭' :
  lifecycle.value?.phase === 'closing' ? '正在关闭服务' : '等待任务结束后关闭')
const canStart = computed(
  () =>
    !state.writing &&
    !!status.value && pluginEnabled.value && !stopping.value &&
    status.value?.managedBy !== 'external' &&
    runtimeState.value !== 'running' &&
    runtimeState.value !== 'starting',
)
const isRetrying = computed(() => runtimeState.value === 'retrying')
const isFailed = computed(() => runtimeState.value === 'failed' || runtimeState.value === 'retrying')
const versionCompatible = computed(() => status.value?.versionCompatibility.compatible !== false)
const retryCountdownSeconds = computed(() => {
  const ms = status.value?.nextRetryInMs
  return typeof ms === 'number' ? Math.max(0, Math.ceil(ms / 1000)) : null
})

function formatMemory(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '未采集'
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatRatio(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return '未知'
  return `${(ratio * 100).toFixed(1)}%`
}

function formatUptime(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '0s'
  const s = Math.floor(seconds)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

async function loadBusinessLogin() {
  businessMessage.value = ''
  try {
    businessLogin.value = await req<any>('/api/business-login/config')
    proofKeysText.value = JSON.stringify(businessLogin.value.proofKeys ?? {}, null, 2)
  } catch (e) {
    businessMessage.value = e instanceof Error ? e.message : '业务登录配置读取失败'
  }
}

async function saveBusinessLogin() {
  businessSaving.value = true
  businessMessage.value = ''
  try {
    await req('/api/business-login/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...businessLogin.value,
        proofKeys: JSON.parse(proofKeysText.value),
        ...(businessPassword.value ? { password: businessPassword.value } : {}),
      }),
    })
    businessPassword.value = ''
    await loadBusinessLogin()
    businessMessage.value =
      '业务登录配置已保存并读回，安全重启Backend后生效；不改变Manager账号或机器凭据'
  } catch (e) {
    businessMessage.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    businessSaving.value = false
    businessPassword.value = ''
  }
}

let pollTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void read()
  pollTimer = setInterval(() => {
    now.value = Date.now()
    if (!state.writing) void read(true)
  }, 1_000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <article class="panel plugin-card backend-plugin-card" data-plugin-id="cherynyxus-backend-manager">
    <div class="section-heading">
      <div>
        <h3>{{ BACKEND_PLUGIN_TITLE }}</h3>
        <code class="muted">{{ BACKEND_PLUGIN_ID }}</code>
      </div>
      <div class="plugin-badges">
        <span>默认预装 · 内置不可卸载</span>
        <span>{{ external ? (status?.running ? '外部端口可连接' : '外部端口不可连接') : backendStateLabels[runtimeState] }}</span>
        <span>{{ external ? '外部管理 · 随插件自动启动不适用' : status?.autoStart !== false ? '随插件自动启动：已开启' : '随插件自动启动：已关闭' }}</span>
      </div>
    </div>

    <p v-if="!versionCompatible" class="warning" role="status">
      当前版本不支持管理该项：Backend 与插件契约版本不匹配，部分高级配置已置灰，基础启动与监控仍可使用。
    </p>
    <p v-if="state.error" class="error" role="alert">{{ state.error }}</p>
    <p v-if="state.message" role="status">{{ state.message }}</p>

    <dl class="plugin-facts">
      <div>
        <dt>Backend 服务状态</dt>
        <dd>{{ external ? (status?.running ? '外部服务端口可连接' : '外部服务端口不可连接') : backendStateLabels[runtimeState] }}（<code>{{ runtimeState }}</code>）</dd>
      </div>
      <div>
        <dt>{{ external ? '实际连接地址与端口探测（不代表业务健康）' : '监听端口与健康状态' }}</dt>
        <dd>
          {{ status?.listener?.host || '待读取' }}:{{ status?.listener?.port ?? '—' }} ·
          {{ status?.listener?.ready ? '已就绪' : '未就绪' }}
        </dd>
      </div>
      <div>
        <dt>进程 PID / 运行时长</dt>
        <dd>
          <template v-if="external">外部进程 · PID 与运行时长未采集</template>
          <template v-else>PID {{ status?.pid ?? '无' }} · 运行 {{ formatUptime(status?.uptimeSeconds) }}</template>
        </dd>
      </div>
      <div>
        <dt>资源占用（进程 / 系统）</dt>
        <dd>
          <span v-if="external">Backend 进程资源未采集；以下系统资源来自 Manager。</span>
          进程 CPU {{ status?.resources?.process?.cpuPercent ?? '-' }}% · 进程内存
          {{ formatMemory(status?.resources?.process?.memoryBytes) }} · 系统内存
          {{ formatRatio(status?.resources?.system?.memoryUsedRatio) }}
        </dd>
      </div>
    </dl>

    <section v-if="!external && lifecycle && stopping" class="backend-failure-box" :aria-busy="stopping" aria-label="Backend 关闭进度">
      <h4 role="status">{{ stopLabel }}</h4>
      <p v-if="lifecycle.connection === 'lost'" class="warning">控制连接失联，关闭意图仍保留；不会自动恢复或强杀。</p>
      <p v-if="forceSeconds !== null">强制退出期限剩余 {{ forceSeconds }} 秒。发送取消或关闭请求不代表进程已退出。</p>
      <p v-else>正常等待没有倒计时。已暂存 {{ lifecycle.parkedInputCount }} 条输入，不会采用下一条排队消息。</p>
      <ul v-if="lifecycle.blockers.length"><li v-for="item in lifecycle.blockers" :key="item.id"><details><summary>{{ item.description }}</summary><p>工作标识：{{ item.id }}</p><p v-if="item.chatId">会话：{{ item.chatId }}</p><p v-if="item.commandId">命令：{{ item.commandId }}（完整输出可在业务 Web 的“命令监控”中查看）</p></details></li></ul>
      <p v-if="lifecycle.error" class="error" role="alert">{{ lifecycle.error }}</p>
      <div class="plugin-card-actions" v-if="lifecycle.phase !== 'force_stopping'">
        <button type="button" :disabled="state.writing" @click="resolveStop('force')">中断任务并关闭</button>
        <button type="button" :disabled="state.writing || !lifecycle.canCancel || lifecycle.connection !== 'connected'" @click="resolveStop('cancel')">取消关闭</button>
      </div>
    </section>
    <p v-if="!external && (stopping || lifecycle?.phase === 'stopped')">仅停止 Backend：已发布的小应用及独立 supercronic 继续运行。人工终端不阻止等待；实际关闭会结束本地终端并断开 SSH，但不代表远端命令已停止。</p>
    <section v-if="lifecycle?.unknownExternalOperations.length" aria-label="结果未确认的外部操作">
      <h4>外部操作结果未确认</h4>
      <p>这些操作与 Backend 本地进程是否退出分别记录；不会自动重放。</p>
      <ul><li v-for="item in lifecycle.unknownExternalOperations" :key="item.id">{{ item.description }}</li></ul>
    </section>
    <p v-if="status?.pluginDisable" :role="status.pluginDisable.status === 'failed' ? 'alert' : 'status'">
      {{ status.pluginDisable.status === 'waiting' ? '插件停用：等待 Backend 停止' : status.pluginDisable.status === 'saved' ? '插件停用：已保存' : `插件停用保存失败：${status.pluginDisable.error}` }}
    </p>

    <div v-if="isFailed || status?.lastError" class="backend-failure-box">
      <p class="error" role="alert">
        <strong>异常与失败诊断：</strong>{{ status?.lastError || '后端未就绪或异常退出' }}
      </p>
      <p v-if="isRetrying">
        自动重试进度：<strong>{{ status?.retryCount }}/{{ status?.maxRetries ?? 3 }}</strong>
        <span v-if="retryCountdownSeconds !== null">
          · 下次重试倒计时：{{ retryCountdownSeconds }}s（{{ status?.nextRetryAt }}）
        </span>
      </p>
      <p v-else-if="runtimeState === 'failed'">
        已停止自动重试（重试次数 {{ status?.retryCount ?? 0 }}/{{ status?.maxRetries ?? 3 }}），可查看下方日志排查后手动点击“启动 Backend”。
      </p>
    </div>

    <div class="plugin-card-actions">
      <label class="inline-toggle">
        <input type="checkbox" :checked="pluginEnabled" :disabled="!status || state.writing || external || stopping" @change="setEnabled(($event.target as HTMLInputElement).checked)" />
        启用 Backend 管理插件
      </label>
      <label class="inline-toggle">
        <input
          type="checkbox"
          :checked="status?.autoStart !== false"
          :disabled="state.writing || external"
          @change="saveAutoStart(($event.target as HTMLInputElement).checked)"
        />
        随插件启动 Backend
      </label>
      <button type="button" :disabled="!canStart" @click="start">
        {{ runtimeState === 'starting' ? '启动中…' : '启动 Backend' }}
      </button>
      <button v-if="!external && status?.running && !stopping" type="button" :disabled="state.writing" @click="stop">停止 Backend</button>
      <button
        v-if="isRetrying"
        type="button"
        class="secondary"
        :disabled="state.writing"
        @click="cancelRetry"
      >
        取消重试
      </button>
      <button type="button" :disabled="state.reading" @click="read()">刷新监控状态</button>
      <button
        type="button"
        @click="
          expanded = !expanded;
          if (expanded && subTab === 'business-login') loadBusinessLogin()
        "
      >
        {{ expanded ? '收起管理面板' : '打开监控与业务登录设置' }}
      </button>
    </div>

    <p v-if="external" class="muted">外部服务由 Docker / 系统服务管理；本面板不采集其进程日志，不执行自动启动或崩溃重试。</p>
    <div v-if="expanded" class="backend-plugin-detail panel">
      <nav aria-label="Backend 管理插件子面板">
        <button
          type="button"
          :aria-selected="subTab === 'monitor'"
          @click="subTab = 'monitor'"
        >
          进程监控与启动/崩溃日志
        </button>
        <button
          type="button"
          :aria-selected="subTab === 'business-login'"
          :disabled="!versionCompatible"
          @click="
            subTab = 'business-login';
            loadBusinessLogin()
          "
        >
          Backend 业务登录设置（AI Web）
        </button>
      </nav>

      <section v-if="subTab === 'monitor'">
        <h4>进程运行与崩溃诊断日志（最近 {{ status?.logs?.length ?? 0 }} 行）</h4>
        <pre v-if="status?.logs?.length" class="backend-log-viewer"><template
          v-for="(entry, idx) in status.logs"
          :key="idx"
        >[{{ entry.timestamp }}] [{{ entry.stream }}] {{ entry.line }}
</template></pre>
        <p v-else class="muted">暂无进程输出日志。</p>
      </section>

      <section v-else-if="subTab === 'business-login'">
        <h4>后端业务登录设置（独立于 Manager 管理登录）</h4>
        <p class="muted">
          配置 AI Web 业务端登录账号与远程证明参数；实际业务登录仍由 Backend 独立承载，与 Manager 管理员会话完全隔离。
        </p>
        <button type="button" :disabled="businessSaving" @click="loadBusinessLogin">
          读取当前配置
        </button>
        <div class="grid">
          <label>业务用户名<input v-model="businessLogin.username" autocomplete="off" /></label>
          <label>
            替换业务密码
            <input v-model="businessPassword" type="password" autocomplete="new-password" />
          </label>
          <label>
            业务档
            <select v-model="businessLogin.businessPreset">
              <option value="basic">基础会话与历史</option>
              <option value="full">完整业务</option>
            </select>
          </label>
          <label>
            反向代理公开 Origin
            <input v-model="businessLogin.browserOrigin" placeholder="https://workbench.example" />
          </label>
          <label>
            公开路径前缀
            <input v-model="businessLogin.browserBasePath" placeholder="/nyxus（无前缀留空）" />
          </label>
        </div>
        <p>密码状态：{{ businessLogin.passwordConfigured ? '已配置；留空保留' : '未配置' }}</p>
        <button type="button" :disabled="businessSaving" @click="saveBusinessLogin">
          保存并读回（需安全重启Backend）
        </button>
        <p v-if="businessMessage" role="status">{{ businessMessage }}</p>
      </section>
    </div>
  </article>
</template>
