<script setup lang="ts">
/**
 * MessageBubble：单条历史消息渲染（群消息样式）。
 * - role=user：真人发言。头像右、气泡左（row-reverse），无 hover 面板
 * - role=assistant：主 pet 回复。头像左、气泡右；hover 头像弹详情面板（brain/senseGroups/mcpServers）
 * - role=master：主 pet 发给角色（子 pet）的消息（getHistory 合并子 chat 的 user→master）。头像左、气泡右；
 *   双头像 = 主 pet 大头像（发言者）+ 子 pet 右下角小徽章（对方）
 * - role=role（旧历史 role=subagent）：角色（子 pet）回复。头像左、气泡右；双头像 = 子 pet 大头像（发言者，emoji+右上角 name 首字母）
 *   + 主 pet 右下角小徽章（对方）。发言者大 + 对方小（master/role 对称）
 * thinking：非空时折叠区（默认收起，点击展开），置于 content 上方
 * senseCalls：assistant/role 角色（子 pet 回复也可能调 sense）content 下方渲染 SenseCallBox
 * 头像来源：主 pet = masterPetName 首字符；子 pet = subPetFace（face.calm emoji）。
 *   子 pet name/face/agentType 由 HistoryDrawer 按 item.subPetChatId 从 pets 查得（缺则 fallback）。
 */
import { computed, ref } from 'vue'
import type { HistoryItem } from '@/domain/chat/projectionTypes'
import type { RuntimeSelection } from '@/application/backend/public'
import { useRenderedMarkdown } from '@/composables/useRenderedMarkdown'
import { formatTime } from '@/utils/formatTime'
import { splitCommandPrompt } from '../composables/commands'
import { SenseCallRenderer } from '../renderers/index'
import MessageAvatar from './MessageAvatar.vue'
import { MediaInlineRenderer } from '../composer/public'
import { terminationDisplay } from '@/features/pets/nyxus/graph/termination'
import { toSenseNameZh } from '@/utils/senseName'
import RiskBadge from '@/components/RiskBadge.vue'

const props = defineProps<{
  item: HistoryItem
  /** 主 pet name（= chat 绑定 pet.name；master 发言者 / assistant 单头像 / role 对方徽章 用） */
  masterPetName?: string
  /** 子 pet name（合并式 master/role：HistoryDrawer 按 subPetChatId 查 pets 得；注入式 role 走 item.petName fallback） */
  subPetName?: string
  /** 子 pet face.calm emoji（合并式；缺则 🤖 fallback；ghost 用灵魂 emoji 兜底） */
  subPetFace?: string
  /** 子 pet agentType（senseGroups[0]；hover 面板 type 字段用；注入式走 item.petName fallback） */
  subPetType?: string
  /** 仅 role 最后一条回复=true：显示主 pet 引用小徽章（标识"回复给主 pet"，中间回复不重复引用） */
  showMasterBadge?: boolean
  /** 布局：group（默认，主 chat 合并视图双头像群聊）/ direct（ghost 自身抽屉 1:1：master 右·role 左 单头像）。 */
  layout?: 'group' | 'direct'
  /** caller pet face emoji（role 分支右侧徽章用，callerIsMaster=false 时显示）。ghost 用灵魂 emoji 兜底。 */
  callerPetFace?: string
  /** caller pet name（hover 详情面板 name 字段用：role=上层 sub pet name 优先于 sub pet name） */
  callerPetName?: string
  /** caller 是不是 master pet（无 caller 时也默认 true，徽章走 pet-master 样式 + masterText fallback）。 */
  callerIsMaster?: boolean
  /** 历史项无 runtime 时，该 chat 当前 pet 的 runtime 兜底（透传给 MessageAvatar，6c）。 */
  fallbackRuntime?: RuntimeSelection
  /** 真人头像 hover 的「系统提示」描述（6d，抽屉打开时随机选一套，整次打开稳定）。 */
  userAvatarCaption?: string
  /** 工具调用折叠为小 tag（抽屉头部「折叠工具调用」开关）：senseCalls 渲染为一行 tag，
   *  hover tag 悬浮显完整渲染器内容；thinking / content 渲染不受影响。 */
  collapseSenseCalls?: boolean
}>()

