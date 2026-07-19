<script setup lang="ts">
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
import { computed, nextTick, onUnmounted, provide, readonly, ref, watch } from 'vue'
import { AnimatePresence, motion } from 'motion-v'
import { ArrowLeft, ArrowRight, Close, FolderOpened } from '@element-plus/icons-vue'
import { useAgentsStore, useConnectionStore } from '@/stores'
import {
  agentApi,
  type ConfigDto,
  type SenseToolInfo,
  type SkillInfo,
  type PluginInfo,
} from '@/services/agentApi'
import { wsClient } from '@/services/ws'
import { TABS, HINT_LINES, INDEX_COUNT, SETTINGS_ACTIVE_TAB_KEY, type TabKey } from './constants'
import BrainsTab from './tabs/BrainsTab.vue'
import MediaTab from './tabs/MediaTab.vue'
import SensesTab from './tabs/SensesTab.vue'
import RolesTab from './tabs/RolesTab.vue'
import PresetsTab from './tabs/PresetsTab.vue'
import McpTab from './tabs/McpTab.vue'
import GlobalTab from './tabs/GlobalTab.vue'
import CommandsTab from './tabs/CommandsTab.vue'
import SkillsTab from './tabs/SkillsTab.vue'
import type { SkillSource } from '@/services/agentApi'
import PluginsTab from './tabs/PluginsTab.vue'
import SkeletonTab from './tabs/SkeletonTab.vue'

const MotionDiv = motion.div
const agents = useAgentsStore()
const connection = useConnectionStore()

const draft = ref<ConfigDto | null>(null)
const activeTab = ref<TabKey>('presets')
provide(SETTINGS_ACTIVE_TAB_KEY, readonly(activeTab))
/** 当前激活 tab 的主题色：提升到 panel 根作为 --tab-color，让保存按钮/序号/卡片强调点/panel 背景/边框随 tab 整体变色。
 *  tab 按钮仍各自绑自己的 color（hover/active 显示对应 tab 色），与此处全局基调互不冲突。 */
const activeTabColor = computed(
  () => TABS.find((t) => t.key === activeTab.value)?.color ?? '#f6b73c',
)
/** 当前 tab 的 hints 段落拆分（sect + warn），渲染与真实 hints 像素级一致。 */
const hintLines = computed(() => HINT_LINES[activeTab.value] ?? { sect: 1, warn: 0 })
/** 当前 tab 序号按钮典型数（SkeletonTab 用，在 footer 左侧渲染导航占位）。 */
const indexCount = computed(() => INDEX_COUNT[activeTab.value] ?? 4)
const loading = ref(false)
const saving = ref(false)
const openingConfigDir = ref(false)
const error = ref<string | null>(null)
const savedHint = ref<string | null>(null)
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

/** prompts.list 返回的 .chery/prompt/ 下 .md 路径清单（RolesTab/PresetsTab systemPrompt 级联选择器用）。每次打开重新拉。 */
const prompts = ref<string[]>([])

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

watch(
  () => agents.settingsOpen,
  async (open) => {
    if (!open) {
      clearRestartWait()
      draft.value = null
      error.value = null
      savedHint.value = null
      workspaceWarnings.value = {}
      workspaceValidationSeq.clear()
      activeTab.value = 'presets'
      return
    }
    loading.value = true
    error.value = null
    savedHint.value = null
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
    } finally {
      loading.value = false
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
    // prompts 列表：每次打开重新拉（磁盘文件可能变动），失败不阻塞编辑（级联框空选项 + placeholder）
    try {
      prompts.value = await agentApi.listPrompts()
    } catch (e) {
      console.error('[SettingsDialog] listPrompts failed:', e)
      prompts.value = []
    }
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
  },
)

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
  agents.settingsOpen = false
}

/** 通过后端 RPC 打开后端主机的 .chery 配置目录。 */
async function openConfigDir(): Promise<void> {
  if (connection.status !== 'connected' || openingConfigDir.value) return
  openingConfigDir.value = true
  error.value = null
  try {
    await agentApi.openConfigDir()
  } catch (e) {
    error.value = (e as Error).message
    console.error('[SettingsDialog] openConfigDir failed:', e)
  } finally {
    openingConfigDir.value = false
  }
}

