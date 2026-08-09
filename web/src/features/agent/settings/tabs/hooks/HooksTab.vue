<script setup lang="ts">
/**
 * HooksTab：钩子事件信息面板 + 管家引导。
 *
 * 职责：
 * - 展示 10 个 HookEvent（中文名 + 能力 chips + 描述 + matcher 字段）
 * - 展示已有 handler 列表（matcher + if + command + timeout），支持删除
 * - 管家引导卡：提示用户通过管家 agent 配置 hooks
 * - Brain 级 hooks 只读展示
 *
 * 风格：新拟物化（Neumorphism）事件卡 + 凹陷 handler 行；能力 chip 用语义色。
 *
 * 数据流：
 * - hooks.get 拉全局 + brain 级 hooks
 * - hooks.events 拉事件元数据（含 capabilities + matcherField）
 * - 删除 handler → splice draft → SettingsDialog 保存时 hooks.save
 */
import { computed, onMounted, ref } from 'vue'
import { Delete } from '@element-plus/icons-vue'
import { agentApi, type HookHandlerDTO, type HookEventMeta } from '@/services/agentApi'
import TabShell, { type IndexItem } from '@/components/layout/TabShell.vue'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'

const emit = defineEmits<{ (e: 'error', msg: string): void }>()

// ============ 数据 ============

/** 全局 hooks draft（event → handler 列表）*/
const draft = ref<Record<string, HookHandlerDTO[]>>({})
/** Brain 级 hooks（只读）*/
const brainHooks = ref<Record<string, Record<string, HookHandlerDTO[]>>>({})
/** 事件元数据 */
const eventMeta = ref<HookEventMeta[]>([])
/** 加载状态 */
const loading = ref(false)

// ============ 计算 ============

/** IndexItem 供 TabShell footer 导航 */
const indexItems = computed<IndexItem[]>(() =>
  eventMeta.value.map((e) => ({
    label: e.label ?? e.name,
    anchor: e.name,
    description: e.description,
    capabilities: e.capabilities,
    matcherField: e.matcherField,
  })),
)

/** 能力 chip 语义色（按 category 分组：动作/阻断/信息/无作用）*/
function capKind(cap: string): 'action' | 'block' | 'info' | 'readonly' {
  if (cap === '阻断' || cap === 'ask') return 'block'
  if (cap === '注入上下文') return 'info'
  if (cap === '只读') return 'readonly'
  return 'action'
}

// ============ 方法 ============

function onError(msg: string): void {
  emit('error', msg)
}

function emitError(err: unknown): void {
  const e = err as { message?: string }
  onError(e?.message ?? String(err))
}

async function loadHooks(): Promise<void> {
  loading.value = true
  try {
    const [hooksData, meta] = await Promise.all([agentApi.getHooks(), agentApi.getHookEvents()])
    draft.value = hooksData.handlers
    brainHooks.value = hooksData.brainHooks
    eventMeta.value = meta
  } catch (err) {
    emitError(err)
  } finally {
    loading.value = false
  }
}

/** 删除 handler */
function removeHandler(eventName: string, index: number): void {
  const list = draft.value[eventName]
  if (!list) return
  list.splice(index, 1)
  if (list.length === 0) {
    delete draft.value[eventName]
  }
}

/** 获取事件的 handler 列表 */
function getHandlers(eventName: string): HookHandlerDTO[] {
  return draft.value[eventName] ?? []
}

/** 有 brain 级 hooks 的 brain 列表 */
const brainList = computed(() =>
  Object.entries(brainHooks.value)
    .filter(([, hooks]) => Object.keys(hooks).length > 0)
    .map(([name, hooks]) => ({
      name,
      handlerCount: Object.values(hooks).reduce((sum, list) => sum + list.length, 0),
    })),
)

/** 暴露 draft 供 SettingsDialog 保存 */
defineExpose({ draft })

onMounted(loadHooks)
</script>