const showThinking = ref(false)
const roleClass = computed(() => `role-${props.item.role}`)

const hasThinking = computed(() => !!props.item.thinking && props.item.thinking.trim().length > 0)
// assistant + role（子 pet 回复也可能调 sense）渲染 senseCalls；master/user 无
const hasSenseCalls = computed(
  () =>
    (props.item.role === 'assistant' ||
      props.item.role === 'subagent' ||
      props.item.role === 'role') &&
    !!props.item.senseCalls &&
    props.item.senseCalls.length > 0,
)

// assistant/role/master 走 markdown（LLM 输出 / 主 pet prompt 注入）；user 纯文本
// （user 走 {{ }} 插值已 HTML 转义，字面 #/* 不被误解释为富文本）
const isMarkdown = computed(
  () =>
    props.item.role === 'assistant' ||
    props.item.role === 'subagent' ||
    props.item.role === 'role' ||
    props.item.role === 'master',
)

// 折叠 tag 的状态符号（与 SenseCallBox.statusGlyph 同款映射）
const senseStatusGlyph = (call: NonNullable<HistoryItem['senseCalls']>[number]): string => {
  switch (call.status) {
    case 'running':
      return '⋯'
    case 'done':
      return '✓'
    case 'error':
      return '✗'
    default:
      return '?'
  }
}
const { html: renderedContent } = useRenderedMarkdown(() => props.item.content ?? '', {
  mode: 'full',
})
const userContentSegments = computed(() => splitCommandPrompt(props.item.content ?? ''))

// 气泡底部时间戳常显：同天 HH:MM / 跨天 MM-DD HH:MM / 跨年 YYYY-MM-DD HH:MM；缺失不渲染
const timeText = computed(() => formatTime(props.item.createdAt))
const isCompactTrigger = computed(
  () => props.item.role === 'user' && /\[\[command:\/compact\]\]/.test(props.item.content ?? ''),
)
const isCompactSummary = computed(() => props.item.contextCompaction === true)
const termination = computed(() =>
  props.item.termination ? terminationDisplay(props.item.termination) : undefined,
)

// jumpToSpawn 转发：MessageAvatar 点击头像 → 透传给 HistoryDrawer
const emit = defineEmits<{
  (e: 'jumpToSpawn', payload: { senseCallId: string }): void
  (e: 'retryMessage', payload: { messageId: string; chatId?: string }): void
  (e: 'removeMessage', payload: { messageId: string; chatId?: string }): void
}>()
function retryDelivery(): void {
  if (props.item.msgId)
    emit('retryMessage', {
      messageId: props.item.msgId,
      ...(props.item.agentChatId ? { chatId: props.item.agentChatId } : {}),
    })
}
function removeDelivery(): void {
  if (props.item.msgId)
    emit('removeMessage', {
      messageId: props.item.msgId,
      ...(props.item.agentChatId ? { chatId: props.item.agentChatId } : {}),
    })
}
</script>