function onError(msg: string): void {
  error.value = msg || null
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
  workspaceWarnings.value = {}
  clearRestartWait()
  try {
    sanitizeSenseGroups(draft.value)
    // 在 worker 关闭前登记等待者，避免它已开始重启时漏掉这一次重连。
    reconnectWatcher = wsClient.watchNextReconnect()
    const result = await agentApi.saveConfig(draft.value)
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

onUnmounted(() => {
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
    if (open) nextTick(setupTabScroll)
    else teardownTabScroll()
  },
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
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="agents.settingsOpen"
      key="overlay"
      class="settings-overlay"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      :transition="{ duration: 0.16 }"
    >
      <MotionDiv
        key="panel"
        class="settings-panel"
        :style="{ '--tab-color': activeTabColor }"
        :initial="{ opacity: 0 }"
        :animate="{ opacity: 1 }"
        :exit="{ opacity: 0 }"
        :transition="{ duration: 0.18, ease: 'easeOut' }"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
      >
        <header class="head">
          <div class="title-row">
            <span class="title">设置</span>
            <el-tooltip content="打开配置文件夹" placement="top" :show-after="120">
              <span class="tooltip-trigger">
                <button
                  type="button"
                  class="icon-btn open-btn"
                  :disabled="connection.status !== 'connected' || openingConfigDir"
                  aria-label="打开配置文件夹"
                  @click="openConfigDir"
                >
                  <FolderOpened class="open-ico" />
                </button>
              </span>
            </el-tooltip>
          </div>
          <button type="button" class="close-btn" aria-label="关闭" @click="close">
            <Close class="close-ico" />
          </button>
        </header>

        <nav class="tab-bar-wrap">
          <button
            type="button"
            class="tab-arrow tab-arrow-left"
            :class="{ visible: overflowed && canLeft }"
            aria-label="向左滚动标签"
            :aria-hidden="!(overflowed && canLeft)"
            :tabindex="overflowed && canLeft ? 0 : -1"
            @click="scrollTabBar(-1)"
          >
            <ArrowLeft class="tab-arrow-ico" />
          </button>
          <div ref="tabBarRef" class="tab-bar">
            <button
              v-for="t in TABS"
              :key="t.key"
              type="button"
              class="tab"
              :class="{ active: activeTab === t.key }"
              :style="{ '--tab-color': t.color }"
              @click="activeTab = t.key"
            >
              <span class="tab-icon">{{ t.icon }}</span>
              <span class="tab-label">{{ t.label }}</span>
            </button>
          </div>
          <button
            type="button"
            class="tab-arrow tab-arrow-right"
            :class="{ visible: overflowed && canRight }"
            aria-label="向右滚动标签"
            :aria-hidden="!(overflowed && canRight)"
            :tabindex="overflowed && canRight ? 0 : -1"
            @click="scrollTabBar(1)"
          >
            <ArrowRight class="tab-arrow-ico" />
          </button>
        </nav>

        <div class="tab-body">
          <SkeletonTab
            v-if="loading"
            :sect-hints="hintLines.sect"
            :warn-hints="hintLines.warn"
            :index-count="indexCount"
          />
          <template v-else-if="draft">
            <BrainsTab
              v-show="activeTab === 'brains'"
              :draft="draft"
              :env-vars="envVars"
              @error="onError"
            />
            <MediaTab
              v-show="activeTab === 'media'"
              :draft="draft"
              :env-vars="envVars"
              @error="onError"
            />
            <SensesTab
              v-show="activeTab === 'senses'"
              :draft="draft"
              :sense-tools="senseTools"
              @error="onError"
            />
            <RolesTab
              v-show="activeTab === 'roles'"
              :draft="draft"
              :prompts="prompts"
              :skill-catalog="skillNames"
              @error="onError"
            />
            <PresetsTab
              v-show="activeTab === 'presets'"
              :draft="draft"
              :sense-tools="senseTools"
              :workspace-warnings="workspaceWarnings"
              @workspace-change="validatePresetWorkspace"
              @error="onError"
            />
            <McpTab v-show="activeTab === 'mcp'" :draft="draft" @error="onError" />
            <GlobalTab v-show="activeTab === 'global'" :draft="draft" />
            <CommandsTab v-show="activeTab === 'commands'" :draft="draft" @error="onError" />
            <SkillsTab
              v-show="activeTab === 'skills'"
              :initial-skills="skills"
              :sources="skillSources"
              @error="onError"
              @refresh-skills="
                () => {
                  refreshSkills()
                  refreshSkillSources()
                }
              "
            />
            <PluginsTab
              v-show="activeTab === 'plugins'"
              :plugins="plugins"
              @error="onError"
              @refresh-plugins="refreshPlugins"
            />
          </template>
        </div>

        <el-dialog
          :model-value="!!error"
          title="操作没有完成"
          width="520px"
          append-to-body
          @update:model-value="
            (open: boolean) => {
              if (!open) error = null
            }
          "
        >
          <pre class="settings-error-detail" role="alert">{{ error }}</pre>
          <template #footer
            ><button type="button" class="primary-btn" @click="error = null">
              知道了
            </button></template
          >
        </el-dialog>
        <div
          v-if="savedHint"
          class="saved-row"
          :class="{ waiting: isWaitingReconnect }"
          role="status"
        >
          <span class="saved-text">{{ savedHint }}</span>
          <span v-if="isWaitingReconnect" class="wait-elapsed">已等待 {{ waitElapsed }}s</span>
        </div>

        <footer class="foot">
          <div
            id="settings-footer-nav"
            class="foot-left"
            :style="{ '--tab-color': activeTabColor }"
            aria-live="polite"
          />
          <div class="foot-right">
            <button type="button" class="ghost-btn" @click="close">关闭</button>
            <button type="button" class="primary-btn" :disabled="!draft || saving" @click="save">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </footer>
      </MotionDiv>
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
@import './shared.less';

.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 310;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(15, 17, 22, 0.42);
  backdrop-filter: blur(2px);
}

.settings-panel {
  width: min(1040px, 96vw);
  height: min(760px, 92vh);
  padding: 14px 16px 12px;
  border-radius: 12px;
  background:
    radial-gradient(
      circle at 8% 18%,
      color-mix(in srgb, var(--tab-color, @accent) 15%, transparent),
      transparent 29%
    ),
    radial-gradient(
      circle at 88% 12%,
      color-mix(in srgb, var(--tab-color, @accent) 12%, transparent),
      transparent 27%
    ),
    radial-gradient(
      circle at 72% 88%,
      color-mix(in srgb, var(--tab-color, @accent) 11%, transparent),
      transparent 31%
    ),
    rgba(248, 248, 252, 0.96);
  border: 1px solid color-mix(in srgb, var(--tab-color, @accent) 28%, transparent);
  box-shadow:
    0 18px 36px rgba(0, 0, 0, 0.28),
    0 4px 8px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.settings-error-detail {
  margin: 0;
  max-height: 52vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font:
    12px/1.55 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  color: #991b1b;
  background: #fff3f3;
  border: 1px solid rgba(185, 28, 28, 0.18);
  border-radius: 8px;
  padding: 10px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  .title-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .title {
    font-size: 15px;
    font-weight: 800;
    color: fade(@ink, 88%);
  }
  .tooltip-trigger {
    display: inline-flex;
  }
  .open-btn {
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid rgba(36, 38, 45, 0.16);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.7);
    color: fade(@ink, 70%);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    &:hover:not(:disabled) {
      background: #ffffff;
      color: fade(@ink, 88%);
    }
    &:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
  }
  .open-ico {
    width: 14px;
    height: 14px;
  }
}

.close-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.7);
  color: fade(@ink, 70%);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  &:hover {
    background: #ffffff;
    color: fade(@ink, 88%);
  }
}
.close-ico {
  width: 12px;
  height: 12px;
}

