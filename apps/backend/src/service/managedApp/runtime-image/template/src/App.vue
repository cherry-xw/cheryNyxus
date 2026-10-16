<template>
  <div class="app-shell">
    <header class="topbar">
      <div>
        <h1>CheryNyxus 应用工作台 ({{ auth.appId || 'App' }})</h1>
        <p class="subtitle">Vue 3 + Express + SQLite + ECharts + 安全 Markdown + CSV 固定模板</p>
      </div>
      <div class="auth-box">
        <template v-if="auth.user">
          <span class="badge">{{ auth.user.username }} ({{ auth.user.role }})</span>
          <button class="btn secondary" @click="handleLogout">退出</button>
        </template>
      </div>
    </header>

    <section v-if="!auth.activated" class="card auth-card">
      <h2>首次管理员一次性激活</h2>
      <form @submit.prevent="handleActivate" class="form-grid">
        <input v-model="activateForm.activationToken" placeholder="一次性激活令牌" required />
        <input v-model="activateForm.username" placeholder="管理员用户名" required />
        <input v-model="activateForm.password" type="password" placeholder="管理员密码 (至少6位)" required />
        <button class="btn primary" type="submit">激活并登录</button>
      </form>
    </section>

    <section v-else-if="!auth.user" class="card auth-card">
      <h2>登录小应用</h2>
      <form @submit.prevent="handleLogin" class="form-grid">
        <input v-model="loginForm.username" placeholder="用户名" required />
        <input v-model="loginForm.password" type="password" placeholder="密码" required />
        <button class="btn primary" type="submit">登录</button>
      </form>
    </section>

    <p v-if="errorMessage" class="error-banner">{{ errorMessage }}</p>

    <div class="grid-two">
      <section class="card">
        <h2>分类金额分布 (ECharts)</h2>
        <div ref="chartEl" class="chart-box"></div>
      </section>

      <section class="card">
        <h2>新增数据记录 &amp; 实时任务</h2>
        <form v-if="auth.user" @submit.prevent="handleCreateRecord" class="form-stack">
          <input v-model="newRecord.title" placeholder="标题" required />
          <div class="row">
            <input v-model="newRecord.category" placeholder="分类 (如 餐饮/办公)" required />
            <input v-model.number="newRecord.amount" type="number" step="0.01" placeholder="金额" />
          </div>
          <textarea v-model="newRecord.note_md" rows="3" placeholder="支持 Markdown 备注（自动经 DOMPurify 净化）"></textarea>
          <div class="row">
            <button class="btn primary" type="submit">保存记录</button>
            <button class="btn secondary" type="button" @click="triggerDemoTask">触发 SSE 后台任务 ({{ taskProgress }})</button>
            <a class="btn secondary" :href="exportCsvUrl" target="_blank">导出安全 CSV</a>
          </div>
        </form>
        <p v-else class="muted">登录后可新增记录、导入 CSV、上传附件与触发后台任务。</p>
      </section>
    </div>

    <section class="card">
      <h2>数据列表 ({{ records.length }} 条)</h2>
      <table class="data-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>标题</th>
            <th>分类</th>
            <th>金额</th>
            <th>安全 Markdown 备注</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in records" :key="item.id">
            <td>{{ item.id }}</td>
            <td>{{ item.title }}</td>
            <td>{{ item.category }}</td>
            <td>{{ item.amount }}</td>
            <td v-html="renderSafeMarkdown(item.note_md)"></td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, watch, nextTick } from 'vue'
import * as echarts from 'echarts'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { apiFetch, setCsrfToken, resolveAppUrl, openAppEvents } from './api.js'

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
const chartEl = ref(null)
let chartInstance = null

const auth = reactive({
  activated: true,
  user: null,
  appId: '',
})
const errorMessage = ref('')
const records = ref([])
const stats = ref([])
const taskProgress = ref('空闲')
const exportCsvUrl = resolveAppUrl('api/records/export.csv')

const activateForm = reactive({ activationToken: '', username: 'admin', password: '' })
const loginForm = reactive({ username: 'admin', password: '' })
const newRecord = reactive({ title: '', category: '默认', amount: 0, note_md: '' })

