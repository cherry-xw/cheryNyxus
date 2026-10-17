<script setup lang="ts">
import './manager.css'
import PasswordField from './PasswordField.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { lanAccess } from './main'
import { managerRequest, onManagerSessionExpired } from '../../../packages/manager-ui/src/api'
import PluginsPanel from './PluginsPanel.vue'
import { usePlugins } from './usePlugins'

type Tab = 'overview' | 'plugins' | 'connection'
const plugins = usePlugins()
const managerModules = computed(() => plugins.state.modules.map((item) => item.descriptor.id))
const connectionTab = ref('credentials')
const sectionErrors = ref<Record<string, string>>({})
const authorization = ref<any>(null)

const requestedTab = new URLSearchParams(window.location.search).get('tab')
const tab = ref<Tab>(
  requestedTab === 'plugins'
    ? 'plugins'
    : requestedTab === 'connection'
      ? 'connection'
      : 'overview',
)
const authenticated = ref(false)
const loading = ref(false)
const saving = ref(false)
const message = ref('正在检查登录状态…')
const username = ref('')
const password = ref('')
const loginName = ref('')
const statusTime = ref('')
const flag = (v: unknown) => (v === true ? '是' : v === false ? '否' : '未知')
const backend = ref<Record<string, any>>({})
const newPassword = ref('')
const confirmPassword = ref('')
const relay = ref<Record<string, any>>({ url: '', backendId: '' })
const credentialPassword = ref('')
const oidc = ref({
  issuer: '',
  clientId: '',
  redirectUri: `${window.location.origin}/api/auth/oidc/callback`,
  adminSubjects: [] as string[],
  clientSecretConfigured: false,
  configured: false,
})
const oidcSecret = ref('')
const oidcSubjectsText = ref('')
const oidcAvailable = ref(false)
const firstAccountAllowed = ref(false)
const accountInitialized = ref(true)
const firstAccountUsername = ref('')
const firstAccountPassword = ref('')
const firstAccountPasswordConfirmation = ref('')
const firstAccountLoading = ref(false)
const firstAccountMessage = ref('')
const oidcLoading = ref(false)
const oidcSaving = ref(false)
const oidcMessage = ref('')

const tabs = computed(
  () =>
    [
      ['overview', '基础信息'],
      ['plugins', '插件管理'],
      ['connection', '连接'],
    ] as [Tab, string][],
)