.tab-bar-wrap {
  position: relative;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(36, 38, 45, 0.12);
}

.tab-bar {
  display: flex;
  flex-wrap: nowrap;
  gap: 4px;
  overflow-x: auto;
  // 隐藏横向滚动条，仅用左右箭头滚动（scrollbar-width: Firefox；::-webkit-scrollbar: Chromium）
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }
}

.tab-arrow {
  position: absolute;
  top: 0;
  // bottom = .tab-bar-wrap padding-bottom，让 arrow 拉伸对齐 tab-bar 全高；
  // icon 用 flex 居中 → 与 tab 自动水平对齐，不依赖固定高度
  bottom: 8px;
  z-index: 2;
  width: 22px;
  padding: 0;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 6px;
  background: rgba(251, 249, 244, 0.92);
  color: fade(@ink, 70%);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  // absolute 脱流 + opacity 切换 → 不占 flex 位、不改布局：tab 起点紧贴左边无偏移、显隐无抖动
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
  &.visible {
    opacity: 1;
    pointer-events: auto;
    &:hover {
      background: #ffffff;
      color: fade(@ink, 88%);
    }
  }
  &.tab-arrow-left {
    left: 0;
  }
  &.tab-arrow-right {
    right: 0;
  }
}
.tab-arrow-ico {
  width: 12px;
  height: 12px;
}