<template>
  <div class="compact-entry" :class="{ 'is-compact-summary': isCompactSummary }">
    <div v-if="isCompactSummary" class="context-divider" role="separator">
      <span>上下文已压缩并替换 · 释放约 {{ item.contextCompactionTokens ?? 0 }} tokens</span>
    </div>
    <div
      class="msg-row"
      :class="[
        roleClass,
        `layout-${layout ?? 'group'}`,
        {
          'is-child-to-master': item.mergedView === 'child-to-master',
          'is-compact-trigger': isCompactTrigger,
          'is-compact-summary': isCompactSummary,
        },
      ]"
    >
      <MessageAvatar
        v-if="item.role !== 'user'"
        :item="item"
        :role="item.role"
        :layout="layout ?? 'group'"
        :master-pet-name="masterPetName"
        :sub-pet-name="subPetName"
        :sub-pet-face="subPetFace"
        :sub-pet-type="subPetType"
        :show-master-badge="showMasterBadge"
        :caller-pet-face="callerPetFace"
        :caller-pet-name="callerPetName"
        :caller-is-master="callerIsMaster"
        :can-jump-to-spawn="!!item.spawnSenseCallId"
        :merged-child-to-master="item.mergedView === 'child-to-master'"
        :fallback-runtime="fallbackRuntime"
        @jump-to-spawn="(p) => emit('jumpToSpawn', p)"
      />
      <el-tooltip v-else :content="userAvatarCaption" placement="left" :show-after="200">
        <div class="avatar role-user" aria-hidden="true">🧑</div>
      </el-tooltip>
      <div
        class="bubble"
        :class="[
          roleClass,
          { 'is-compact-trigger': isCompactTrigger, 'is-compact-summary': isCompactSummary },
        ]"
      >
        <div v-if="isCompactTrigger" class="compact-label">上下文压缩</div>
        <div v-if="isCompactSummary" class="compact-label">压缩后的上下文摘要</div>
        <div v-if="hasThinking || timeText" class="bubble-head">
          <button
            v-if="hasThinking"
            type="button"
            class="thinking-toggle"
            :aria-expanded="showThinking"
            @click="showThinking = !showThinking"
          >
            <span class="caret" :class="{ open: showThinking }">▸</span>
            thinking
          </button>
          <span v-if="timeText" class="time">{{ timeText }}</span>
        </div>
        <pre v-if="hasThinking && showThinking" class="thinking-pre">{{ props.item.thinking }}</pre>
        <div v-if="props.item.content" class="content">
          <!-- eslint-disable-next-line vue/no-v-html -- markdown-it html:false 已转义，XSS 安全 -->
          <span v-if="isMarkdown" class="md" v-html="renderedContent" />
          <template v-else>
            <template
              v-for="(segment, index) in userContentSegments"
              :key="`${segment.type}-${index}`"
            >
              <span v-if="segment.type === 'command'" class="instruction-message-token">{{
                segment.value
              }}</span>
              <span
                v-else-if="segment.type === 'role'"
                class="instruction-message-token role-message-token"
                >{{ segment.value }}</span
              >
              <template v-else>{{ segment.value }}</template>
            </template>
          </template>
          <!-- 内联媒体预览 -->
          <MediaInlineRenderer
            v-if="props.item.mediaAssets && props.item.mediaAssets.length > 0"
            :assets="props.item.mediaAssets"
          />
        </div>
        <div
          v-if="props.item.delivery"
          class="delivery-state"
          :data-status="props.item.delivery.status"
        >
          <span v-if="props.item.delivery.status === 'sending'">发送中…</span>
          <span v-else-if="props.item.delivery.status === 'committed'">已发送</span>
          <template v-else>
            <span>{{ props.item.delivery.error?.message ?? '发送失败' }}</span>
            <button v-if="props.item.msgId" type="button" @click="retryDelivery">重试</button>
            <button v-if="props.item.msgId" type="button" @click="removeDelivery">移除</button>
          </template>
        </div>
        <!-- 工具调用：折叠态一行小 tag（hover 悬浮显完整渲染器内容），展开态逐个渲染器 box -->
        <div v-if="hasSenseCalls && collapseSenseCalls" class="sense-tags">
          <el-popover
            v-for="(call, idx) in props.item.senseCalls"
            :key="call.id ?? `${call.name}-${idx}`"
            trigger="hover"
            placement="top"
            :show-after="150"
            :width="440"
            popper-class="sense-tag-detail-popper"
          >
            <template #reference>
              <button
                type="button"
                class="sense-tag"
                :class="`tag-${call.status}`"
                :title="call.name"
              >
                <span class="sense-tag-name">{{ toSenseNameZh(call.name) }}</span>
                <span class="sense-tag-status" aria-hidden="true">{{
                  senseStatusGlyph(call)
                }}</span>
                <RiskBadge :auth="call.security" compact />
              </button>
            </template>
            <!-- 悬浮详情 = 原渲染器完整内容（专用渲染器优先，参数/结果默认展开） -->
            <SenseCallRenderer :call="call" default-expanded />
          </el-popover>
        </div>
        <div v-else-if="hasSenseCalls" class="sense-list">
          <SenseCallRenderer
            v-for="(call, idx) in props.item.senseCalls"
            :id="call.id ? `sensecall-${call.id}` : `sensecall-idx-${idx}`"
            :key="call.id ?? `${call.name}-${idx}`"
            :call="call"
          />
        </div>
        <div
          v-if="termination"
          class="termination-tail"
          :class="`tone-${termination.tone}`"
          role="note"
        >
          {{ termination.label }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@import '@/styles/markdown.less';
@import '@/styles/scrollbar.less';

@ink: var(--ink);

.delivery-state {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  font-size: 11px;
}
.delivery-state[data-status='failed'] {
  color: var(--el-color-danger);
}

.msg-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;

  &.role-user {
    flex-direction: row-reverse;
  }
  // direct 模式 master 靠右（1:1 布局，ghost 自身抽屉）
  &.layout-direct.role-master {
    flex-direction: row-reverse;
  }
}