function renderSafeMarkdown(text) {
  return DOMPurify.sanitize(md.render(String(text || '')))
}

async function loadInitial() {
  try {
    const me = await apiFetch('api/auth/me')
    auth.activated = me.activated
    auth.user = me.user
    auth.appId = me.appId
    setCsrfToken(me.csrfToken)

    const urlParams = new URLSearchParams(window.location.search)
    const tokenFromUrl = urlParams.get('activate_token')
    if (tokenFromUrl && !auth.activated) {
      activateForm.activationToken = tokenFromUrl
    }

    await loadRecords()
  } catch (err) {
    errorMessage.value = err.message
  }
}

async function loadRecords() {
  const data = await apiFetch('api/records')
  records.value = data.items || []
  stats.value = data.stats || []
  await nextTick()
  updateChart()
}

function updateChart() {
  if (!chartEl.value) return
  if (!chartInstance) {
    chartInstance = echarts.init(chartEl.value)
  }
  chartInstance.setOption({
    tooltip: { trigger: 'item' },
    xAxis: {
      type: 'category',
      data: stats.value.map(s => s.category),
    },
    yAxis: { type: 'value' },
    series: [
      {
        type: 'bar',
        data: stats.value.map(s => s.totalAmount),
      },
    ],
  })
}

async function handleActivate() {
  errorMessage.value = ''
  try {
    const res = await apiFetch('api/auth/activate', {
      method: 'POST',
      body: JSON.stringify(activateForm),
    })
    auth.activated = true
    auth.user = res.user
    setCsrfToken(res.csrfToken)
    await loadRecords()
  } catch (err) {
    errorMessage.value = err.message
  }
}

async function handleLogin() {
  errorMessage.value = ''
  try {
    const res = await apiFetch('api/auth/login', {
      method: 'POST',
      body: JSON.stringify(loginForm),
    })
    auth.user = res.user
    setCsrfToken(res.csrfToken)
    await loadRecords()
  } catch (err) {
    errorMessage.value = err.message
  }
}

async function handleLogout() {
  await apiFetch('api/auth/logout', { method: 'POST' })
  auth.user = null
  setCsrfToken(null)
}

async function handleCreateRecord() {
  errorMessage.value = ''
  try {
    await apiFetch('api/records', {
      method: 'POST',
      body: JSON.stringify(newRecord),
    })
    newRecord.title = ''
    newRecord.amount = 0
    newRecord.note_md = ''
    await loadRecords()
  } catch (err) {
    errorMessage.value = err.message
  }
}

async function triggerDemoTask() {
  try {
    taskProgress.value = '启动中...'
    await apiFetch('api/tasks/demo', { method: 'POST', body: '{}' })
  } catch (err) {
    errorMessage.value = err.message
  }
}

onMounted(() => {
  loadInitial()
  const es = openAppEvents('events')
  es.addEventListener('task_progress', e => {
    const d = JSON.parse(e.data)
    taskProgress.value = `${d.progress}% (${d.status})`
  })
})

watch(stats, () => updateChart())
</script>

<style>
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #f5f7fa; color: #1f2937; }
.app-shell { max-width: 1080px; margin: 0 auto; padding: 20px; }
.topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.subtitle { margin: 4px 0 0; color: #6b7280; font-size: 13px; }
.card { background: #fff; border-radius: 10px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
.grid-two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.chart-box { width: 100%; height: 240px; }
.form-grid, .form-stack { display: flex; flex-direction: column; gap: 10px; }
.row { display: flex; gap: 8px; align-items: center; }
input, textarea { padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; }
.btn { padding: 8px 14px; border-radius: 6px; border: none; cursor: pointer; font-size: 14px; text-decoration: none; }
.btn.primary { background: #2563eb; color: #fff; }
.btn.secondary { background: #e5e7eb; color: #374151; }
.error-banner { background: #fee2e2; color: #991b1b; padding: 10px; border-radius: 6px; }
.data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.data-table th, .data-table td { border-bottom: 1px solid #e5e7eb; padding: 8px; text-align: left; }
</style>
