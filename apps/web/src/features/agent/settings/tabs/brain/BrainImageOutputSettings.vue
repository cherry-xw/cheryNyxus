<script setup lang="ts">
import { computed, useId } from 'vue'
import {
  isImageOutputOperation,
  mergeImageOutputCapability,
  type ImageOutputCapabilities,
  type ImageOutputCapability,
  type ImageOutputOperation,
} from '@chery/protocol'
import { FILE_OPERATION_LABELS } from '../../model/fileServices'
import { imageOutputDraftErrors, updateImageOutputDraft } from '../../model/imageOutputDraft'
import LabelTip from '../config/LabelTip.vue'

const props = defineProps<{ modelValue?: ImageOutputCapabilities; inherited?: ImageOutputCapabilities; operations: string[]; catalogStatus?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: ImageOutputCapabilities | undefined] }>()
const operations = computed(() => props.operations.filter(isImageOutputOperation))
const errors = computed(() =>
  Object.fromEntries(
    operations.value.map((operation) => [
      operation,
      imageOutputDraftErrors(props.modelValue, operation),
    ]),
  ),
)
const id = useId()

function update(operation: ImageOutputOperation, patch?: Partial<ImageOutputCapability>): void {
  emit('update:modelValue', updateImageOutputDraft(props.modelValue, operation, patch, props.inherited?.[operation]))
}
function inheritedText(operation: ImageOutputOperation) {
  if (props.catalogStatus && props.catalogStatus !== 'ready') return props.catalogStatus === 'loading' ? '目录读取中' : '目录读取失败'
  const resolved = mergeImageOutputCapability(operation, undefined, props.inherited)
  const cap = resolved.value
  return `继承${resolved.source === 'catalog' ? '目录' : '默认处理'}：多图 ${cap.nativeMultiImage}；张数控制 ${cap.countControl}；单次上限 ${cap.nativeMultiImage === 'unsupported' ? 1 : cap.maxImagesPerRequest ?? '未确认'}；合计 ${cap.maxInputAndOutputImages ?? '不增加额外限制'}`
}
</script>

<template>
  <section
    v-if="operations.length"
    class="brain-section brain-capability-section"
    aria-label="图片模型的原生张数限制"
  >
    <header class="section-heading">
      <h3>
        <LabelTip
          label="图片模型的原生张数限制"
          tip="未手动设置时继承对应型号与接口的目录限制。手动设置尚未验证，不能增加接口未实现的能力；所有修改由底栏统一保存。"
        />
      </h3>
    </header>
    <div class="capability-content">
      <section
        v-for="operation in operations"
        :key="operation"
        class="capability-group"
        :aria-label="FILE_OPERATION_LABELS[operation]"
      >
        <header class="capability-group-heading">
          <h4>{{ FILE_OPERATION_LABELS[operation] }}</h4>
          <small>{{ inheritedText(operation) }}</small>
          <span class="capability-state">{{
            modelValue?.[operation] ? '手动设置 · 尚未验证' : '继承目录'
          }}</span>
          <el-button
            size="small"
            class="section-action"
            :disabled="!modelValue?.[operation]"
            :aria-label="`${FILE_OPERATION_LABELS[operation]}：恢复目录限制`"
            @click="update(operation)"
            >恢复目录限制</el-button
          >
        </header>
        <div
          class="brain-fields"
          :aria-describedby="errors[operation] ? `${id}-${operation}-error` : undefined"
        >
          <div class="field">
            <LabelTip
              label="原生多图"
              tip="模型接口单次能否原生返回多张图片。继承目录时不写手动值；修改后按本组设置，恢复目录限制会清除本组全部手动值。"
            />
            <el-select
              :model-value="modelValue?.[operation]?.nativeMultiImage ?? ''"
              :aria-label="`${FILE_OPERATION_LABELS[operation]}：原生多图`"
              @update:model-value="
                (value: ImageOutputCapability['nativeMultiImage']) =>
                  update(operation, { nativeMultiImage: value })
              "
            >
              <el-option value="" label="继承目录" disabled />
              <el-option value="supported" label="支持" />
              <el-option value="unsupported" label="只支持单图" />
              <el-option value="unknown" label="未确认" />
            </el-select>
          </div>
          <div class="field">
            <LabelTip
              label="张数控制"
              tip="按张数请求：请求指定张数。最多几张：请求上限，实际可能更少。模型决定：不能请求固定张数。未确认与继承目录不同。"
            />
            <el-select
              :model-value="modelValue?.[operation]?.countControl ?? ''"
              :aria-label="`${FILE_OPERATION_LABELS[operation]}：张数控制`"
              @update:model-value="
                (value: ImageOutputCapability['countControl']) =>
                  update(operation, { countControl: value })
              "
            >
              <el-option value="" label="继承目录" disabled />
              <el-option value="requested" label="按张数请求" />
              <el-option value="maximum" label="最多几张" />
              <el-option value="uncontrolled" label="模型决定返回数量" />
              <el-option value="unknown" label="未确认" />
            </el-select>
          </div>
          <div class="field">
            <LabelTip
              label="单次输出上限（张）"
              tip="单次调用最多返回的图片数。只支持单图时只能填 1，支持多图时至少为 2；按张数请求或请求上限时必须填写。"
            />
            <el-input-number
              :model-value="modelValue?.[operation]?.maxImagesPerRequest"
              :min="1"
              :step="1"
              :controls="false"
              :aria-label="`${FILE_OPERATION_LABELS[operation]}：单次输出上限`"
              :aria-describedby="errors[operation] ? `${id}-${operation}-error` : undefined"
              placeholder="未手动设置"
              @update:model-value="
                (value: number | undefined | null) =>
                  update(operation, { maxImagesPerRequest: value ?? undefined })
              "
            />
          </div>
          <div class="field">
            <LabelTip
              label="参考图与输出合计上限（张）"
              tip="仅在服务限制参考图和输出图总数时填写；没有该限制则留空。"
            />
            <el-input-number
              :model-value="modelValue?.[operation]?.maxInputAndOutputImages"
              :min="1"
              :step="1"
              :controls="false"
              :aria-label="`${FILE_OPERATION_LABELS[operation]}：参考图与输出合计上限`"
              :aria-describedby="errors[operation] ? `${id}-${operation}-error` : undefined"
              placeholder="没有则留空"
              @update:model-value="
                (value: number | undefined | null) =>
                  update(operation, { maxInputAndOutputImages: value ?? undefined })
              "
            />
          </div>
        </div>
        <p
          v-if="errors[operation]"
          :id="`${id}-${operation}-error`"
          class="capability-error"
          role="alert"
        >
          {{ errors[operation] }}
        </p>
      </section>
    </div>
  </section>
</template>

<style scoped lang="less">
@import './brainSections.less';
</style>
