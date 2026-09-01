/**
 * SettingsDialog：后端 config 设置面板外壳（居中 tab 弹窗）。
 * 触发：agents.settingsOpen（AgentFab ⚙️ 入口）。
 * 打开 -> config.get 读 .chery/config.yaml 原文（除 server 段）-> 深拷贝为 draft 编辑。
 * 保存 -> config.save 校验 + 写回（保留 server 段、无注释），重启生效；失败 error 红框列出。
 *
 * 外壳只管 overlay / tab 切换 / draft 加载保存；各 tab 内容拆到 ./tabs/，删除二次确认见 ConfirmPopover。
 *
 * ⚠ 入场动画只用 opacity + y（无 scale）：scale 会让 panel 视觉上 < 720px，
 *    若 RPC 在 180ms 内 resolve，content 切换会被叠在 scale 动画里导致宽高抖动。
 */
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  provide,
  reactive,
  readonly,
  ref,
  watch,
} from 'vue'
import { ArrowLeft, ArrowRight, Close } from '@element-plus/icons-vue'
import { useAgentsStore, useConnectionStore } from '@/application/public'
import {
  agentApi,
  type ConfigDto,
  type SenseToolDocInfo,
  type SenseToolInfo,
  type SkillInfo,
  type PluginInfo,
  type HookEventMeta,
  type HookHandlerDTO,
  type HooksShellInfo,
} from '@/application/backend/public'
import { wsClient } from '@/application/transport/public'
import {
  TABS,
  HINT_LINES,
  INDEX_COUNT,
  SETTINGS_ACTIVE_TAB_KEY,
  type TabKey,
} from './config/constants'
import { OVERLAY_Z_INDEX } from '@/styles/overlayLayers'
import { desktopBridge } from '@/features/desktop/desktopBridge'
import BrainsTab from './tabs/brain/BrainsTab.vue'
import MediaTab from './tabs/config/MediaTab.vue'
import SensesTab from './tabs/tools/SensesTab.vue'
import RolesTab from './tabs/agent/RolesTab.vue'
import PresetsTab from './tabs/agent/PresetsTab.vue'
import McpTab from './tabs/tools/McpTab.vue'
import GlobalTab from './tabs/config/GlobalTab.vue'
import CommandsTab from './tabs/config/CommandsTab.vue'
import SkillsTab from './tabs/tools/SkillsTab.vue'
import type { SkillSource } from '@/application/backend/public'
import PluginsTab from './tabs/tools/PluginsTab.vue'
import HooksTab from './tabs/hooks/HooksTab.vue'
import SkeletonTab from './tabs/SkeletonTab.vue'
import OpenConfigDirButton from './components/OpenConfigDirButton.vue'
import type { SettingsSection } from '@/domain/shell/desktopBridge'

export type SettingsDialogControllerProps = { native?: boolean; initialSection?: SettingsSection }

const SETTINGS_TAB_BY_SECTION: Record<SettingsSection, TabKey> = {
  provider: 'brains',
  runtime: 'presets',
  limits: 'global',
}