<template>
  <TabShell tab-key="hooks" :index-items="indexItems">
    <template #hints>
      <p class="sect-hint">
        钩子是事件驱动的扩展点：在 LLM 调用、工具执行等关键节点触发 shell
        命令，可改写请求、阻断操作或注入上下文。
      </p>
      <p class="warn-hint">⚠️ Handler 以完整用户权限执行，请仅配置可信脚本。</p>
    </template>

    <template #popper="{ item }">
      <div class="index-card">
        <div class="index-card-title">
          {{ (item as unknown as HookEventMeta).label ?? (item as unknown as HookEventMeta).name }}
        </div>
        <div class="index-card-line">
          <b>事件</b><span>{{ (item as unknown as HookEventMeta).name }}</span>
        </div>
        <div class="index-card-line">
          <b>能力</b>
          <span class="caps">
            <span
              v-for="c in (item as unknown as HookEventMeta).capabilities"
              :key="c"
              class="cap-chip"
              :class="capKind(c)"
            >
              {{ c }}
            </span>
          </span>
        </div>
        <div v-if="(item as unknown as HookEventMeta).matcherField" class="index-card-line">
          <b>matcher</b><span>{{ (item as unknown as HookEventMeta).matcherField }}</span>
        </div>
      </div>
    </template>

    <div v-if="loading" class="loading-hint">加载中…</div>

    <template v-else>
      <!-- 管家引导卡（顶部：先讲清楚怎么用，再列事件细节）-->
      <article class="neu-card guide-card">
        <header class="guide-head">
          <span class="guide-icon">🤖</span>
          <span class="guide-title">使用管家配置钩子</span>
        </header>
        <div class="guide-body">
          <p class="guide-text">钩子需要编写 shell 脚本，建议通过管家 agent 自动配置：</p>
          <ol class="guide-steps">
            <li>对话中输入 <code>@管家</code></li>
            <li>告诉管家你要配置哪个事件的钩子（如 PreLLMRequest 改 body）</li>
            <li>管家会读取参考文档、编写脚本、确认后落盘到 hooks.json</li>
          </ol>
          <p class="guide-file">配置文件：<code>.chery/hooks/hooks.json</code></p>
        </div>
      </article>

      <!-- 事件行：左信息 + 右 handler 列表（单行紧凑布局，提升信息密度）-->
      <article
        v-for="ev in eventMeta"
        :key="ev.name"
        class="event-row neu-card"
        :data-anchor="ev.name"
      >
        <!-- 左侧：事件信息（30%）-->
        <div class="ev-info">
          <div class="ev-head">
            <span class="ev-label">{{ ev.label ?? ev.name }}</span>
            <span class="ev-name-tag">{{ ev.name }}</span>
          </div>
          <div class="caps">
            <span v-for="c in ev.capabilities" :key="c" class="cap-chip" :class="capKind(c)">
              {{ c }}
            </span>
          </div>
          <p class="ev-desc">{{ ev.description }}</p>
          <span v-if="ev.matcherField" class="ev-matcher-hint">
            matcher → <code>{{ ev.matcherField }}</code>
          </span>
        </div>

        <!-- 右侧：handler 列表（70%）-->
        <div class="ev-handlers">
          <div v-if="getHandlers(ev.name).length === 0" class="handler-empty">
            <span class="empty-icon">∅</span>
            <span class="empty-text">未配置 handler</span>
            <span class="empty-tip">用 @管家 让 agent 配置</span>
          </div>
          <div
            v-for="(h, i) in getHandlers(ev.name)"
            :key="i"
            class="neu-inset handler-row"
            :title="h.command"
          >
            <div class="handler-conds">
              <span v-if="h.matcher" class="cond-chip matcher" :title="`matcher: ${h.matcher}`">
                match <code>{{ h.matcher }}</code>
              </span>
              <span v-if="h.if" class="cond-chip if" :title="`if: ${h.if}`">
                if <code>{{ h.if }}</code>
              </span>
            </div>
            <code class="handler-cmd">{{ h.command }}</code>
            <span v-if="h.timeout" class="handler-timeout">{{ h.timeout }}s</span>
            <ConfirmPopover title="确认删除此 handler？" @confirm="removeHandler(ev.name, i)">
              <template #trigger>
                <button type="button" class="del-btn" aria-label="删除 handler">
                  <Delete class="del-ico" />
                </button>
              </template>
            </ConfirmPopover>
          </div>
        </div>
      </article>

      <!-- Brain 级 hooks 只读提示 -->
      <section v-if="brainList.length > 0" class="brain-section">
        <h4 class="brain-title">Brain 级钩子（只读）</h4>
        <p class="brain-hint">以下 brain 配置了独立 hooks 文件，需编辑配置文件修改。</p>
        <div class="brain-tags">
          <span v-for="b in brainList" :key="b.name" class="brain-tag">
            {{ b.name }} <small>({{ b.handlerCount }} handler)</small>
          </span>
        </div>
      </section>
    </template>
  </TabShell>
</template>

<style scoped lang="less">
@import '../../config/shared.less';

// ============ Neumorphism 基础色 ============
@neu-bg: #e8e6e1;

// ============ 加载 ============

.loading-hint {
  padding: 20px;
  text-align: center;
  color: fade(@ink, 60%);
  font-size: 12px;
}

// ============ Neumorphism 原语（事件卡 = 粉 → 白渐变 + 粉调阴影）============

