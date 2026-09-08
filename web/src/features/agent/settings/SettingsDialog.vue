<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { gsap } from 'gsap'
import {
  useSettingsDialogController,
  type SettingsDialogControllerProps,
} from './useSettingsDialogController'
import { useOverlayTransitionHooks } from '@/composables/useOverlayAnimation'
import ConfigApplyStatus from './components/ConfigApplyStatus.vue'
import { useMotionPreference, type MotionPreference } from '@/composables/useMotionPreference'
import type { TabKey } from './config/constants'
import { MOTION } from '@/utils/gsapCore'
const props = defineProps<SettingsDialogControllerProps>()
const controller = useSettingsDialogController(props)
defineExpose({ confirmClose: controller.confirmClose, close: controller.close })
const settingsMotion = useOverlayTransitionHooks('dialog')
const { preference: motionPreference, effectiveMode, setMotionPreference } = useMotionPreference()
const motionOptions: ReadonlyArray<{ value: MotionPreference; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'full', label: '完整' },
  { value: 'reduced', label: '精简' },
]
const {
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
  destructivePreview,
  dragging,
  envVars,
  error,
  errorLines,
  externalChange,
  gotoErrorTab,
  hintLines,
  hooksState,
  hasUnsavedChanges,
  indexCount,
  isEmbedded,
  isNative,
  isShellless,
  loading,
  maximized,
  onError,
  onTitlePointerDown,
  overflowed,
  panelStyles,
  plugins,
  prompts,
  refreshPlugins,
  refreshRules,
  refreshSkillSources,
  refreshSkills,
  reloadServerVersion,
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
  workspaceWarnings,
} = controller

const animatedTabButtons = new Set<HTMLElement>()

function selectTab(key: TabKey, event: MouseEvent): void {
  activeTab.value = key
  if (effectiveMode.value === 'reduced') return
  const button = event.currentTarget
  if (!(button instanceof HTMLElement)) return
  animatedTabButtons.add(button)
  gsap.killTweensOf(button)
  gsap.fromTo(
    button,
    { y: 2, scale: 0.97 },
    {
      y: 0,
      scale: 1,
      duration: MOTION.control,
      ease: MOTION.easeAgent,
      clearProps: 'transform',
      onComplete: () => animatedTabButtons.delete(button),
    },
  )
}

function onTabKeydown(event: KeyboardEvent, key: TabKey): void {
  const index = TABS.findIndex((tab) => tab.key === key)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? TABS.length - 1
        : event.key === 'ArrowRight'
          ? (index + 1) % TABS.length
          : event.key === 'ArrowLeft'
            ? (index - 1 + TABS.length) % TABS.length
            : -1
  if (next < 0) return
  event.preventDefault()
  activeTab.value = TABS[next]!.key
  tabBarRef.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
}

onBeforeUnmount(() => {
  gsap.killTweensOf([...animatedTabButtons])
  animatedTabButtons.clear()
})
</script>

