<script setup lang="ts">
import { computed } from 'vue'
import type { BrainCapabilitiesDto } from '@/application/backend/public'
import LabelTip from '../config/LabelTip.vue'

type ImageInput = NonNullable<BrainCapabilitiesDto['imageInput']>
const props = defineProps<{ modelValue?: BrainCapabilitiesDto; inherited?: ImageInput; catalogStatus?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: BrainCapabilitiesDto] }>()
const formats = [
  { value: 'image/jpeg', label: 'JPEG' },
  { value: 'image/png', label: 'PNG' },
  { value: 'image/webp', label: 'WebP' },
  { value: 'image/gif', label: 'GIF' },
] as const
const byteLimits = [
  {
    key: 'maxBytes',
    label: '单图原始大小上限（字节）',
    tip: '模型服务允许的单张图片原始字节上限。留空继承目录，不改变原始文件。',
  },
  {
    key: 'maxBase64Bytes',
    label: '单图 Base64 大小上限（字节）',
    tip: '图片转为 Base64 后的单图字节上限，与原始文件大小不同。留空继承目录。',
  },
] as const
const customFormats = computed(() => props.modelValue?.imageInput?.formats !== undefined)

function change<K extends keyof ImageInput>(key: K, value: ImageInput[K]): void {
  const imageInput = { ...props.modelValue?.imageInput }
  if (value === undefined) delete imageInput[key]
  else imageInput[key] = value
  const caps = { ...props.modelValue }
  if (Object.keys(imageInput).length) caps.imageInput = imageInput
  else delete caps.imageInput
  emit('update:modelValue', caps)
}
</script>

<template>
  <section class="brain-section brain-capability-section" aria-label="模型原生图片格式与限制">
    <header class="section-heading">
      <h3>
        <LabelTip
          label="模型原生图片格式与限制"
          tip="未手动设置的字段继承模型目录。未知模型需按实际服务声明，不能从协议推断支持情况。修改只影响草稿，统一保存后生效。"
        />
      </h3>
    </header>
    <div class="capability-content">
      <div class="brain-fields">
        <div class="field">
          <LabelTip
            label="动画处理"
            tip="继承目录且无目录记录时为未知。只读取首帧不等于完整理解动画，不会因此自动携带动图；完整动画支持需服务明确保证。"
          />
          <el-select
            :model-value="modelValue?.imageInput?.animation ?? ''"
            aria-label="动画处理"
            @update:model-value="
              (value: ImageInput['animation'] | '') => change('animation', value || undefined)
            "
          >
            <el-option value="" :label="`继承：${inherited?.animation ?? (catalogStatus === 'ready' ? '未知' : catalogStatus === 'error' ? '目录读取失败' : '目录读取中')}`" />
            <el-option value="unknown" label="未知" />
            <el-option value="unsupported" label="不支持" />
            <el-option value="first-frame" label="只读取首帧" />
            <el-option value="supported" label="完整动画支持" />
          </el-select>
        </div>
        <div class="field field-wide">
          <div class="capability-group-heading">
            <LabelTip
              label="图片格式"
              tip="未勾选时继承目录格式。勾选后只使用下方选中的格式；全部不选表示明确不接收这些图片格式，不是继承。"
            />
            <el-checkbox
              :model-value="customFormats"
              @update:model-value="
                (value: unknown) => change('formats', value === true ? [...(inherited?.formats ?? [])] : undefined)
              "
              >手动设置格式</el-checkbox
            >
          </div>
          <el-checkbox-group
            v-if="customFormats"
            :model-value="modelValue?.imageInput?.formats ?? []"
            class="capability-formats"
            aria-label="接受的图片格式"
            @update:model-value="
              (value: unknown) => change('formats', value as ImageInput['formats'])
            "
          >
            <el-checkbox v-for="format in formats" :key="format.value" :value="format.value">{{
              format.label
            }}</el-checkbox>
          </el-checkbox-group>
          <p v-else class="capability-note">{{ catalogStatus !== 'ready' ? '目录尚未取得，不能确认继承格式。' : inherited?.formats ? `目录格式：${inherited.formats.join('、') || '不接收图片'}` : '目录未声明图片格式，不能假定支持。' }}</p>
        </div>
        <div v-for="limit in byteLimits" :key="limit.key" class="field">
          <LabelTip :label="limit.label" :tip="limit.tip" />
          <el-input-number
            :model-value="modelValue?.imageInput?.[limit.key]"
            :min="1"
            :step="1"
            :controls="false"
            :aria-label="limit.label"
            :placeholder="inherited?.[limit.key] !== undefined ? `${inherited[limit.key]} · 目录` : catalogStatus === 'ready' ? '不增加额外限制' : '目录尚未取得'"
            @update:model-value="
              (value: number | undefined | null) => change(limit.key, value ?? undefined)
            "
          />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="less">
@import './brainSections.less';
</style>
