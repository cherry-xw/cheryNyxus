import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { agentApi, type CredentialListItemDTO } from '@/application/backend/public'
import { wsClient } from '@/application/transport/public'
import {
  readTerminalPresets,
  writeTerminalPresets,
  TERMINAL_PRESETS_CHANGED_EVENT,
  type TerminalPreset,
} from './presets'

export function useWorkbenchTerminal(chatId: () => string) {
  const host = ref<HTMLElement | null>(null)
  const status = ref<'idle' | 'connecting' | 'connected' | 'exited'>('idle')
  const error = ref('')
  const label = ref('')
  const credentials = ref<CredentialListItemDTO[]>([])
  const presets = ref<TerminalPreset[]>([])
  const selectedPresetId = ref('')
  const form = reactive({
    kind: 'local',
    host: '',
    port: 22,
    username: '',
    auth: 'password',
    password: '',
    privateKey: '',
    passphrase: '',
    credentialId: '',
    remember: false,
  })
  const canConnect = computed(
    () =>
      status.value !== 'connecting' &&
      status.value !== 'connected' &&
      (form.kind === 'local' ||
        (!!form.host.trim() &&
          !!form.username.trim() &&
          Number.isInteger(form.port) &&
          form.port > 0 &&
          form.port <= 65535 &&
          !!(form.auth === 'saved'
            ? form.credentialId
            : form.auth === 'key'
              ? form.privateKey.trim()
              : form.password))),
  )
  function applyPreset(id: string): void {
    selectedPresetId.value = id
    const preset = presets.value.find((item) => item.id === id)
    if (!preset) return
    form.kind = preset.kind
    form.host = preset.host
    form.port = preset.port
    form.username = preset.username
    form.auth = preset.auth
    form.credentialId = preset.credentialId ?? ''
    form.password = ''
    form.privateKey = ''
    form.passphrase = ''
    error.value = preset.kind === 'ssh' && !preset.credentialId
      ? '此预设缺少加密凭据，请重新保存连接。'
      : ''
  }
  async function savePreset(label: string): Promise<void> {
    const name = label.trim()
    if (!name) {
      error.value = '请先填写连接名称。'
      return
    }
    if (form.kind === 'ssh' && form.auth === 'key') {
      error.value = '私钥不会保存到预设，请使用后端加密凭据或每次临时输入。'
      return
    }
    try {
      let credentialId = form.credentialId || undefined
      if (form.kind === 'ssh' && form.auth === 'password') {
        if (!form.password) {
          error.value = '保存 SSH 预设前请输入密码。'
          return
        }
        credentialId = (
          await agentApi.saveCredential(`SSH ${form.host.trim()}`, form.username.trim(), form.password)
        ).id
        credentials.value = await agentApi.listCredentials()
        form.credentialId = credentialId
        form.auth = 'saved'
        form.password = ''
      }
      if (form.kind === 'ssh' && !credentialId) {
        error.value = '请先选择或保存一个加密凭据。'
        return
      }
      const preset: TerminalPreset = {
        id: selectedPresetId.value || crypto.randomUUID(),
        label: name,
        kind: form.kind as TerminalPreset['kind'],
        host: form.host.trim(),
        port: form.port,
        username: form.username.trim(),
        auth: 'saved',
        ...(credentialId ? { credentialId } : {}),
      }
      const next = presets.value.filter((item) => item.id !== preset.id)
      presets.value = [...next, preset]
      selectedPresetId.value = preset.id
      writeTerminalPresets(presets.value)
      error.value = ''
    } catch (cause) {
      fail(cause)
    }
  }
  function removePreset(id: string): void {
    presets.value = presets.value.filter((item) => item.id !== id)
    if (selectedPresetId.value === id) selectedPresetId.value = ''
    writeTerminalPresets(presets.value)
  }
  let terminal: Terminal | undefined
  let fit: FitAddon | undefined
  let observer: ResizeObserver | undefined
  let themeObserver: MutationObserver | undefined
  let sessionId = ''
  let disposed = false
  let version = 0
  let buffered: Array<{
    sessionId: string
    event: string
    data?: string
    code?: number
    message?: string
  }> = []
  let inputQueue = Promise.resolve()
  function fail(cause: unknown): void {
    error.value = cause instanceof Error ? cause.message : 'Terminal 操作失败'
  }
  function resize(): void {
    if (!host.value?.clientWidth || !host.value?.clientHeight || !fit || !terminal) return
    fit.fit()
    if (sessionId)
      void agentApi
        .terminalResize(
          sessionId,
          Math.max(20, Math.min(500, terminal.cols)),
          Math.max(5, Math.min(200, terminal.rows)),
        )
        .catch(fail)
  }
  function syncTheme(): void {
    if (!host.value || !terminal) return
    const style = getComputedStyle(host.value)
    terminal.options.theme = {
      background: style.backgroundColor,
      foreground: style.color,
      cursor: style.color,
    }
  }
  function consume(data: (typeof buffered)[number]): void {
    if (data.sessionId !== sessionId) return
    if (data.event === 'output') terminal?.write(data.data ?? '')
    if (data.event === 'error') error.value = data.message ?? 'Terminal 连接失败'
    if (data.event === 'exit') {
      terminal?.writeln('\r\n[连接已结束 · 退出码 ' + (data.code ?? '未知') + ']')
      sessionId = ''
      status.value = 'exited'
    }
  }
  const offNotification = wsClient.onNotification((value) => {
    const notification = value as { type?: string; data?: (typeof buffered)[number] }
    if (notification.type !== 'terminal.event' || !notification.data) return
    if (!sessionId && status.value === 'connecting') {
      if (buffered.length < 128) buffered.push(notification.data)
    } else consume(notification.data)
  })
  const offStatus = wsClient.onStatus((connection) => {
    if (connection !== 'connected' && status.value === 'connected') {
      version++
      sessionId = ''
      status.value = 'exited'
      error.value = '与后端的连接已断开，终端已关闭；恢复后请重新连接'
    }
  })
  async function connect(): Promise<void> {
    if (!canConnect.value || sessionId) return
    const current = ++version
    status.value = 'connecting'
    error.value = ''
    buffered = []
    terminal?.reset()
    try {
      let credentialId = form.credentialId
      if (form.kind === 'ssh' && form.auth === 'password' && form.remember) {
        credentialId = (
          await agentApi.saveCredential('SSH ' + form.host, form.username, form.password)
        ).id
      }
      const target =
        form.kind === 'local'
          ? { kind: 'local' }
          : {
              kind: 'ssh',
              host: form.host.trim(),
              port: form.port,
              username: form.username.trim(),
              ...(form.auth === 'saved' || (form.auth === 'password' && form.remember)
                ? { credentialId }
                : form.auth === 'key'
                  ? { privateKey: form.privateKey, passphrase: form.passphrase }
                  : { password: form.password }),
            }
      const created = await agentApi.createTerminal(
        chatId(),
        target,
        Math.max(20, terminal?.cols ?? 80),
        Math.max(5, terminal?.rows ?? 24),
      )
      if (disposed || current !== version) {
        await agentApi.closeTerminal(created.sessionId)
        return
      }
      sessionId = created.sessionId
      label.value = created.target.label
      status.value = 'connected'
      buffered.forEach(consume)
      buffered = []
      await nextTick()
      resize()
      terminal?.focus()
    } catch (cause) {
      if (!disposed && current === version) {
        status.value = 'idle'
        fail(cause)
      }
    } finally {
      form.password = ''
      form.privateKey = ''
      form.passphrase = ''
    }
  }
  async function disconnect(): Promise<void> {
    version++
    const id = sessionId
    sessionId = ''
    status.value = 'exited'
    if (id) {
      try {
        await agentApi.closeTerminal(id)
      } catch (cause) {
        fail(cause)
      }
    }
  }
  const reloadPresets = (): void => {
    void readTerminalPresets().then((items) => {
      presets.value = items
      if (selectedPresetId.value && !items.some((item) => item.id === selectedPresetId.value))
        selectedPresetId.value = ''
    })
  }
  onMounted(() => {
    reloadPresets()
    window.addEventListener(TERMINAL_PRESETS_CHANGED_EVENT, reloadPresets)
    terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Fira Code Local, Fira Code, monospace',
      scrollback: 5000,
      convertEol: false,
      allowProposedApi: false,
    })
    fit = new FitAddon()
    terminal.loadAddon(fit)
    if (host.value) {
      terminal.open(host.value)
      observer = new ResizeObserver(resize)
      observer.observe(host.value)
      resize()
    }
    syncTheme()
    themeObserver = new MutationObserver(syncTheme)
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    })
    terminal.onData((data) => {
      const id = sessionId
      if (!id) return
      inputQueue = inputQueue
        .then(async () => {
          if (sessionId === id) await agentApi.terminalInput(id, data)
        })
        .catch(fail)
    })
    void agentApi
      .listCredentials()
      .then((items) => {
        credentials.value = items
      })
      .catch(fail)
  })
  onBeforeUnmount(() => {
    disposed = true
    void disconnect()
    offNotification()
    offStatus()
    window.removeEventListener(TERMINAL_PRESETS_CHANGED_EVENT, reloadPresets)
    observer?.disconnect()
    themeObserver?.disconnect()
    terminal?.dispose()
  })
  return {
    host,
    status,
    error,
    label,
    form,
    credentials,
    presets,
    selectedPresetId,
    canConnect,
    applyPreset,
    savePreset,
    removePreset,
    connect,
    disconnect,
    clear: () => terminal?.clear(),
  }
}