<template>
  <Transition
    :css="false"
    @before-enter="settingsMotion.onBeforeEnter"
    @enter="settingsMotion.onEnter"
    @leave="settingsMotion.onLeave"
    @enter-cancelled="settingsMotion.onEnterCancelled"
    @leave-cancelled="settingsMotion.onLeaveCancelled"
  >
    <div
      v-if="isNative || agents.settingsOpen"
      key="overlay"
      class="settings-overlay"
      :class="{ 'is-native': isNative, 'is-embedded': isEmbedded }"
      :style="{ zIndex: OVERLAY_Z_INDEX.modal }"
    >
      <div
        key="panel"
        :ref="setPanelEl"
        class="settings-panel"
        :class="{
          'is-maximized': maximized,
          'is-dragging': dragging,
          'is-native': isNative,
          'is-embedded': isEmbedded,
        }"
        :style="panelStyles"
        role="dialog"
        :aria-modal="isShellless ? undefined : true"
        aria-label="设置"
      >
        <header v-if="!isShellless" class="head" @pointerdown="onTitlePointerDown">
          <div class="title-row">
            <span class="title">设置</span>
            <OpenConfigDirButton @error="onError" />
          </div>
          <div class="head-actions">
            <button
              type="button"
              class="close-btn"
              :aria-label="maximized ? '还原设置窗口' : '最大化设置窗口'"
              :title="maximized ? '还原' : '最大化'"
              @click="toggleMaximize"
            >
              <span class="mx-glyph" :class="{ restore: maximized }" aria-hidden="true" />
            </button>
            <button type="button" class="close-btn" aria-label="关闭" @click="close">
              <Close class="close-ico" />
            </button>
          </div>
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
          <div ref="tabBarRef" class="tab-bar" role="tablist" aria-label="设置分类">
            <button
              v-for="t in TABS"
              :id="`settings-tab-${t.key}`"
              :key="t.key"
              type="button"
              class="tab"
              :class="{ active: activeTab === t.key }"
              role="tab"
              :aria-selected="activeTab === t.key"
              aria-controls="settings-tab-panel"
              :tabindex="activeTab === t.key ? 0 : -1"
              @click="selectTab(t.key, $event)"
              @keydown="onTabKeydown($event, t.key)"
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

        <div
          id="settings-tab-panel"
          class="tab-body"
          role="tabpanel"
          :aria-labelledby="`settings-tab-${activeTab}`"
          :aria-busy="loading || tabSwitching"
        >
          <SkeletonTab
            v-if="loading || tabSwitching"
            :sect-hints="hintLines.sect"
            :warn-hints="hintLines.warn"
            :index-count="indexCount"
          />
          <template v-else-if="draft">
            <!--
              每次只挂载当前 Tab。可编辑配置统一写入父级 draft；Hooks 的独立草稿
              也由父级 hooksState 持有，因此卸载子页不会丢失未保存的数据。
            -->
            <div v-if="renderedTab === 'brains'" class="tab-pane">
              <BrainsTab :draft="draft" :env-vars="envVars" @error="onError" />
            </div>
            <div v-else-if="renderedTab === 'media'" class="tab-pane">
              <MediaTab :draft="draft" :env-vars="envVars" @error="onError" />
            </div>
            <div v-else-if="renderedTab === 'senses'" class="tab-pane">
              <SensesTab
                :draft="draft"
                :sense-tools="senseTools"
                :sense-docs="senseDocs"
                @error="onError"
              />
            </div>
            <div v-else-if="renderedTab === 'roles'" class="tab-pane">
              <RolesTab
                :draft="draft"
                :prompts="prompts"
                :skill-catalog="skillNames"
                @mode-change="(mode) => (rolesShadowMode = mode === 'shadow')"
                @error="onError"
              />
            </div>
            <div v-else-if="renderedTab === 'presets'" class="tab-pane">
              <PresetsTab
                :draft="draft"
                :sense-tools="senseTools"
                :rules="rules"
                :workspace-warnings="workspaceWarnings"
                @workspace-change="validatePresetWorkspace"
                @refresh-rules="refreshRules"
                @error="onError"
              />
            </div>
            <div v-else-if="renderedTab === 'mcp'" class="tab-pane">
              <McpTab :draft="draft" @error="onError" />
            </div>
            <div v-else-if="renderedTab === 'global'" class="tab-pane">
              <GlobalTab :draft="draft" />
            </div>
            <div v-else-if="renderedTab === 'commands'" class="tab-pane">
              <CommandsTab :draft="draft" @error="onError" />
            </div>
            <div v-else-if="renderedTab === 'hooks'" class="tab-pane">
              <HooksTab
                :handlers="hooksState.handlers"
                :brain-hooks="hooksState.brainHooks"
                :event-meta="hooksState.eventMeta"
                :shell-info="hooksState.shellInfo"
                :loading="hooksState.loading"
                @update:handlers="updateHooksHandlers"
                @error="onError"
              />
            </div>
            <div v-else-if="renderedTab === 'skills'" class="tab-pane">
              <SkillsTab
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
            </div>
            <div v-else-if="renderedTab === 'plugins'" class="tab-pane">
              <PluginsTab :plugins="plugins" @error="onError" @refresh-plugins="refreshPlugins" />
            </div>
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
          <div class="settings-error-detail" role="alert">
            <div v-for="(line, i) in errorLines" :key="i" class="error-line">
              <span v-if="line.tab" class="error-tab-badge">
                {{ line.tab.icon }} {{ line.tab.label }}
              </span>
              <span class="error-text">{{ line.text }}</span>
              <button
                v-if="line.tab"
                type="button"
                class="error-jump-btn"
                :title="`前往「${line.tab.label}」Tab 修正`"
                @click="gotoErrorTab(line.tab.key)"
              >
                前往 →
              </button>
            </div>
          </div>
          <template #footer>
            <div class="error-footer">
              <OpenConfigDirButton variant="ghost" @error="onError" />
              <button type="button" class="primary-btn" @click="error = null">知道了</button>
            </div>
          </template>
        </el-dialog>
        <div v-if="externalChange" class="external-change" role="alert">
          <span
            >其他窗口或外部程序保存了新设置。当前未保存草稿仍保留，继续保存会被拒绝，以免覆盖新值。</span
          >
          <el-popconfirm
            title="重新载入会放弃此窗口内尚未保存的配置和 Hooks 草稿。"
            confirm-button-text="放弃草稿并载入"
            cancel-button-text="保留草稿"
            :width="300"
            @confirm="reloadServerVersion"
          >
            <template #reference>
              <button type="button" class="ghost-btn" :disabled="saving || loading">
                重新载入服务器版本
              </button>
            </template>
          </el-popconfirm>
        </div>
        <div v-if="savedHint" class="saved-row" role="status">
          <span class="saved-text">{{ savedHint }}</span>
        </div>
        <div v-if="savedWarnings?.length" class="saved-row saved-warnings-row" role="status">
          <span class="saved-text"
            >⚠️ 已保存，但存在软告警（不阻塞运行，相关功能使用时可能报错）：</span
          >
          <ul class="saved-warnings">
            <li v-for="w in savedWarnings" :key="w">{{ w }}</li>
          </ul>
        </div>

        <ConfigApplyStatus :preview="destructivePreview" />
        <footer class="foot">
          <div class="motion-preference" role="group" aria-label="界面动效强度">
            <span class="motion-preference-label">动效</span>
            <button
              v-for="option in motionOptions"
              :key="option.value"
              type="button"
              :class="{ active: motionPreference === option.value }"
              :aria-pressed="motionPreference === option.value"
              @click="setMotionPreference(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
          <div
            id="settings-footer-nav"
            class="foot-left"
            :style="settingsThemeStyle"
            aria-live="polite"
          />
          <div class="foot-right">
            <span v-if="hasUnsavedChanges" role="status">有未保存修改</span>
            <button
              type="button"
              class="primary-btn"
              :disabled="!draft || saving || loading"
              @click="save"
            >
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="less" src="./SettingsDialog.styles.less"></style>
