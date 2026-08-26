<script setup lang="ts">
import { useSettingsDialogController, type SettingsDialogControllerProps } from './useSettingsDialogController'
const props = defineProps<SettingsDialogControllerProps>()
const controller = useSettingsDialogController(props)
const {
  AnimatePresence, ArrowLeft, ArrowRight, BrainsTab, Close, CommandsTab, GlobalTab, HooksTab,
  McpTab, MediaTab, MotionDiv, OVERLAY_Z_INDEX, OpenConfigDirButton, PluginsTab, PresetsTab,
  RolesTab, SensesTab, SkeletonTab, SkillsTab, TABS, activeTab, agents, canLeft, canRight, close,
  draft, dragging, envVars, error, errorLines, gotoErrorTab, hintLines, hooksTabRef, indexCount,
  isNative, isWaitingReconnect, loading, maximized, onError, onTitlePointerDown, overflowed,
  panelStyles, plugins, prompts, ref, refreshPlugins, refreshRules, refreshSkillSources,
  refreshSkills, rolesShadowMode, rules, save, savedHint, savedWarnings, saving, scrollTabBar,
  senseDocs, senseTools, setPanelEl, settingsThemeStyle, skillNames, skillSources, skills,
  tabBarRef, toggleMaximize, validatePresetWorkspace, waitElapsed, workspaceWarnings,
} = controller
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="isNative || agents.settingsOpen"
      key="overlay"
      class="settings-overlay"
      :class="{ 'is-native': isNative }"
      :style="{ zIndex: OVERLAY_Z_INDEX.modal }"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      :transition="{ duration: 0.16 }"
    >
      <MotionDiv
        key="panel"
        :ref="setPanelEl"
        class="settings-panel"
        :class="{ 'is-maximized': maximized, 'is-dragging': dragging, 'is-native': isNative }"
        :style="panelStyles"
        :initial="{ opacity: 0 }"
        :animate="{ opacity: 1 }"
        :exit="{ opacity: 0 }"
        :transition="{ duration: 0.18, ease: 'easeOut' }"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
      >
        <header v-if="!isNative" class="head" @pointerdown="onTitlePointerDown">
          <div class="title-row">
            <span class="title">设置</span>
            <OpenConfigDirButton @error="onError" />
          </div>
          <div v-if="!isNative" class="head-actions">
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
              :sense-docs="senseDocs"
              @error="onError"
            />
            <RolesTab
              v-show="activeTab === 'roles'"
              :draft="draft"
              :prompts="prompts"
              :skill-catalog="skillNames"
              @mode-change="(mode) => (rolesShadowMode = mode === 'shadow')"
              @error="onError"
            />
            <PresetsTab
              v-show="activeTab === 'presets'"
              :draft="draft"
              :sense-tools="senseTools"
              :rules="rules"
              :workspace-warnings="workspaceWarnings"
              @workspace-change="validatePresetWorkspace"
              @refresh-rules="refreshRules"
              @error="onError"
            />
            <McpTab v-show="activeTab === 'mcp'" :draft="draft" @error="onError" />
            <GlobalTab v-show="activeTab === 'global'" :draft="draft" />
            <CommandsTab v-show="activeTab === 'commands'" :draft="draft" @error="onError" />
            <HooksTab
              ref="hooksTabRef"
              v-show="activeTab === 'hooks'"
              @error="onError"
            />
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
        <div
          v-if="savedHint"
          class="saved-row"
          :class="{ waiting: isWaitingReconnect }"
          role="status"
        >
          <span class="saved-text">{{ savedHint }}</span>
          <span v-if="isWaitingReconnect" class="wait-elapsed">已等待 {{ waitElapsed }}s</span>
        </div>
        <div v-if="savedWarnings?.length" class="saved-row saved-warnings-row" role="status">
          <span class="saved-text"
            >⚠️ 已保存，但存在软告警（不阻塞运行，相关功能使用时可能报错）：</span
          >
          <ul class="saved-warnings">
            <li v-for="w in savedWarnings" :key="w">{{ w }}</li>
          </ul>
        </div>

        <footer class="foot">
          <div
            id="settings-footer-nav"
            class="foot-left"
            :style="settingsThemeStyle"
            aria-live="polite"
          />
          <div class="foot-right">
            <button type="button" class="primary-btn" :disabled="!draft || saving" @click="save">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </footer>
      </MotionDiv>
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less" src="./SettingsDialog.styles.less"></style>