async function checkSession() {
  try {
    const identity = await managerRequest<any>('/api/auth/me')
    authenticated.value = identity.authenticated === true
    loginName.value = identity.username || ''
    message.value = authenticated.value ? `已登录：${identity.username}` : '请登录 Manager'
    if (authenticated.value) await Promise.allSettled([loadAll(), loadOidc()])
  } catch {
    authenticated.value = false
    message.value = '请登录 Manager'
  }
}
async function logout() {
  try {
    await managerRequest('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  } finally {
    authenticated.value = false
    message.value = '已退出 Manager 登录'
  }
}
async function login() {
  if (loading.value) return
  loading.value = true
  message.value = '正在登录…'
  try {
    await managerRequest('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value.trim(), password: password.value }),
    })
    password.value = ''
    await checkSession()
  } catch (e) {
    message.value = e instanceof Error ? e.message : '登录失败'
  } finally {
    loading.value = false
  }
}
async function checkOidcAvailability() {
  try {
    const capabilities = await managerRequest<any>('/api/auth/capabilities')
    oidcAvailable.value = capabilities.oidc === true
    firstAccountAllowed.value = capabilities.allowInitialSetup === true
    accountInitialized.value = capabilities.initialized === true
  } catch {
    oidcAvailable.value = false
    firstAccountAllowed.value = false
    accountInitialized.value = true
  }
}
async function createFirstAccount() {
  firstAccountMessage.value = ''
  if (!firstAccountUsername.value.trim()) {
    firstAccountMessage.value = '请输入 Manager 用户名'
    return
  }
  if (firstAccountPassword.value.length < 12) {
    firstAccountMessage.value = '密码至少需要 12 个字符'
    return
  }
  if (firstAccountPassword.value !== firstAccountPasswordConfirmation.value) {
    firstAccountMessage.value = '两次输入的密码不一致'
    return
  }
  firstAccountLoading.value = true
  try {
    await managerRequest('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: firstAccountUsername.value.trim(),
        password: firstAccountPassword.value,
      }),
    })
    firstAccountUsername.value = ''
    firstAccountPassword.value = ''
    firstAccountPasswordConfirmation.value = ''
    await checkOidcAvailability()
    firstAccountMessage.value = 'Manager 账号创建成功，请使用新账号登录。'
  } catch (e) {
    firstAccountMessage.value = e instanceof Error ? e.message : '账号创建失败'
  } finally {
    firstAccountLoading.value = false
  }
}
async function loadOidc() {
  oidcLoading.value = true
  try {
    const result = await managerRequest<any>('/api/auth/oidc/config')
    oidc.value = { ...oidc.value, ...(result.data ?? {}) }
    oidcSubjectsText.value = oidc.value.adminSubjects.join('\n')
    oidcMessage.value = oidc.value.configured
      ? 'OIDC 已配置，登录入口可用。'
      : 'OIDC 尚未完整配置，请填写向导。'
  } catch (e) {
    oidcMessage.value = e instanceof Error ? e.message : 'OIDC 配置读取失败'
  } finally {
    oidcLoading.value = false
  }
}
async function saveOidc() {
  oidcSaving.value = true
  oidcMessage.value = '正在保存 OIDC 配置…'
  try {
    const result = await managerRequest<any>('/api/auth/oidc/config', {
      method: 'PUT',
      body: JSON.stringify({
        ...oidc.value,
        adminSubjects: oidcSubjectsText.value
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        clientSecret: oidcSecret.value || undefined,
      }),
    })
    oidc.value = { ...oidc.value, ...(result.data ?? {}) }
    oidcSubjectsText.value = oidc.value.adminSubjects.join('\n')
    oidcSecret.value = ''
    oidcMessage.value = result.restartRequired
      ? '已保存并回读确认。请重启 Manager 后启用新的 OIDC 配置。'
      : 'OIDC 配置已保存并回读确认。'
  } catch (e) {
    oidcMessage.value = e instanceof Error ? e.message : 'OIDC 配置保存失败'
  } finally {
    oidcSaving.value = false
  }
}
function startOidc() {
  window.location.assign('/api/auth/oidc/login')
}
async function loadSection(key: string, action: () => Promise<void>) {
  try {
    await action()
    sectionErrors.value[key] = ''
  } catch (e) {
    sectionErrors.value[key] = e instanceof Error ? e.message : '读取失败'
  }
}
async function loadAll() {
  await Promise.allSettled([
    loadSection('overview', async () => {
      backend.value = await managerRequest<any>('/api/status')
    }),
    loadSection('relay', async () => {
      relay.value = { ...relay.value, ...(await managerRequest<any>('/api/relay/config')) }
    }),
    loadSection('relayStatus', async () => {
      const result = await managerRequest<any>('/api/relay/status')
      relay.value.status = result.status
    }),
    loadAuthorization(),
  ])
}
async function loadAuthorization() {
  await loadSection('authorization', async () => {
    authorization.value = await managerRequest<any>('/api/relay/bindings')
  })
}
async function saveCredentials() {
  if (newPassword.value !== confirmPassword.value || newPassword.value.length < 12) {
    message.value = '新密码至少 12 个字符，且两次输入须一致'
    return
  }
  saving.value = true
  try {
    await managerRequest('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: credentialPassword.value,
        newPassword: newPassword.value,
      }),
    })
    authenticated.value = false
    message.value = '密码已修改，所有旧会话已失效，请使用新密码登录。'
  } catch (e) {
    message.value = e instanceof Error ? e.message : '密码修改失败'
  } finally {
    saving.value = false
    credentialPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
  }
}
async function saveRelay() {
  saving.value = true
  try {
    await managerRequest('/api/relay/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(relay.value),
    })
    const saved = await managerRequest<any>('/api/relay/config')
    relay.value = { ...relay.value, ...saved }
    message.value = '中转配置已保存并回读确认'
  } catch (e) {
    message.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}
async function requestRelayBinding() {
  saving.value = true
  try {
    await managerRequest('/api/relay/bindings/request', { method: 'POST', body: '{}' })
    message.value = '绑定申请已提交'
  } catch (e) {
    message.value = e instanceof Error ? e.message : '中转绑定不可用'
  } finally {
    saving.value = false
  }
}

watch(tab, () => {
  if (tab.value === 'plugins' && authenticated.value) void plugins.read()
  credentialPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  oidcSecret.value = ''
  window.history.replaceState(null, '', `?tab=${tab.value}`)
})
watch(authenticated, (value) => {
  if (!value) {
    credentialPassword.value = ''
    oidcSecret.value = ''
  }
})
onMounted(() => {
  void checkOidcAvailability()
  void checkSession()
})
onManagerSessionExpired(() => {
  authenticated.value = false
  message.value = '登录已失效，请重新登录 Manager'
})
</script>

