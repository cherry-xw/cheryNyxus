<script setup lang="ts">
/**
 * ConfirmDialog：重删二次确认居中 modal。
 * 用于后果重的删除（删预设/大脑/角色/技能来源/卸载插件）——需仪式感 + 影响范围说明。
 * 自定义 Teleport overlay（不包 el-dialog），承载霓虹描边 + 进场动画。
 * 轻删（感官组/单技能/MCP/媒体）继续用 ConfirmPopover 浮层。
 */
import { onBeforeUnmount, onMounted } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    icon?: string
    title: string
    /** 影响范围正文：单行字符串或多行数组（每项一段）。 */
    impact?: string | string[]
    confirmText?: string
    danger?: boolean
    /** 霓虹描边主色，默认品红；可传入当前 tab 主题色。 */
    tabColor?: string
  }>(),
  { icon: '⚠️', confirmText: '确认删除', danger: true, tabColor: '#d946ef' },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: []
  cancel: []
}>()

function close(): void {
  emit('update:modelValue', false)
  emit('cancel')
}
function onConfirm(): void {
  emit('confirm')
  emit('update:modelValue', false)
}
function onEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.modelValue) close()
}
onMounted(() => window.addEventListener('keydown', onEsc))
onBeforeUnmount(() => window.removeEventListener('keydown', onEsc))
</script>

<template>
  <Teleport to="body">
    <Transition name="confirm-fade">
      <div
        v-if="modelValue"
        class="confirm-overlay"
        :style="{ '--tab-color': tabColor }"
        @click.self="close"
      >
        <div class="confirm-dialog" :class="{ danger }" role="alertdialog" aria-modal="true">
          <div class="confirm-icon">{{ icon }}</div>
          <div class="confirm-body">
            <h3 class="confirm-title">{{ title }}</h3>
            <div v-if="impact" class="confirm-impact">
              <p v-for="(line, i) in Array.isArray(impact) ? impact : [impact]" :key="i">
                {{ line }}
              </p>
            </div>
          </div>
          <div class="confirm-actions">
            <button type="button" class="confirm-btn cancel" @click="close">取消</button>
            <button type="button" class="confirm-btn ok" @click="onConfirm">
              {{ confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped lang="less">
@import '@/features/agent/settings/config/shared.less';

.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 320;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(15, 17, 22, 0.5);
  backdrop-filter: blur(4px);
}
.confirm-dialog {
  width: min(420px, 92vw);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px 20px 16px;
  border-radius: 14px;
  .neon-glass();
  // .neon-border() 内用 fade() 编译期求值，无法吃 CSS 变量；用 color-mix 内联以适配运行时 --tab-color
  border: 1px solid color-mix(in srgb, var(--tab-color, #d946ef) 38%, transparent);
  box-shadow:
    0 0 8px color-mix(in srgb, var(--tab-color, #d946ef) 18%, transparent),
    inset 0 0 6px color-mix(in srgb, var(--tab-color, #d946ef) 8%, transparent);
  animation: dialog-neon-in 0.22s ease-out;
  &.danger {
    border-color: fade(#ef4444, 45%);
    box-shadow:
      0 0 14px fade(#ef4444, 22%),
      inset 0 0 8px fade(#ef4444, 8%);
  }
}
.confirm-icon {
  font-size: 28px;
  line-height: 1;
  text-align: center;
}
.confirm-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: center;
}
.confirm-title {
  margin: 0;
  font-size: 15px;
  font-weight: 800;
  color: fade(@ink, 90%);
  word-break: break-all;
  line-height: 1.4;
}
.confirm-impact {
  font-size: 12px;
  line-height: 1.6;
  color: fade(@ink, 62%);
  p {
    margin: 0;
    word-break: break-all;
  }
}
.confirm-actions {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 2px;
}
.confirm-btn {
  padding: 6px 18px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition:
    filter 0.15s ease,
    background-color 0.15s ease;
  &.cancel {
    border: 1px solid rgba(36, 38, 45, 0.18);
    background: rgba(255, 255, 255, 0.7);
    color: fade(@ink, 70%);
    &:hover {
      background: #fff;
    }
  }
  &.ok {
    border: none;
    background: linear-gradient(135deg, #ef4444, #b91c1c);
    color: #fff;
    box-shadow: 0 2px 8px rgba(185, 28, 28, 0.35);
    &:hover {
      filter: brightness(1.08);
    }
  }
}

.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity 0.18s ease;
}
.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}
</style>