.context-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 8px;
  color: color-mix(in srgb, var(--ink) 46%, transparent);
  font-size: 10px;
  letter-spacing: 0.04em;

  &::before,
  &::after {
    content: '';
    height: 1px;
    flex: 1;
    background: linear-gradient(90deg, transparent, rgba(112, 86, 33, 0.28));
  }
  &::after {
    transform: scaleX(-1);
  }
}

// .avatar 基础圆样式：MessageBubble 内仅用于 role=user 行内头像（line 98）
// 其他 role 变体（role-assistant/pet-master/pet-sub/is-speaker/is-badge）已迁至 MessageAvatar.vue scoped
// （子组件内部元素不带父 scoped 属性，原放此处不命中 → 样式缺失）
.avatar {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  color: #7c3aed;
  user-select: none;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);

  &.role-user {
    background: linear-gradient(135deg, #8a8f98, #4b5563);
  }
}

.bubble {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  max-width: 92%;
  padding: 6px 10px;
  box-sizing: border-box;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  word-break: break-word;

  &.role-user {
    background: color-mix(in srgb, var(--surface) 90%, var(--accent));
    border-color: color-mix(in srgb, var(--accent) 32%, transparent);
  }
  &.is-compact-trigger {
    background: color-mix(in srgb, var(--surface) 90%, var(--accent));
    border-color: rgba(181, 126, 27, 0.42);
  }
  &.is-compact-summary {
    background: color-mix(in srgb, var(--surface) 90%, var(--success));
    border-color: rgba(42, 117, 72, 0.28);
  }
}
.termination-tail {
  margin-top: 3px;
  padding-top: 5px;
  border-top: 1px dashed rgba(70, 76, 86, 0.2);
  color: var(--ink);
  font-size: 10px;
  font-weight: 400;
}
.termination-tail.tone-warning,
.termination-tail.tone-user {
  color: #9a6700;
}
.termination-tail.tone-error {
  color: #b4233b;
}
.termination-tail.tone-redirect {
  color: #7c3aed;
}

.compact-label {
  align-self: flex-start;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(75, 108, 69, 0.12);
  color: var(--ink);
  color: #456342;
  font-weight: 600;
}

// 气泡头部：thinking 开关（左）+ 时间戳（右）同行
.bubble-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.thinking-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 4px;
  border: none;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 50%, transparent);
  font-size: 10px;
  font-family: inherit;
  cursor: pointer;
  user-select: none;

  &:hover {
    color: color-mix(in srgb, var(--ink) 78%, transparent);
  }
}