<template>
  <main class="manager" :class="{ 'manager-login': !authenticated }">
    <header>
      <strong>cheryNyxus Manager</strong
      ><span v-if="lanAccess">局域网访问已开启，请使用 HTTPS</span>
    </header>
    <section v-if="!authenticated" class="login panel">
      <h1>登录 Manager</h1>
      <p class="muted">默认使用 Manager 用户名和密码登录。首次使用请先完成安全初始化。</p>
      <form @submit.prevent="login">
        <input
          v-model="username"
          aria-label="Manager 用户名"
          placeholder="Manager 用户名"
          autocomplete="username"
          required
        />
        <PasswordField
          v-model="password"
          label="Manager 密码"
          autocomplete="current-password"
          required
        />
        <button :disabled="loading" type="submit">
          {{ loading ? '登录中…' : '使用用户名密码登录' }}
        </button>
      </form>
      <button class="secondary" :disabled="loading || !oidcAvailable" @click="startOidc">
        通过身份服务登录（OIDC）
      </button>
      <p>{{ message }}</p>
      <p class="muted">
        {{
          oidcAvailable
            ? '将跳转到已配置的身份服务。'
            : 'OIDC 尚未配置完整，入口暂不可用。登录后可在“身份服务”中完成配置。'
        }}
      </p>
      <div v-if="firstAccountAllowed && !accountInitialized" class="first-account">
        <h2>首次创建 Manager 账号</h2>
        <p class="muted">当前后端允许创建一次账号。创建成功后入口会自动关闭。</p>
        <input
          v-model="firstAccountUsername"
          placeholder="新 Manager 用户名"
          autocomplete="username"
        /><input
          v-model="firstAccountPassword"
          type="password"
          placeholder="新 Manager 密码（至少 12 个字符）"
          autocomplete="new-password"
        /><input
          v-model="firstAccountPasswordConfirmation"
          type="password"
          placeholder="确认新密码"
          autocomplete="new-password"
        /><button :disabled="firstAccountLoading" @click="createFirstAccount">
          {{ firstAccountLoading ? '创建中…' : '创建账号' }}
        </button>
        <p role="status">{{ firstAccountMessage }}</p>
      </div>
    </section>
    <template v-else>
      <p class="notice">
        当前管理会话统一授权所有管理功能。<span>{{ message }}</span
        ><button @click="logout">退出登录</button>
      </p>
      <nav role="tablist">
        <button
          v-for="item in tabs"
          :key="item[0]"
          :aria-selected="tab === item[0]"
          @click="tab = item[0]"
        >
          {{ item[1] }}
        </button>
      </nav>
      <section v-if="tab === 'overview'" class="panel">
        <h1>基础信息</h1>
        <button @click="loadAll">刷新基础信息</button>
        <p v-if="sectionErrors.overview" class="error">{{ sectionErrors.overview }}</p>
        <div class="grid">
          <article>
            <h2>Manager 与登录</h2>
            <p>管理服务：在线</p>
            <p>管理账号：{{ loginName }}</p>
            <p>登录状态：{{ authenticated ? '已登录' : '未登录' }}</p>
            <p>身份服务：{{ oidc.configured ? '已配置' : '未配置' }}</p>
            <p>管理模块：{{ managerModules.join('、') }}</p>
          </article>
          <article>
            <h2>Backend</h2>
            <p>
              服务状态：{{
                sectionErrors.overview ? '读取失败' : backend.backend?.status || '未知'
              }}
            </p>
            <p>
              管理方式：{{
                backend.backendMode === 'external' ? '外部服务管理' : backend.backendMode || '未知'
              }}
            </p>
            <p class="muted">此处仅展示状态，不提供后端启停操作。</p>
          </article>
          <article>
            <h2>已安装插件</h2>
            <p v-if="plugins.state.error" class="error">{{ plugins.state.error }}</p>
            <ul v-if="plugins.state.list?.plugins.length">
              <li v-for="plugin in plugins.state.list.plugins" :key="plugin.id">
                {{ plugin.id }} · {{ plugin.savedVersion || '无版本' }} · {{ plugin.state }}
              </li>
            </ul>
            <p v-else-if="plugins.state.reading">正在读取插件…</p>
            <p v-else-if="!plugins.state.error">尚未安装插件。</p>
          </article>
          <article>
            <h2>中转与隧道</h2>
            <p>中转连接：{{ sectionErrors.relayStatus ? '读取失败' : relay.status || '未知' }}</p>
            <p>
              隧道：{{
                backend.processes?.find((p: any) => p.name === 'rathole')?.running
                  ? '运行中'
                  : '未运行或未配置'
              }}
            </p>
            <p>授权：{{ authorization?.status || '未知' }}</p>
          </article>
        </div>
      </section>
      <PluginsPanel v-if="tab === 'plugins'" :controller="plugins" />
      <nav v-show="tab === 'connection'" aria-label="连接设置">
        <button
          v-for="item in [
            ['credentials', '账号与密码'],
            ['relay', '中转连接'],
            ['authorization', '授权'],
            ['oidc', '身份服务'],
          ]"
          :key="item[0]"
          :aria-selected="connectionTab === item[0]"
          @click="connectionTab = item[0]"
        >
          {{ item[1] }}
        </button>
      </nav>
      <section v-show="tab === 'connection' && connectionTab === 'authorization'" class="panel">
        <h1>授权</h1>
        <button @click="loadAuthorization">刷新授权状态</button>
        <p v-if="sectionErrors.authorization" class="error">{{ sectionErrors.authorization }}</p>
        <p v-else-if="authorization?.status === 'unavailable'" class="notice">
          中转授权接口尚未接入。当前无法申请或撤销授权；这不是 QQ 白名单，也不影响本地管理登录。
        </p>
        <p v-else-if="!authorization">尚未读取授权状态。</p>
        <button
          :disabled="saving || !authorization || authorization.status === 'unavailable'"
          @click="requestRelayBinding"
        >
          申请授权
        </button>
      </section>
      <section v-show="tab === 'connection' && connectionTab === 'credentials'" class="panel">
        <h1>账号与密码</h1>
        <p>
          登录 Manager 即可管理所有已启用功能，无需再次登录 Backend。这里仅用于修改 Manager
          登录密码。
        </p>
        <form @submit.prevent="saveCredentials">
          <div class="grid">
            <label
              >当前密码<input
                v-model="credentialPassword"
                type="password"
                autocomplete="current-password"
                required /></label
            ><label
              >新密码<input
                v-model="newPassword"
                type="password"
                autocomplete="new-password"
                minlength="12"
                required /></label
            ><label
              >确认新密码<input
                v-model="confirmPassword"
                type="password"
                autocomplete="new-password"
                minlength="12"
                required
            /></label>
          </div>
          <p>修改成功后所有旧会话失效，需要使用新密码重新登录。</p>
          <button :disabled="saving" type="submit">修改密码</button>
        </form>
      </section>
      <section v-show="tab === 'connection' && connectionTab === 'relay'" class="panel">
        <h1>中转连接</h1>
        <p v-if="sectionErrors.relayStatus" class="error">{{ sectionErrors.relayStatus }}</p>
        <p v-if="sectionErrors.relay" class="error">{{ sectionErrors.relay }}</p>
        <div class="grid">
          <label>中转地址<input v-model="relay.url" /></label
          ><label>Backend ID<input v-model="relay.backendId" /></label>
        </div>
        <p>
          连接状态：{{ relay.status === 'not_connected' ? '未连接' : relay.status || '尚未读取' }}
        </p>
        <button :disabled="saving" @click="saveRelay">保存配置</button>
        <p class="muted">保存配置不代表已建立连接，授权状态见“授权”。</p>
      </section>
      <section v-show="tab === 'connection' && connectionTab === 'oidc'" class="panel oidc-panel">
        <div class="section-heading">
          <div>
            <h1>身份服务（OIDC）</h1>
            <p class="muted">
              保存后需要重启 Manager 才会重新加载。客户端密钥不会回显，也不会保存到浏览器。
            </p>
          </div>
          <button :disabled="oidcLoading" @click="loadOidc">
            {{ oidcLoading ? '读取中…' : '重新读取' }}
          </button>
        </div>
        <form @submit.prevent="saveOidc">
          <div class="grid">
            <label>Issuer<input v-model="oidc.issuer" required autocomplete="off" /></label
            ><label>Client ID<input v-model="oidc.clientId" required autocomplete="off" /></label
            ><label
              >Client Secret<input
                v-model="oidcSecret"
                type="password"
                autocomplete="new-password"
                :placeholder="
                  oidc.clientSecretConfigured ? '已配置，留空保持不变' : '首次配置必填'
                " /></label
            ><label
              >Redirect URI<input v-model="oidc.redirectUri" required autocomplete="off" /></label
            ><label class="wide"
              >管理员 Subjects（每行一个）<textarea
                v-model="oidcSubjectsText"
                rows="4"
                autocomplete="off"
              />
            </label>
          </div>
          <p :class="oidc.configured ? 'success' : 'muted'">
            {{
              oidc.configured
                ? '配置完整，OIDC 登录入口可用。'
                : '配置不完整，OIDC 登录入口暂不可用。'
            }}
          </p>
          <button :disabled="oidcSaving" type="submit">
            {{ oidcSaving ? '保存中…' : '保存并回读确认' }}
          </button>
          <p role="status">{{ oidcMessage }}</p>
        </form>
      </section>
    </template>
  </main>
</template>