export function useSettingsDialogController(props: SettingsDialogControllerProps) {
  const agents = useAgentsStore()
  const connection = useConnectionStore()
  /** Electron 原生设置窗面（WindowFrame 外壳内）：铺满窗、去自绘拖拽/三键、关闭走 windowControl；
   *  浏览器 overlay 路径（native=false）逐字节不变。 */
  const isNative = computed(() => !!props.native && !!desktopBridge())
  const bridge = desktopBridge()
  const draft = ref<ConfigDto | null>(null)
  const initialTab = props.initialSection
    ? SETTINGS_TAB_BY_SECTION[props.initialSection]
    : agents.settingsSection
      ? SETTINGS_TAB_BY_SECTION[agents.settingsSection]
      : 'presets'
  const activeTab = ref<TabKey>(initialTab)
  /** 实际已揭示的 Tab；切换时先置空，让骨架屏完成一帧绘制后再挂载目标页。 */
  const renderedTab = ref<TabKey | null>(initialTab)
  const tabSwitching = ref(false)
  const rolesShadowMode = ref(false)
  provide(SETTINGS_ACTIVE_TAB_KEY, readonly(activeTab))
  /** 当前激活 tab 的主题色：提升到 panel 根作为 --tab-color，让保存按钮/序号/卡片强调点/panel 背景/边框随 tab 整体变色。
   *  tab 按钮仍各自绑自己的 color（hover/active 显示对应 tab 色），与此处全局基调互不冲突。 */
  const activeTabColor = computed(() =>
    activeTab.value === 'roles' && rolesShadowMode.value
      ? '#64748b'
      : (TABS.find((t) => t.key === activeTab.value)?.color ?? '#22d3ee'),
  )
  const activeTabHighlight = computed(() =>
    activeTab.value === 'roles' && rolesShadowMode.value ? '#cbd5e1' : activeTabColor.value,
  )
  const settingsThemeStyle = computed(() => ({
    '--tab-color': activeTabColor.value,
    '--tab-highlight': activeTabHighlight.value,
  }))
  /** 当前 tab 的 hints 段落拆分（sect + warn），渲染与真实 hints 像素级一致。 */
  const hintLines = computed(() => HINT_LINES[activeTab.value] ?? { sect: 1, warn: 0 })
  /** 当前 tab 序号按钮典型数（SkeletonTab 用，在 footer 左侧渲染导航占位）。 */
  const indexCount = computed(() => INDEX_COUNT[activeTab.value] ?? 4)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const savedHint = ref<string | null>(null)
  const savedWarnings = ref<string[] | null>(null)
  // ── 窗口拖动最大化：拖标题栏到屏幕顶部边缘 → 最大化；最大化后标题栏按钮还原 ──
  const maximized = ref(false)
  /** 面板 DOM 元素（motion.div 经 $el 解包；函数 ref 统一取底层 div）。 */
  const panelEl = ref<HTMLElement | null>(null)
  function setPanelEl(el: unknown): void {
    panelEl.value = (el as { $el?: HTMLElement } | null)?.$el ?? (el as HTMLElement | null)
  }
  const dragging = ref(false)
  const dragOffset = reactive({ x: 0, y: 0 })
  let dragCleanup: (() => void) | undefined
  /** 释放时判定「拖到顶部」的阈值（px）：面板上缘距视口顶 ≤ 该值即最大化。 */
  const MAXIMIZE_TOP_THRESHOLD = 12
  const panelStyle = computed(() => ({
    transform: maximized.value ? undefined : `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
  }))
  /** 面板合并样式：主题色变量 + 拖动 transform。 */
  const panelStyles = computed(() => ({
    ...settingsThemeStyle.value,
    ...panelStyle.value,
  }))
  function onTitlePointerDown(e: PointerEvent): void {
    // native 面拖拽归 WindowFrame（-webkit-app-region: drag），本面板不做 pointer 拖
    if (isNative.value) return
    if (e.button !== 0) return
    if ((e.target as Element | null)?.closest('button')) return
    e.preventDefault()
    // 最大化状态下再拖标题栏：先还原到居中再拖动（拖下即还原，拖上可再最大化）
    if (maximized.value) {
      maximized.value = false
      dragOffset.x = 0
      dragOffset.y = 0
    }
    const startPointer = { x: e.clientX, y: e.clientY }
    const startOffset = { x: dragOffset.x, y: dragOffset.y }
    dragging.value = true
    document.body.style.userSelect = 'none'
    const move = (ev: PointerEvent) => {
      dragOffset.x = startOffset.x + ev.clientX - startPointer.x
      dragOffset.y = startOffset.y + ev.clientY - startPointer.y
    }
    const end = () => {
      dragging.value = false
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      dragCleanup = undefined
      const top = panelEl.value?.getBoundingClientRect().top ?? 0
      // 拖到顶部边缘 → 最大化；否则回弹居中（offset 归零，transition 平滑回弹）
      if (top <= MAXIMIZE_TOP_THRESHOLD) maximized.value = true
      dragOffset.x = 0
      dragOffset.y = 0
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    dragCleanup = end
  }
  function toggleMaximize(): void {
    maximized.value = !maximized.value
    dragOffset.x = 0
    dragOffset.y = 0
  }
  /** 后端 config.save 返回的 workspace 校验告警，按预设名分发到 PresetsTab 输入框下（key=presetName, value=错误文案）。 */
  const workspaceWarnings = ref<Record<string, string>>({})
  /** 每个预设独立的最新校验序号，丢弃输入已变化后的迟到响应。 */
  const workspaceValidationSeq = new Map<string, number>()
  /** immediate 重启时等待重连的上限（ms）；到点仍连不上 → 隐藏 savedHint。 */
  const RECONNECT_TIMEOUT_MS = 60000
  /** 重连成功后"已保存，服务已更新"的展示时长（ms）；到点隐藏。 */
  const SUCCESS_HINT_TIMEOUT_MS = 5000
  /** 重连等待计时器显示：已等待秒数（immediate 时每秒 +1，重连成功停止）。 */
  const waitElapsed = ref(0)
  const isWaitingReconnect = ref(false)
  let reconnectWatcher: { promise: Promise<void>; cancel: () => void } | null = null
  let waitInterval: ReturnType<typeof setInterval> | null = null
  let waitTimeout: ReturnType<typeof setTimeout> | null = null
  let closeTimeout: ReturnType<typeof setTimeout> | null = null
  /** 停止等待计时器显示（不动超时句柄）。 */
  function clearWaitInterval(): void {
    if (waitInterval) {
      clearInterval(waitInterval)
      waitInterval = null
    }
  }
  /** 清理全部重启等待资源（计时器 + 重连上限 + 成功展示 + reconnectWatcher）。关闭/出错/超时统一调用。 */
  function clearRestartWait(): void {
    clearWaitInterval()
    if (waitTimeout) {
      clearTimeout(waitTimeout)
      waitTimeout = null
    }
    if (closeTimeout) {
      clearTimeout(closeTimeout)
      closeTimeout = null
    }
    reconnectWatcher?.cancel()
    reconnectWatcher = null
    isWaitingReconnect.value = false
  }
  /** sense.tools 返回的内置工具清单（缓存，SensesTab 下拉建议 + label/description 显示用）。失败置 []。 */
  const senseTools = ref<SenseToolInfo[]>([])
  /** sense.tools.docs 返回的内置工具完整说明文档（缓存，SensesTab hover 展示用；一次拉取按需取用）。失败置 []。 */
  const senseDocs = ref<SenseToolDocInfo[]>([])
  /** prompts.list 返回的 .chery/prompt/ 下 .md 路径清单（RolesTab/PresetsTab systemPrompt 级联选择器用）。每次打开重新拉。 */
  const prompts = ref<string[]>([])
  /** rules.list 返回的 .chery/rule/ 下 .yaml 文件名清单（PresetsTab 规则文件下拉用，排除 base.yaml）。每次打开重新拉。 */
  const rules = ref<string[]>([])
  /** env.list 返回的 .env 变量名列表（BrainsTab/MediaTab 密钥下拉选项）。每次打开重新拉。 */
  const envVars = ref<string[]>([])
  /** skills.list 第一页：仅作为 SkillsTab 首屏占位；角色装备使用轻量 skillNames 目录。 */
  const skills = ref<SkillInfo[]>([])
  /** plugins.list 返回的已安装插件：PluginsTab 列表 + RolesTab 插件组多选共用。每次打开重新拉。 */
  const plugins = ref<PluginInfo[]>([])
  /** skills.listSources 返回的 git 来源索引：SkillsTab 用。 */
  const skillSources = ref<SkillSource[]>([])
  /** skills.listNames 返回的全量名称列表：RolesTab TagSelect 下拉用（不算 token，轻量）。 */
  const skillNames = ref<{
    skills: string[]
    plugins: string[]
    skillTokens: Record<string, number>
    pluginTokens: Record<string, number>
  }>({ skills: [], plugins: [], skillTokens: {}, pluginTokens: {} })

  /**
   * Hooks 不属于 config.yaml，单独由设置外壳持有受控草稿。
   * HooksTab 可随 v-if 卸载；再次进入时仍读取这里的 handlers，不依赖子组件实例保活。
   */
  const hooksState = reactive<{
    handlers: Record<string, HookHandlerDTO[]>
    brainHooks: Record<string, Record<string, HookHandlerDTO[]>>
    eventMeta: HookEventMeta[]
    shellInfo: HooksShellInfo | null
    loading: boolean
    loaded: boolean
    dirty: boolean
  }>({
    handlers: {},
    brainHooks: {},
    eventMeta: [],
    shellInfo: null,
    loading: false,
    loaded: false,
    dirty: false,
  })
  let hooksLoadSeq = 0
  let hooksLoadPromise: Promise<void> | null = null

  function resetHooksState(): void {
    hooksLoadSeq += 1
    hooksLoadPromise = null
    hooksState.handlers = {}
    hooksState.brainHooks = {}
    hooksState.eventMeta = []
    hooksState.shellInfo = null
    hooksState.loading = false
    hooksState.loaded = false
    hooksState.dirty = false
  }

  /** Hooks 数据按需加载：只有第一次进入 Hooks Tab 才发 RPC。 */
  function loadHooksData(): Promise<void> {
    if (hooksState.loaded) return Promise.resolve()
    if (hooksLoadPromise) return hooksLoadPromise
    const seq = ++hooksLoadSeq
    hooksState.loading = true
    hooksLoadPromise = Promise.all([agentApi.getHooks(), agentApi.getHookEvents()])
      .then(([hooksData, eventMeta]) => {
        if (seq !== hooksLoadSeq) return
        hooksState.handlers = structuredClone(hooksData.handlers)
        hooksState.brainHooks = hooksData.brainHooks
        hooksState.shellInfo = hooksData.shellInfo ?? null
        hooksState.eventMeta = eventMeta
        hooksState.loaded = true
        hooksState.dirty = false
      })
      .catch((e: unknown) => {
        if (seq !== hooksLoadSeq) return
        error.value = (e as Error).message
        console.error('[SettingsDialog] getHooks failed:', e)
      })
      .finally(() => {
        if (seq !== hooksLoadSeq) return
        hooksState.loading = false
        hooksLoadPromise = null
      })
    return hooksLoadPromise
  }

  /** HooksTab 的受控更新入口；替换引用以便父级明确记录未保存修改。 */
  function updateHooksHandlers(handlers: Record<string, HookHandlerDTO[]>): void {
    hooksState.handlers = handlers
    hooksState.dirty = true
  }

  /** 等两个 animation frame：第一帧提交骨架，第二帧再开始目标页挂载。 */
  function waitForLoadingPaint(): Promise<void> {
    if (typeof requestAnimationFrame !== 'function') {
      return new Promise((resolve) => setTimeout(resolve, 16))
    }
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  }

  let tabRenderSeq = 0
  async function renderActiveTab(tab: TabKey): Promise<void> {
    const seq = ++tabRenderSeq
    renderedTab.value = null
    tabSwitching.value = true
    await nextTick()
    await waitForLoadingPaint()
    if (tab === 'hooks') await loadHooksData()
    if (seq !== tabRenderSeq) return
    renderedTab.value = tab
    tabSwitching.value = false
  }

  watch(activeTab, (tab) => {
    // 浏览器 overlay 关闭时只复位状态，不启动一次不可见的切换动画。
    if (!isNative.value && !agents.settingsOpen) {
      tabRenderSeq += 1
      renderedTab.value = tab
      tabSwitching.value = false
      return
    }
    void renderActiveTab(tab)
  })

  /** 打开设置时拉取全量数据（config + 工具/角色/规则/env/技能/插件清单）。
   *  浏览器路径每次打开调用；native 面挂载即调用（settingsOpen 永不翻转）。 */
  async function loadSettingsData(): Promise<void> {
    loading.value = true
    error.value = null
    savedHint.value = null
    savedWarnings.value = null
    workspaceWarnings.value = {}
    try {
      const data = await agentApi.getConfig()
      draft.value = structuredClone(data)
      // 打开设置时立即校验现有每个预设，避免历史无效路径要等编辑后才暴露。
      for (const [presetName, preset] of Object.entries(data.presets ?? {})) {
        validatePresetWorkspace(presetName, preset.workspace)
      }
    } catch (e) {
      error.value = (e as Error).message
      console.error('[SettingsDialog] getConfig failed:', e)
    }
    // 工具列表静态缓存：失败不阻塞编辑（下拉仍可自由输入）
    if (!senseTools.value.length) {
      try {
        senseTools.value = await agentApi.listSenseTools()
      } catch (e) {
        console.error('[SettingsDialog] listSenseTools failed:', e)
        senseTools.value = []
      }
    }
    // 工具完整说明文档静态缓存（全量一次拉取，hover 按需展示）：失败不阻塞编辑（hover 回退短描述）
    if (!senseDocs.value.length) {
      try {
        senseDocs.value = await agentApi.listSenseToolDocs()
      } catch (e) {
        console.error('[SettingsDialog] listSenseToolDocs failed:', e)
        senseDocs.value = []
      }
    }
    // prompts 列表：每次打开重新拉（磁盘文件可能变动），失败不阻塞编辑（级联框空选项 + placeholder）
    try {
      prompts.value = await agentApi.listPrompts()
    } catch (e) {
      console.error('[SettingsDialog] listPrompts failed:', e)
      prompts.value = []
    }
    // rules 列表：每次打开重新拉（磁盘文件可能变动），失败不阻塞编辑（下拉空选项 + placeholder）
    await refreshRules()
    // env 变量列表：每次打开重新拉（.env 可能变动），失败不阻塞编辑（密钥下拉空选项）
    try {
      envVars.value = await agentApi.listEnvVars()
    } catch (e) {
      console.error('[SettingsDialog] listEnvVars failed:', e)
      envVars.value = []
    }
    // skills / plugins 列表：每次打开重新拉（磁盘可能变动），SkillsTab/PluginsTab/RolesTab 共用
    await refreshSkills()
    await refreshPlugins()
    await refreshSkillSources()
    // config 与所有父级依赖均就绪后才揭示初始 Tab，避免空选项逐段跳入。
    loading.value = false
  }
  watch(
    () => agents.settingsOpen,
    async (open) => {
      // 原生设置窗由 loadNativeSettings 等待独立 renderer 的 WS 连通后再加载。
      // 浏览器设置改为按需挂载后，组件创建时 settingsOpen 已经为 true，必须立即执行本监听。
      if (isNative.value) return
      if (!open) {
        clearRestartWait()
        draft.value = null
        error.value = null
        savedHint.value = null
        savedWarnings.value = null
        workspaceWarnings.value = {}
        workspaceValidationSeq.clear()
        resetHooksState()
        tabRenderSeq += 1
        activeTab.value = 'presets'
        renderedTab.value = 'presets'
        tabSwitching.value = false
        rolesShadowMode.value = false
        return
      }
      if (agents.settingsSection) {
        activeTab.value = SETTINGS_TAB_BY_SECTION[agents.settingsSection]
        renderedTab.value = activeTab.value
      }
      await loadSettingsData()
    },
    { immediate: true },
  )
  /** 重新拉取审批规则文件清单（PresetsTab 审批规则下拉用；手动新建/Cherry Nexus 生成后触发）。 */
  async function refreshRules(): Promise<void> {
    try {
      rules.value = await agentApi.listRules()
    } catch (e) {
      console.error('[SettingsDialog] listRules failed:', e)
      rules.value = []
    }
  }
  /** 重新拉取技能列表（SkillsTab/RolesTab 共用；导入/删除后触发）。 */
  async function refreshSkills(): Promise<void> {
    try {
      skills.value = (await agentApi.listSkills({ page: 1, pageSize: 50 })).skills
    } catch (e) {
      console.error('[SettingsDialog] listSkills failed:', e)
      skills.value = []
    }
    // 轻量名称列表（RolesTab TagSelect 下拉用）
    try {
      skillNames.value = await agentApi.listSkillNames()
    } catch (e) {
      console.error('[SettingsDialog] listSkillNames failed:', e)
      skillNames.value = { skills: [], plugins: [], skillTokens: {}, pluginTokens: {} }
    }
  }
  /** 重新拉取 git 来源索引（SkillsTab 用）。 */
  async function refreshSkillSources(): Promise<void> {
    try {
      skillSources.value = await agentApi.listSkillSources()
    } catch (e) {
      console.error('[SettingsDialog] listSkillSources failed:', e)
      skillSources.value = []
    }
  }
  /** 重新拉取插件列表（PluginsTab/RolesTab 共用；导入/更新/卸载后触发）。 */
  async function refreshPlugins(): Promise<void> {
    try {
      plugins.value = await agentApi.listPlugins()
    } catch (e) {
      console.error('[SettingsDialog] listPlugins failed:', e)
      plugins.value = []
    }
  }
  function close(): void {
    if (isNative.value) {
      // 原生设置窗关闭由 main 进程统一处理（默认销毁；工作台窗才是 hide 保活）
      bridge?.windowControl('close')
      return
    }
    agents.settingsSection = null
    agents.settingsOpen = false
  }
  function onError(msg: string): void {
    error.value = msg || null
  }
  /**
   * 后端配置域前缀 → 设置 Tab 映射。保存失败错误串逐行解析后按此跳转对应 Tab，
   * 让用户直接看到出错字段所在的编辑位置（如 `presets.默认.workspace ...` → 📦 预设）。
   * 未知前缀（hooks / 未来新增字段）不映射、原样展示不可跳转。
   */
  const ERROR_TAB_BY_PREFIX: Record<string, TabKey> = {
    presets: 'presets',
    roles: 'roles',
    llm: 'brains',
    sense_groups: 'senses',
    media: 'media',
    mcp_servers: 'mcp',
    global: 'global',
    memory: 'global',
  }
  /** 单行错误 → 结构化条目：首段 `xxx.` 前缀命中映射时带 tab 信息（图标/名称取自 TABS）。 */
  interface ErrorLine {
    text: string
    tab?: { key: TabKey; icon: string; label: string }
  }
  function parseErrorLine(line: string): ErrorLine {
    const m = /^([a-z_]+)\./.exec(line)
    const key = m?.[1]
    const tabKey = key ? ERROR_TAB_BY_PREFIX[key] : undefined
    if (!tabKey) return { text: line }
    const tab = TABS.find((t) => t.key === tabKey)
    return tab
      ? { text: line, tab: { key: tab.key, icon: tab.icon, label: tab.label } }
      : { text: line }
  }
  /** 错误弹窗逐行条目（保存/加载失败共用）。 */
  const errorLines = computed<ErrorLine[]>(() =>
    (error.value ?? '')
      .split('\n')
      .filter((l) => l.trim())
      .map(parseErrorLine),
  )
  /** 点击错误行跳转对应 Tab。 */
  function gotoErrorTab(key: TabKey): void {
    activeTab.value = key
    error.value = null
  }
  function setWorkspaceWarning(presetName: string, warning?: string): void {
    const next = { ...workspaceWarnings.value }
    if (warning) next[presetName] = warning
    else delete next[presetName]
    workspaceWarnings.value = next
  }
  /**
   * 预设工作区输入变更后的即时只读校验。每项保留自己的请求序号，避免慢响应覆盖新输入结果。
   * 空值为「未限定」，无需请求后端且清除提示。
   */
  function validatePresetWorkspace(presetName: string, workspace: string | undefined): void {
    const seq = (workspaceValidationSeq.get(presetName) ?? 0) + 1
    workspaceValidationSeq.set(presetName, seq)
    setWorkspaceWarning(presetName)
    if (!workspace) return
    void agentApi.validateWorkspace(workspace).then(
      (result) => {
        if (workspaceValidationSeq.get(presetName) !== seq) return
        setWorkspaceWarning(presetName, result.valid ? undefined : (result.error ?? '工作区无效'))
      },
      (e) => {
        if (workspaceValidationSeq.get(presetName) !== seq) return
        setWorkspaceWarning(presetName, `无法校验工作区：${(e as Error).message}`)
      },
    )
  }
  async function save(): Promise<void> {
    if (!draft.value || saving.value) return
    saving.value = true
    error.value = null
    savedHint.value = null
    savedWarnings.value = null
    workspaceWarnings.value = {}
    clearRestartWait()
    try {
      sanitizeSenseGroups(draft.value)
      // 并行保存 config.yaml + hooks.json
      const savePromises: Promise<unknown>[] = [agentApi.saveConfig(draft.value)]
      const saveHooks = hooksState.dirty
      if (saveHooks) {
        // 过滤掉 command 为空的 handler（前端可能留空行）
        const cleaned: Record<string, HookHandlerDTO[]> = {}
        for (const [event, list] of Object.entries(hooksState.handlers)) {
          const valid = list.filter((h) => h.command?.trim())
          if (valid.length > 0) cleaned[event] = valid
        }
        // 空对象同样需要保存，表示用户删除了最后一个全局 Hook。
        savePromises.push(agentApi.saveHooks(cleaned))
      }
      // 在 worker 关闭前登记等待者，避免它已开始重启时漏掉这一次重连。
      reconnectWatcher = wsClient.watchNextReconnect()
      const results = await Promise.all(savePromises)
      if (saveHooks) hooksState.dirty = false
      const result = results[0] as
        | {
            needRestart: true
            restart: 'immediate' | 'scheduled' | 'manual'
            warnings?: string[]
          }
        | {
            needRestart: false
            restart: 'manual'
            validationErrors: string[]
            validationWarnings: string[]
            rollbackBackup: string
          }
      if (!result.needRestart) {
        // 重启前预检失败：后端已自动回滚到备份，未重启（避免坏配置 crash-loop）。
        reconnectWatcher?.cancel()
        reconnectWatcher = null
        error.value = `配置预检未通过，已自动回滚到 ${result.rollbackBackup}，未重启。\n${result.validationErrors.join('\n')}`
        clearRestartWait()
        return
      }
      if (result.restart === 'immediate') {
        savedHint.value = '服务正在更新…'
        isWaitingReconnect.value = true
        waitElapsed.value = 0
        waitInterval = setInterval(() => {
          waitElapsed.value += 1
        }, 1000)
        // 超时从保存后立即起算：到点仍重连未成功 → 隐藏提示条。
        waitTimeout = setTimeout(() => {
          clearRestartWait()
          savedHint.value = null
        }, RECONNECT_TIMEOUT_MS)
        const watcher = reconnectWatcher
        if (watcher) {
          // 重连成功：切文案、停计时器；清掉重连等待上限，起 5s 成功展示计时后隐藏。
          void watcher.promise.then(() => {
            clearWaitInterval()
            isWaitingReconnect.value = false
            savedHint.value = '✓ 已保存，服务已更新'
            if (waitTimeout) {
              clearTimeout(waitTimeout)
              waitTimeout = null
            }
            closeTimeout = setTimeout(() => {
              closeTimeout = null
              reconnectWatcher?.cancel()
              reconnectWatcher = null
              savedHint.value = null
            }, SUCCESS_HINT_TIMEOUT_MS)
          })
        }
      } else if (result.restart === 'scheduled') {
        reconnectWatcher?.cancel()
        reconnectWatcher = null
        savedHint.value = '✓ 已保存，将在当前任务完成后自动重启'
      } else {
        reconnectWatcher?.cancel()
        reconnectWatcher = null
        savedHint.value = '✓ 已保存，需重启后端生效'
      }
      // 软告警（如 $ENV 缺失变量）：已写盘并正常重启，不阻塞，仅提示。
      savedWarnings.value = result.warnings?.length ? result.warnings : null
    } catch (e) {
      const msg = (e as Error).message
      error.value = msg
      // 提取 workspace 校验告警按 presetName 分发到 PresetsTab 输入框下
      const warnings: Record<string, string> = {}
      for (const line of msg.split('\n')) {
        const m = /^presets\.([^.]+)\.workspace\s+"[^"]+"\s+(.+)$/.exec(line.trim())
        const presetName = m?.[1]
        const warning = m?.[2]
        if (presetName && warning) warnings[presetName] = warning
      }
      workspaceWarnings.value = warnings
      clearRestartWait()
      console.error('[SettingsDialog] saveConfig failed:', e)
    } finally {
      saving.value = false
    }
  }
  /**
   * native 面数据加载：settings 窗 renderer 的 WS 是独立异步建连（bootstrap() 在 App.vue onMounted
   * 才执行，而 SettingsDialog 作为子组件先挂载）——若挂载立即 RPC，`config.get` 会因 wsClient 未
   * connected 抛「还没连上服务器」。故等待 `connection.status === 'connected'` 后再拉数据。
   */
  let nativeConnectWatch: (() => void) | undefined
  let nativeSectionCleanup: (() => void) | undefined
  function loadNativeSettings(): void {
    if (!isNative.value) return
    if (connection.status === 'connected') {
      void loadSettingsData()
      nextTick(setupTabScroll)
      return
    }
    nativeConnectWatch = watch(
      () => connection.status,
      (status) => {
        if (status !== 'connected') return
        nativeConnectWatch?.()
        nativeConnectWatch = undefined
        void loadSettingsData()
        nextTick(setupTabScroll)
      },
    )
  }
  onMounted(() => {
    if (isNative.value) {
      nativeSectionCleanup = bridge?.onSettingsSection((section) => {
        activeTab.value = SETTINGS_TAB_BY_SECTION[section]
      })
    }
    // native 面：settingsOpen 永不翻转（窗开即挂载），等 WS 连接后拉数据 + 挂 tab 滚动；
    // 浏览器路径由 immediate watch(settingsOpen) 驱动，此处 no-op。
    loadNativeSettings()
  })
  onUnmounted(() => {
    nativeConnectWatch?.()
    nativeSectionCleanup?.()
    dragCleanup?.()
    clearRestartWait()
    teardownTabScroll()
  })
  /**
   * tab-bar 单行横向滚动控制。
   * arrow 用 flex 占位 + opacity 切换（非 v-if），布局恒定 → 显示/消失不挤压 tab，无抖动。
   * 滚动条隐藏，仅靠左右箭头滚动（点击滚约 3 个 tab 宽）。
   */
  const tabBarRef = ref<HTMLElement | null>(null)
  const canLeft = ref(false)
  const canRight = ref(false)
  const overflowed = ref(false)
  let tabResizeObserver: ResizeObserver | null = null
  /** 依据 scrollLeft/clientWidth/scrollWidth 刷新箭头可见性。 */
  function updateTabScrollState(): void {
    const el = tabBarRef.value
    if (!el) {
      overflowed.value = false
      canLeft.value = false
      canRight.value = false
      return
    }
    overflowed.value = el.scrollWidth - el.clientWidth > 1
    canLeft.value = el.scrollLeft > 1
    canRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1

    console.log('[tab-scroll]', {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollLeft: el.scrollLeft,
      overflowed: overflowed.value,
      canLeft: canLeft.value,
      canRight: canRight.value,
    })
  }
  /** 点击箭头滚动约 3 个 tab 宽（按平均 tab 宽估算）。dir: 1 右滚 / -1 左滚。 */
  function scrollTabBar(dir: 1 | -1): void {
    const el = tabBarRef.value
    if (!el) return
    const avgTab = el.scrollWidth / TABS.length
    el.scrollBy({ left: dir * Math.round(avgTab) * 3, behavior: 'smooth' })
  }
  /** dialog 打开后挂载：scroll 监听 + ResizeObserver（容器/tab 宽度变化时重算溢出）。 */
  function setupTabScroll(): void {
    const el = tabBarRef.value
    if (!el) return
    el.addEventListener('scroll', updateTabScrollState, { passive: true })
    tabResizeObserver = new ResizeObserver(updateTabScrollState)
    tabResizeObserver.observe(el)
    updateTabScrollState()
  }
  function teardownTabScroll(): void {
    const el = tabBarRef.value
    if (el) el.removeEventListener('scroll', updateTabScrollState)
    tabResizeObserver?.disconnect()
    tabResizeObserver = null
  }
  watch(
    () => agents.settingsOpen,
    (open) => {
      if (isNative.value) return
      if (open) nextTick(setupTabScroll)
      else teardownTabScroll()
    },
    { immediate: true },
  )
  /** 保存前清理：丢弃组内空工具名条目（与旧 textarea filter(Boolean) 行为一致）。 */
  function sanitizeSenseGroups(cfg: ConfigDto): void {
    if (!cfg.sense_groups) return
    for (const arr of Object.values(cfg.sense_groups)) {
      const cleaned = arr.filter((e) => {
        const idx = e.indexOf(':')
        const name = idx >= 0 ? e.slice(0, idx) : e
        return name.trim() !== ''
      })
      arr.length = 0
      arr.push(...cleaned)
    }
  }

  return {
    ArrowLeft,
    ArrowRight,
    BrainsTab,
    Close,
    CommandsTab,
    GlobalTab,
    HooksTab,
    McpTab,
    MediaTab,
    OVERLAY_Z_INDEX,
    OpenConfigDirButton,
    PluginsTab,
    PresetsTab,
    RolesTab,
    SensesTab,
    SkeletonTab,
    SkillsTab,
    TABS,
    activeTab,
    agents,
    canLeft,
    canRight,
    close,
    draft,
    dragging,
    envVars,
    error,
    errorLines,
    gotoErrorTab,
    hintLines,
    hooksState,
    indexCount,
    isNative,
    isWaitingReconnect,
    loading,
    maximized,
    onError,
    onTitlePointerDown,
    overflowed,
    panelStyles,
    plugins,
    prompts,
    ref,
    refreshPlugins,
    refreshRules,
    refreshSkillSources,
    refreshSkills,
    renderedTab,
    rolesShadowMode,
    rules,
    save,
    savedHint,
    savedWarnings,
    saving,
    scrollTabBar,
    senseDocs,
    senseTools,
    setPanelEl,
    settingsThemeStyle,
    skillNames,
    skillSources,
    skills,
    tabBarRef,
    tabSwitching,
    toggleMaximize,
    updateHooksHandlers,
    validatePresetWorkspace,
    waitElapsed,
    workspaceWarnings,
  }
}
