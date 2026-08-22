<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  CAREER_AVATARS,
  ROLE_AVATAR_POOL,
  defaultRoleAvatar,
  validateRoleAvatar,
} from '../../config/roleAvatar'

const props = defineProps<{ modelValue?: string; roleType: string; disabled?: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: string | undefined): void
  (e: 'error', value: string): void
}>()
const open = ref(false)
const custom = ref('')
const resolved = computed(() => props.modelValue || defaultRoleAvatar(props.roleType))

function choose(value?: string): void {
  if (props.disabled) return
  emit('update:modelValue', value)
  open.value = false
}
function applyCustom(): void {
  const error = validateRoleAvatar(custom.value)
  if (error) {
    emit('error', error)
    return
  }
  choose(custom.value.trim())
  custom.value = ''
}
</script>

<template>
  <el-popover
    v-model:visible="open"
    :trigger="disabled ? 'manual' : 'click'"
    placement="bottom-start"
    :width="310"
    popper-class="avatar-picker-popper"
  >
    <template #reference>
      <button
        type="button"
        class="avatar-picker-trigger"
        :disabled="disabled"
        :aria-label="disabled ? '角色头像已锁定' : '切换角色头像'"
      >
        <span>{{ resolved }}</span
        ><small>{{ disabled ? '身份锁定' : '切换头像' }}</small>
      </button>
    </template>
    <div class="avatar-picker">
      <div class="avatar-group-title">职业徽记</div>
      <div class="avatar-grid">
        <button
          v-for="avatar in CAREER_AVATARS"
          :key="avatar"
          type="button"
          :class="{ active: modelValue === avatar }"
          @click="choose(avatar)"
        >
          {{ avatar }}
        </button>
      </div>
      <div class="avatar-group-title">宠物与常用 Emoji</div>
      <div class="avatar-grid">
        <button
          v-for="avatar in ROLE_AVATAR_POOL"
          :key="avatar"
          type="button"
          :class="{ active: resolved === avatar }"
          @click="choose(avatar)"
        >
          {{ avatar }}
        </button>
      </div>
      <div class="avatar-custom">
        <el-input
          v-model="custom"
          size="small"
          maxlength="24"
          placeholder="粘贴一个 Emoji"
          @keydown.enter="applyCustom"
        />
        <button type="button" class="ghost-btn" @click="applyCustom">使用</button>
      </div>
      <button type="button" class="avatar-reset" @click="choose(undefined)">
        恢复按角色名生成的默认头像
      </button>
    </div>
  </el-popover>
</template>

<style scoped lang="less">
@import '../../config/shared.less';
.avatar-picker-trigger {
  width: 88px;
  min-height: 76px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid color-mix(in srgb, var(--tab-color, @accent) 35%, transparent);
  border-radius: 14px;
  background: linear-gradient(
    145deg,
    var(--surface-hover),
    color-mix(in srgb, var(--surface-hover) 90%, var(--panel))
  );
  cursor: pointer;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--ink) 9%, transparent);
}
.avatar-picker-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.78;
}
.avatar-picker-trigger span {
  font-size: 34px;
  transition: transform 0.18s ease;
}
.avatar-picker-trigger:hover span {
  transform: rotate(-6deg) scale(1.1);
}
.avatar-picker-trigger small {
  font-size: 9px;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
}
.avatar-picker {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.avatar-group-title {
  font-size: 10px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 70%, transparent);
}
.avatar-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 4px;
}
.avatar-grid button {
  height: 30px;
  border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  border-radius: 7px;
  background: var(--surface);
  font-size: 18px;
  cursor: pointer;
}
.avatar-grid button:hover,
.avatar-grid button.active {
  border-color: var(--tab-color, @accent);
  background: color-mix(in srgb, var(--tab-color, @accent) 14%, transparent);
  transform: translateY(-1px);
}
.avatar-custom {
  display: flex;
  gap: 5px;
}
.avatar-reset {
  border: 0;
  background: transparent;
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
  font-size: 10px;
  cursor: pointer;
  text-align: left;
  padding: 0;
}
</style>