.neu-card {
  // 从粉调渐变到白：颜色浓度跟着 --tab-color 自动适配
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--tab-color, #f472b6) 16%, white) 0%,
    color-mix(in srgb, var(--tab-color, #f472b6) 6%, white) 60%,
    #ffffff 100%
  );
  border-radius: 12px;
  box-shadow:
    5px 5px 12px color-mix(in srgb, var(--tab-color, #f472b6) 18%, rgba(0, 0, 0, 0.08)),
    -5px -5px 12px rgba(255, 255, 255, 0.7);
}

.neu-inset {
  // handler 凹陷行保持浅灰，避免数据行视觉过花
  background: @neu-bg;
  border-radius: 8px;
  box-shadow:
    inset 2px 2px 4px color-mix(in srgb, var(--tab-color, #f472b6) 12%, rgba(0, 0, 0, 0.05)),
    inset -2px -2px 4px rgba(255, 255, 255, 0.5);
}

// ============ 能力 chip 语义色 ============

// ============ 能力 chip 语义色 ============

.caps {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  min-width: 0;
}

.cap-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.5;
  white-space: nowrap;
  &.action {
    background: rgba(139, 92, 246, 0.14);
    color: #6d28d9;
  }
  &.block {
    background: rgba(220, 38, 38, 0.12);
    color: #b91c1c;
  }
  &.info {
    background: rgba(37, 99, 235, 0.12);
    color: #1d4ed8;
  }
  &.readonly {
    background: rgba(36, 38, 45, 0.08);
    color: fade(@ink, 50%);
  }
}

// ============ 事件行（左右两列布局）============

.event-row {
  display: grid;
  grid-template-columns: minmax(0, 32%) minmax(0, 1fr);
  gap: 0;
  padding: 12px 14px;
  margin-bottom: 0;
  // 修复最后一项塌陷：禁止 flex 子项被压缩
  flex-shrink: 0;
  align-items: start;
}

// ============ 左侧事件信息 ============

.ev-info {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 12px;
  border-right: 1px dashed color-mix(in srgb, var(--tab-color, #f472b6) 25%, rgba(36, 38, 45, 0.1));
}

.ev-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.ev-label {
  font-size: 13px;
  font-weight: 800;
  color: fade(@ink, 88%);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ev-name-tag {
  font-size: 9px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(36, 38, 45, 0.08);
  color: fade(@ink, 50%);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  flex-shrink: 0;
}

.ev-desc {
  margin: 0;
  font-size: 11px;
  color: fade(@ink, 65%);
  line-height: 1.4;
}

.ev-matcher-hint {
  font-size: 10px;
  color: fade(@ink, 50%);
  code {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 10px;
    padding: 0 3px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.6);
    color: fade(@ink, 70%);
  }
}

// ============ 右侧 handler 列表 ============

.ev-handlers {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-left: 12px;
  min-width: 0;
}

.handler-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 11px;
  color: fade(@ink, 45%);
  font-style: italic;
  .empty-icon {
    font-size: 13px;
    color: fade(@ink, 35%);
  }
  .empty-text {
    font-weight: 600;
  }
  .empty-tip {
    color: fade(@ink, 40%);
    font-style: normal;
    &::before {
      content: '·';
      margin-right: 4px;
    }
  }
}

.handler-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  min-width: 0;
}

.handler-conds {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  flex-shrink: 0;
}

.cond-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 600;
  background: rgba(36, 38, 45, 0.06);
  color: fade(@ink, 60%);
  code {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 9px;
    color: fade(@ink, 80%);
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  &.matcher {
    background: rgba(139, 92, 246, 0.1);
    color: #6d28d9;
    code {
      color: #6d28d9;
    }
  }
  &.if {
    background: rgba(37, 99, 235, 0.1);
    color: #1d4ed8;
    code {
      color: #1d4ed8;
    }
  }
}

.handler-cmd {
  flex: 1 1 0;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  color: fade(@ink, 80%);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.handler-timeout {
  font-size: 10px;
  font-weight: 600;
  color: fade(@ink, 50%);
  flex-shrink: 0;
}

.del-btn {
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: fade(@ink, 40%);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  &:hover {
    color: #b91c1c;
    background: rgba(185, 28, 28, 0.08);
  }
}

.del-ico {
  width: 12px;
  height: 12px;
}

// ============ 管家引导卡 ============

.guide-card {
  position: relative;
  padding: 14px;
  margin-top: 4px;
  flex-shrink: 0;
}

.guide-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.guide-icon {
  font-size: 16px;
}

.guide-title {
  font-size: 13px;
  font-weight: 800;
  color: fade(@ink, 88%);
}

.guide-body {
  margin-top: 8px;
}

.guide-text {
  margin: 0 0 6px;
  font-size: 12px;
  color: fade(@ink, 70%);
  line-height: 1.5;
}

.guide-steps {
  margin: 0 0 8px;
  padding-left: 20px;
  font-size: 12px;
  color: fade(@ink, 75%);
  line-height: 1.7;
  li {
    margin-bottom: 2px;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 11px;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(36, 38, 45, 0.08);
  }
}

.guide-file {
  margin: 0;
  font-size: 11px;
  color: fade(@ink, 55%);
  code {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 11px;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(36, 38, 45, 0.08);
  }
}

// ============ Brain 级 hooks ============

.brain-section {
  margin-top: 12px;
  padding: 10px 14px;
  border-top: 1px dashed rgba(36, 38, 45, 0.12);
  flex-shrink: 0;
}

.brain-title {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 700;
  color: fade(@ink, 80%);
}

.brain-hint {
  margin: 0 0 8px;
  font-size: 11px;
  color: fade(@ink, 55%);
}

.brain-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.brain-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 4px;
  background: rgba(36, 38, 45, 0.06);
  font-size: 11px;
  color: fade(@ink, 75%);
  small {
    color: fade(@ink, 50%);
  }
}
</style>
