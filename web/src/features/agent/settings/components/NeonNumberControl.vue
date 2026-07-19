<script setup lang="ts">
import { nextTick, ref } from "vue";

const props = withDefaults(defineProps<{
  modelValue?: number;
  label: string;
  tip?: string;
  placeholder?: string;
  unit?: string;
  step?: number;
  min?: number;
}>(), { tip: "", placeholder: "默认", unit: "", step: 1, min: Number.NEGATIVE_INFINITY });
const emit = defineEmits<{ (e: "update:modelValue", value: number | undefined): void }>();
const editing = ref(false);
const draft = ref("");
const inputRef = ref<HTMLInputElement | null>(null);

function change(delta: number): void {
  const base = props.modelValue ?? 0;
  emit("update:modelValue", Math.max(props.min, base + delta));
}
function startEdit(): void {
  draft.value = props.modelValue === undefined ? "" : String(props.modelValue);
  editing.value = true;
  nextTick(() => { inputRef.value?.focus(); inputRef.value?.select(); });
}
function commit(): void {
  const text = draft.value.trim();
  if (!text) emit("update:modelValue", undefined);
  else {
    const value = Number(text);
    if (Number.isFinite(value)) emit("update:modelValue", Math.max(props.min, value));
  }
  editing.value = false;
}
</script>

<template>
  <div class="neon-number" :title="tip">
    <span class="neon-number-label">{{ label }}</span>
    <div class="neon-number-console">
      <button type="button" aria-label="减少" @click="change(-step)">−</button>
      <input v-if="editing" ref="inputRef" v-model="draft" inputmode="decimal" @blur="commit" @keydown.enter="commit" @keydown.esc="editing = false" />
      <button v-else type="button" class="number-readout" @click="startEdit">
        <b>{{ modelValue ?? placeholder }}</b><small v-if="modelValue !== undefined && unit">{{ unit }}</small>
      </button>
      <button type="button" aria-label="增加" @click="change(step)">＋</button>
    </div>
  </div>
</template>

<style scoped lang="less">
@import "../shared.less";
.neon-number{min-width:0;display:flex;flex-direction:column;gap:3px}.neon-number-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:13px;font-weight:800;color:fade(@ink,54%)}.neon-number-console{height:29px;display:grid;grid-template-columns:25px minmax(0,1fr) 25px;border:1px solid rgba(99,102,241,.17);border-radius:8px;background:rgba(255,255,255,.66);overflow:hidden}.neon-number-console>button{border:0;background:transparent;color:#6366f1;cursor:pointer}.neon-number-console>button:first-child{border-right:1px solid rgba(99,102,241,.1)}.neon-number-console>button:last-child{border-left:1px solid rgba(99,102,241,.1)}.neon-number-console>button:hover{background:rgba(99,102,241,.09);text-shadow:0 0 7px rgba(99,102,241,.5)}.number-readout{display:flex;align-items:center;justify-content:center;gap:3px;color:fade(@ink,76%)!important;line-height:1}.number-readout b{max-width:100%;overflow:hidden;text-overflow:ellipsis;font:700 11px/1.2 ui-monospace,SFMono-Regular,monospace}.number-readout small{font-size:9px;line-height:1.2;color:fade(@ink,40%)}.neon-number-console input{min-width:0;width:100%;height:100%;padding:0 4px;box-sizing:border-box;border:0;outline:0;background:rgba(238,242,255,.78);text-align:center;font:700 11px/1.2 ui-monospace,SFMono-Regular,monospace;color:#4338ca;box-shadow:inset 0 0 8px rgba(99,102,241,.09)}
</style>