.caret {
  display: inline-block;
  transition: transform 140ms ease;

  &.open {
    transform: rotate(90deg);
  }
}

.thinking-pre {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  color: color-mix(in srgb, var(--ink) 66%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 9.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  max-height: 220px;
  overflow: auto;
  .inner-scrollbar(); /* 内层滚动：折叠思考过程，弱化滚动条 */
}

.content {
  font-size: 11.5px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
  overflow: auto;
  max-height: 70vh;
  .inner-scrollbar(); /* 内层滚动：长响应内容，弱化滚动条 */
  .md {
    .md-content();
  }
}

// user 纯文本：保留换行/连续空格/制表符（pre-wrap）；不走 markdown 渲染
// （{{ }} 插值已 HTML 转义，字面 #/* 不被误解释为富文本）
.msg-row.role-user .content {
  white-space: pre-wrap;
  font-weight: 400;
}

.instruction-message-token {
  display: inline-block;
  margin: 1px 3px 1px 0;
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, #b67c1c 32%, transparent);
  border-radius: 5px;
  // 主题自适应 tag：随 --surface-soft 深/浅翻转，文字随 --ink 抬亮
  // （原白→透明渐变 + 固定深褐字，深色下成白→黑过渡、两主题都不对）
  background: color-mix(in srgb, var(--accent) 18%, var(--surface-soft));
  color: color-mix(in srgb, #b67c1c 72%, var(--ink));
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.45;
  vertical-align: baseline;
}

.role-message-token {
  border-color: color-mix(in srgb, #4682ca 32%, transparent);
  background: color-mix(in srgb, #4682ca 18%, var(--surface-soft));
  color: color-mix(in srgb, #4682ca 72%, var(--ink));
}

.sense-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 2px;
}

// 折叠态：工具调用一行小 tag（hover el-popover 悬浮显完整渲染器内容）
.sense-tags {
  display: flex;
  flex-flow: row wrap;
  gap: 4px;
  margin-top: 2px;
}

.sense-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 5px;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 70%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10px;
  line-height: 1.45;
  cursor: default;

  &:hover {
    border-color: color-mix(in srgb, var(--ink) 30%, transparent);
  }
}

// 工具名称固定默认色（继承 .sense-tag 基础色），不随执行结果变色
.sense-tag-name {
  color: color-mix(in srgb, var(--ink) 70%, transparent);
}

// 仅状态符号（勾/叉）随执行结果着色（与 SenseCallBox .sense-status 同款语义色）
.sense-tag.tag-running .sense-tag-status {
  color: #eab308;
}
.sense-tag.tag-error .sense-tag-status {
  color: #dc2626;
}
.sense-tag.tag-done .sense-tag-status {
  color: #16a34a;
}

// 气泡右上角时间戳：bubble-head 内靠右、低饱和、小字号；缺失不渲染（v-if 控制）
.time {
  margin-left: auto;
  font-size: 10px;
  line-height: 1;
  color: color-mix(in srgb, var(--ink) 40%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  white-space: nowrap;
}
</style>

<style lang="less">
// 折叠 tag 悬浮详情 popper：el-popper 渲染在 body 外，scoped 不命中，需全局样式。
// 与外层滚动边界合并为一层（2026-08-25）：popper 仅作定位层，去 el 默认 padding/背景/边框/阴影/
// 箭头与外层滚动边界（max-height/overflow），视觉只剩内层渲染器自身一层。各渲染器内容区自带
// 120-240px 限高滚动（SenseCallBox .sense-pre/.arg-val、专用渲染器 .content-pre/.results-body 等），长结果不撑爆。
.sense-tag-detail-popper.el-popper {
  padding: 0;
  background: transparent;
  border: none;
  box-shadow: none;
  max-height: none;
  overflow: visible;
}
.sense-tag-detail-popper .el-popper__arrow {
  display: none;
}
</style>
