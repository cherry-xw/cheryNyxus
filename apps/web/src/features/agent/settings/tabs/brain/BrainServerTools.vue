<script setup lang="ts">
import { computed } from 'vue'
import type { BrainConfigDto } from '@/application/backend/public'
import type { CapabilityField, LlmProtocol, ServerToolObservation } from '@chery/protocol'
import { useBrainServiceCapabilities } from './useBrainServiceCapabilities'
import LabelTip from '../config/LabelTip.vue'

const props = defineProps<{ cfg: BrainConfigDto; protocol?: LlmProtocol }>()
const { state, refresh } = useBrainServiceCapabilities(
  () => props.cfg,
  () => props.protocol,
)
const refreshDisabled = computed(
  () => state.value.kind === 'loading' || !props.cfg.model || !props.cfg.provider,
)
const capabilityLabels = {
  webSearch: '联网搜索',
  webReader: '网页读取',
  imageInspect: '图片分析',
} as const
const states = { supported: '标注支持', unsupported: '标注不支持', unknown: '未确认' } as const
const sources = {
  catalog: '模型目录',
  user: '手动配置',
  adapter: '协议限制',
  default: '默认值',
} as const
const statuses: Record<ServerToolObservation['status'], string> = {
  started: '开始调用',
  completed: '调用已结束',
  failed: '明确失败',
  unknown: '结果未知',
}
function capabilityText(field: CapabilityField): string {
  return `${sources[field.source]} · ${states[field.state]}`
}
</script>

<template>
  <section class="brain-section brain-capability-section" aria-label="模型服务端工具">
    <header class="section-heading">
      <h3>
        <LabelTip
          label="模型服务端工具"
          tip="模型服务自带的工具，来源为本地模型目录说明与已记录的调用。仅点击刷新才读取，不向模型服务查询工具、不调用模型、不收费、不保存草稿。调用结束不证明内容任务成功。"
        />
      </h3>
      <small>只读 · 当前配置尚未验证</small>
      <el-button size="small" class="section-action" :disabled="refreshDisabled" @click="refresh">{{
        state.kind === 'loading' ? '正在读取' : '刷新'
      }}</el-button>
    </header>
    <div class="capability-content" :aria-busy="state.kind === 'loading'">
      <p v-if="state.kind === 'loading'" role="status">正在读取记录…</p>
      <p v-else-if="state.kind === 'error'" class="capability-error" role="alert">
        {{ state.message }}
      </p>
      <p v-else-if="state.kind === 'idle'" class="capability-note">
        {{
          !cfg.model || !cfg.provider
            ? '请先填写上方的服务和模型，再点击刷新。'
            : '点击刷新读取此连接的工具说明与记录。'
        }}
      </p>
      <template v-else-if="state.kind === 'ready'">
        <dl class="capability-facts">
          <template v-for="(label, key) in capabilityLabels" :key="key">
            <dt>{{ label }}</dt>
            <dd>{{ capabilityText(state.value.serverTools[key]) }}</dd>
          </template>
        </dl>
        <p v-if="!state.value.connectionIdentified" class="capability-note">
          连接信息尚不完整，无法匹配此配置的观察记录。
        </p>
        <p v-if="state.value.observationError" class="capability-error" role="alert">
          {{ state.value.observationError }}
        </p>
        <p class="capability-note">
          完整列表未知<span v-if="state.value.observationsTruncated">
            · 仅列出最近 200 种观察工具</span
          >
        </p>
        <ul v-if="state.value.knownTools.length" class="known-tools">
          <li v-for="tool in state.value.knownTools" :key="tool.name">
            <div class="tool-heading">
              <code>{{ tool.name }}</code>
              <a
                v-if="tool.documentationUrl"
                :href="tool.documentationUrl"
                target="_blank"
                rel="noopener noreferrer"
                :aria-label="`${tool.name} 文档（新窗口）`"
                >查看文档 ↗</a
              >
            </div>
            <div class="tool-meta">
              <span>{{
                tool.sources
                  .map((source) => (source === 'catalog' ? '目录说明' : '此配置已观察到'))
                  .join(' / ')
              }}</span>
              <template v-if="tool.observation">
                <span>{{ statuses[tool.observation.status] }}</span>
                <time :datetime="new Date(tool.observation.observedAt).toISOString()">{{
                  new Date(tool.observation.observedAt).toLocaleString()
                }}</time>
              </template>
            </div>
            <p v-if="tool.description">{{ tool.description }}</p>
          </li>
        </ul>
        <p v-else>暂无工具说明或此连接的观察记录；这不表示服务没有工具。可点击「刷新」重新读取。</p>
      </template>
    </div>
  </section>
</template>

<style scoped lang="less">
@import './brainSections.less';

.capability-facts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 8px 12px;
  margin: 0;

  dt {
    color: color-mix(in srgb, var(--ink) 78%, transparent);
  }
  dd {
    margin: 0;
  }
}

.known-tools {
  list-style: none;
  margin: 0;
  padding: 0;

  li {
    display: grid;
    gap: 8px;
    padding: 8px 0;
    border-top: 1px solid var(--border);
  }
}

.tool-heading,
.tool-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 12px;
}

.tool-heading {
  code {
    font-family: var(--font-mono);
  }
  a {
    margin-left: auto;
    color: var(--tab-color, var(--accent));
    text-decoration: underline;
  }
}

.tool-meta {
  color: color-mix(in srgb, var(--ink) 66%, transparent);
  font-size: 12px;
  time {
    font-variant-numeric: tabular-nums;
  }
}
</style>