.tab {
  position: relative;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: fade(@ink, 78%);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  // 默认态轻显主题色（hover），非选中不发光；active 满色 + conic 转圈边框（签名克制）
  // 主题色统一混入 @ink 28% 提对比，避免浅色（金黄/青/翠绿）在淡底上对比度不足
  &:hover {
    color: color-mix(in srgb, var(--tab-color, @accent) 78%, @ink);
    background: color-mix(in srgb, var(--tab-color, @accent) 8%, transparent);
  }
  &.active {
    background: color-mix(in srgb, var(--tab-color, @accent) 12%, transparent);
    color: color-mix(in srgb, var(--tab-color, @accent) 72%, @ink);
    font-weight: 700;
    box-shadow: 0 0 12px color-mix(in srgb, var(--tab-color, @accent) 28%, transparent);
    // conic 转圈边框：伪元素 mask 镂空，只让 1px 边框显 conic 渐变并旋转
    &::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: 1px;
      background: conic-gradient(
        from var(--neon-angle, 0deg),
        var(--tab-color, @accent),
        transparent 28%,
        var(--tab-color, @accent) 55%,
        transparent 82%
      );
      -webkit-mask:
        linear-gradient(#000 0 0) content-box,
        linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      animation: neon-spin-border 3s linear infinite;
      pointer-events: none;
    }
  }
  .tab-icon {
    font-size: 13px;
  }
}

.tab-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  // 滚动交给各 tab 内部的 TabShell.shell-scroll；本层只做容器。
}

.error-row {
  padding: 6px 8px;
  border-radius: 6px;
  background: #fee2e2;
  color: #991b1b;
  font-size: 11px;
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;
}

.saved-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: #dcfce7;
  color: #166534;
  font-size: 11px;
  &.waiting {
    background: #fdf6ec;
    color: #e6a23c;
  }
}

.wait-elapsed {
  color: #c9933e;
  font-variant-numeric: tabular-nums;
}

.foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid rgba(36, 38, 45, 0.1);
}

.foot-left {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 24px;
  display: flex;
  align-items: center;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }
}

.foot-right {
  display: flex;
  gap: 8px;
}

.ghost-btn {
  padding: 6px 12px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.7);
  color: fade(@ink, 80%);
  font-size: 12px;
  cursor: pointer;
  &:hover:not(:disabled) {
    background: #ffffff;
    color: fade(@ink, 92%);
  }
  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.primary-btn {
  padding: 6px 18px;
  border: none;
  border-radius: 6px;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--tab-color, @accent) 72%, #fff),
    var(--tab-color, @accent)
  );
  color: #3b2b12;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}
</style>
