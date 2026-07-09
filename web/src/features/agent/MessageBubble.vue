<script setup lang="ts">
/**
 * MessageBubble：单条历史消息渲染（群消息样式）。
 * - role=user：真人发言。头像右、气泡左（row-reverse），无 hover 面板
 * - role=assistant：主 pet 回复。头像左、气泡右；hover 头像弹详情面板（brain/senseGroups/mcpServers）
 * - role=master：主 pet 发给子 pet 的消息（getHistory 合并子 chat 的 user→master）。头像左、气泡右；
 *   双头像 = 主 pet 大头像（发言者）+ 子 pet 右下角小徽章（对方）
 * - role=subagent：子 pet 回复。头像左、气泡右；双头像 = 子 pet 大头像（发言者，emoji+右上角 name 首字母）
 *   + 主 pet 右下角小徽章（对方）。发言者大 + 对方小（master/subagent 对称）
 * thinking：非空时折叠区（默认收起，点击展开），置于 content 上方
 * senseCalls：assistant/subagent 角色（子 pet 回复也可能调 sense）content 下方渲染 SenseCallBox
 * 头像来源：主 pet = masterPetName 首字符；子 pet = subPetFace（face.calm emoji）。
 *   子 pet name/face/agentType 由 HistoryDrawer 按 item.subPetChatId 从 pets 查得（缺则 fallback）。
 */
import { computed, ref } from "vue";
import type { HistoryItem } from "@/stores/agents";
import { renderMarkdown } from "@/utils/markdown";
import SenseCallBox from "./SenseCallBox.vue";

const props = defineProps<{
  item: HistoryItem;
  /** 主 pet name（= chat 绑定 pet.name；master 发言者 / assistant 单头像 / subagent 对方徽章 用） */
  masterPetName?: string;
  /** 子 pet name（合并式 master/subagent：HistoryDrawer 按 subPetChatId 查 pets 得；注入式 subagent 走 item.petName fallback） */
  subPetName?: string;
  /** 子 pet face.calm emoji（合并式；缺则 🤖 fallback） */
  subPetFace?: string;
  /** 子 pet agentType（senseGroups[0]；hover 面板 type 字段用；注入式走 item.petName fallback） */
  subPetType?: string;
  /** 仅 subagent 最后一条回复=true：显示主 pet 引用小徽章（标识"回复给主 pet"，中间回复不重复引用） */
  showMasterBadge?: boolean;
  /** 布局：group（默认，主 chat 合并视图双头像群聊）/ direct（ghost 自身抽屉 1:1：master 右·subagent 左 单头像）。 */
  layout?: "group" | "direct";
}>();

const showThinking = ref(false);

// 主 pet 头像文字（name 首字符，fallback ⊙）
const masterText = computed(() => props.masterPetName?.charAt(0).toUpperCase() || "⊙");
// 子 pet emoji face（fallback 🤖）
const subFace = computed(() => props.subPetFace || "🤖");
// 子 pet name 首字母（subagent 大头像右上角小字；空则不渲染）
const subNameInitial = computed(() => props.subPetName?.charAt(0).toUpperCase() || "");
// hover 面板 type 字段：合并式 subPetType，注入式 item.petName，缺则 —
const subTypeText = computed(() => props.subPetType || props.item.petName || "—");

const roleClass = computed(() => `role-${props.item.role}`);
const layoutClass = computed(() => `layout-${props.layout ?? "group"}`);

// direct 模式（ghost 自身抽屉）：master/subagent 走单头像 1:1 布局（master 右 / subagent 左）。
// group 模式 master/subagent 仍走双头像群聊。assistant 恒单头像。
const useSingleAvatar = computed(() => props.layout === "direct" || props.item.role === "assistant");
const singleAvatarClass = computed(() => {
  if (props.item.role === "master") return "pet-master";
  if (props.item.role === "subagent") return "pet-sub";
  return "role-assistant";
});
const singleAvatarText = computed(() => {
  if (props.item.role === "subagent") return subFace.value;
  return masterText.value; // master / assistant
});

// hover 面板 name：master/assistant=主 pet name；subagent=子 pet name（注入式 fallback item.petName）
const resolvedName = computed(() => {
  switch (props.item.role) {
    case "master":
    case "assistant":
      return props.masterPetName || "";
    case "subagent":
      return props.subPetName || props.item.petName || "";
    default:
      return "";
  }
});

// 单头像文字（仅 user/assistant；master/subagent 走双头像模板）
const avatarText = computed(() => {
  switch (props.item.role) {
    case "user":
      return "🧑";
    case "assistant":
      return masterText.value;
    default:
      return "?";
  }
});

// hover 详情面板 runtime：user=发送时配置，assistant=前一条 user runtime 后端关联
// 旧消息无 runtime（迁移前）→ 字段显「—」（规则12）
const senseGroupsText = computed(() => {
  const sg = props.item.runtime?.senseGroups;
  return sg && sg.length > 0 ? sg.join(", ") : "—";
});
const mcpServersText = computed(() => {
  const m = props.item.runtime?.mcpServers;
  return m && m.length > 0 ? m.join(", ") : "—";
});

const hasThinking = computed(
  () => !!props.item.thinking && props.item.thinking.trim().length > 0,
);
// assistant + subagent（子 pet 回复也可能调 sense）渲染 senseCalls；master/user 无
const hasSenseCalls = computed(
  () =>
    (props.item.role === "assistant" || props.item.role === "subagent") &&
    !!props.item.senseCalls &&
    props.item.senseCalls.length > 0,
);

// assistant/subagent/master 走 markdown（LLM 输出 / 主 pet prompt 注入）；user 纯文本
// （user 走 {{ }} 插值已 HTML 转义，字面 #/* 不被误解释为富文本）
const isMarkdown = computed(
  () =>
    props.item.role === "assistant" ||
    props.item.role === "subagent" ||
    props.item.role === "master",
);
const renderedContent = computed(() => renderMarkdown(props.item.content ?? ""));
</script>

<template>
  <div class="msg-row" :class="[roleClass, layoutClass]">
    <div v-if="item.role !== 'user'" class="avatar-wrap">
      <!-- 单头像：direct 模式 master·subagent（1:1 布局）/ assistant -->
      <template v-if="useSingleAvatar">
        <div class="avatar" :class="singleAvatarClass" aria-hidden="true">{{ singleAvatarText }}</div>
      </template>
      <!-- group master：主 pet 大头像（发言者）+ 子 pet 小徽章（对方） -->
      <template v-else-if="item.role === 'master'">
        <div class="avatar pet-master is-speaker" aria-hidden="true">{{ masterText }}</div>
        <div class="avatar pet-sub is-badge" aria-hidden="true">{{ subFace }}</div>
      </template>
      <!-- group subagent：子 pet 大头像（发言者，emoji+右上角 name 首字母）+ 主 pet 小徽章（对方） -->
      <template v-else-if="item.role === 'subagent'">
        <div class="avatar pet-sub is-speaker" aria-hidden="true">
          {{ subFace }}
          <span v-if="subNameInitial" class="name-initial" aria-hidden="true">{{ subNameInitial }}</span>
        </div>
        <div v-if="showMasterBadge" class="avatar pet-master is-badge" aria-hidden="true">{{ masterText }}</div>
      </template>
      <div class="info-panel" role="tooltip">
        <div class="panel-name">{{ resolvedName || "agent" }}</div>
        <dl class="panel-fields">
          <div class="field"><dt>brain</dt><dd>{{ item.runtime?.brain ?? "—" }}</dd></div>
          <div class="field"><dt>senseGroups</dt><dd>{{ senseGroupsText }}</dd></div>
          <div class="field"><dt>mcpServers</dt><dd>{{ mcpServersText }}</dd></div>
          <div v-if="item.role === 'subagent'" class="field"><dt>type</dt><dd>{{ subTypeText }}</dd></div>
        </dl>
      </div>
    </div>
    <div v-else class="avatar" :class="roleClass" aria-hidden="true">{{ avatarText }}</div>
    <div class="bubble" :class="roleClass">
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
      <pre v-if="hasThinking && showThinking" class="thinking-pre">{{ props.item.thinking }}</pre>
      <div v-if="props.item.content" class="content">
        <!-- eslint-disable-next-line vue/no-v-html -- markdown-it html:false 已转义，XSS 安全 -->
        <span v-if="isMarkdown" class="md" v-html="renderedContent" />
        <template v-else>{{ props.item.content }}</template>
      </div>
      <div v-if="hasSenseCalls" class="sense-list">
        <SenseCallBox
          v-for="(call, idx) in props.item.senseCalls"
          :key="`${call.name}-${idx}`"
          :call="call"
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;

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

.avatar {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 800;
  color: #fff;
  user-select: none;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);

  &.role-user {
    background: linear-gradient(135deg, #8a8f98, #4b5563);
  }
  &.role-assistant {
    background: linear-gradient(135deg, #ffd27a, #f6b73c);
    color: #3b2b12;
  }
  // 主 pet 头像（master 发言者大 / subagent 对方小徽章）：米色
  &.pet-master {
    background: linear-gradient(135deg, #ffd27a, #f6b73c);
    color: #3b2b12;
  }
  // 子 pet 头像（subagent 发言者大 / master 对方小徽章）：紫色
  &.pet-sub {
    background: linear-gradient(135deg, #c4b5fd, #7c3aed);
    color: #fff;
  }
  // 大头像（发言者）：相对定位，承载右上角 name 首字母小字
  &.is-speaker {
    position: relative;
  }
  // 小徽章（对方）：右下角叠加
  &.is-badge {
    position: absolute;
    bottom: -4px;
    right: -4px;
    width: 16px;
    height: 16px;
    font-size: 9px;
    border: 2px solid #fbf9f4;
  }
}

// 子 pet 大头像右上角 name 首字母小字（subagent 发言者标识，避开右下角小徽章）
.name-initial {
  position: absolute;
  top: -3px;
  right: -3px;
  min-width: 12px;
  height: 12px;
  padding: 0 2px;
  border-radius: 6px;
  background: #fbf9f4;
  color: #7c3aed;
  font-size: 8px;
  font-weight: 800;
  line-height: 12px;
  text-align: center;
  border: 1px solid rgba(124, 58, 237, 0.3);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}

.bubble {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  max-width: 92%;
  padding: 6px 10px;
  border-radius: 10px;
  background: #fbf9f4;
  border: 1px solid rgba(36, 38, 45, 0.1);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  word-break: break-word;

  &.role-user {
    background: linear-gradient(135deg, #fff7e0, #ffe9b8);
    border-color: rgba(246, 183, 60, 0.32);
  }
}

.avatar-wrap {
  position: relative;
  flex-shrink: 0;
}

// 双头像容器：限定尺寸，承载右下角小徽章绝对定位（仅 master/subagent 含 .is-speaker）
.avatar-wrap:has(.is-speaker) {
  width: 28px;
  height: 28px;
}

.info-panel {
  display: none;
  position: absolute;
  top: 0;
  left: calc(100% + 6px);
  z-index: 30;
  min-width: 168px;
  max-width: 220px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #ffffff;
  border: 1px solid rgba(36, 38, 45, 0.16);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.16);
  font-size: 11px;
  color: fade(@ink, 80%);
  pointer-events: none;

  .panel-name {
    font-size: 12px;
    font-weight: 800;
    color: fade(@ink, 88%);
    margin-bottom: 4px;
    word-break: break-word;
  }

  .panel-fields {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .field {
    display: flex;
    gap: 6px;
    line-height: 1.4;

    dt {
      flex-shrink: 0;
      min-width: 64px;
      color: fade(@ink, 50%);
      font-weight: 600;
    }

    dd {
      margin: 0;
      flex: 1;
      word-break: break-word;
    }
  }
}

.avatar-wrap:hover .info-panel,
.avatar-wrap:focus-within .info-panel {
  display: block;
}

// direct master 靠右 → info-panel 翻向左侧（防溢出右屏）
.msg-row.layout-direct.role-master .info-panel {
  left: auto;
  right: calc(100% + 6px);
}

.thinking-toggle {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 4px;
  border: none;
  background: transparent;
  color: fade(@ink, 50%);
  font-size: 10px;
  font-family: inherit;
  cursor: pointer;
  user-select: none;

  &:hover {
    color: fade(@ink, 78%);
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
  background: rgba(20, 22, 26, 0.05);
  color: fade(@ink, 66%);
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  max-height: 220px;
  overflow: auto;
}

.content {
  font-size: 13px;
  line-height: 1.5;
  color: fade(@ink, 88%);

  // markdown 渲染内容（assistant/subagent/master）；:deep 穿透 v-html 注入元素
  .md {
    :deep(p) {
      margin: 0 0 6px;
      &:last-child {
        margin: 0;
      }
    }
    :deep(h1),
    :deep(h2),
    :deep(h3),
    :deep(h4),
    :deep(h5),
    :deep(h6) {
      font-size: 14px;
      font-weight: 800;
      margin: 8px 0 4px;
      line-height: 1.3;
    }
    :deep(ul),
    :deep(ol) {
      margin: 4px 0;
      padding-left: 20px;
    }
    :deep(li) {
      margin: 2px 0;
    }
    :deep(li > ul),
    :deep(li > ol) {
      margin: 2px 0;
    }
    :deep(blockquote) {
      margin: 4px 0;
      padding: 2px 8px;
      border-left: 3px solid rgba(246, 183, 60, 0.5);
      color: fade(@ink, 66%);
    }
    :deep(a) {
      color: #b8860b;
      text-decoration: underline;
    }
    :deep(code) {
      font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
      font-size: 12px;
      padding: 1px 4px;
      border-radius: 3px;
      background: rgba(20, 22, 26, 0.06);
    }
    :deep(pre) {
      margin: 6px 0;
      overflow-x: auto;
      // 背景/padding/color 交由 github.html 的 .hljs 提供（避免双重样式）
    }
    :deep(pre code) {
      padding: 0;
      background: transparent;
      font-size: 11.5px;
    }
    :deep(hr) {
      border: none;
      border-top: 1px solid rgba(36, 38, 45, 0.15);
      margin: 8px 0;
    }
    :deep(img) {
      max-width: 100%;
      border-radius: 4px;
    }
    :deep(table) {
      border-collapse: collapse;
      margin: 6px 0;
      font-size: 12px;
    }
    :deep(th),
    :deep(td) {
      border: 1px solid rgba(36, 38, 45, 0.15);
      padding: 3px 6px;
    }
    :deep(th) {
      background: rgba(20, 22, 26, 0.04);
      font-weight: 700;
    }
  }
}

// user 纯文本：保留换行/连续空格/制表符（pre-wrap）；不走 markdown 渲染
// （{{ }} 插值已 HTML 转义，字面 #/* 不被误解释为富文本）
.msg-row.role-user .content {
  white-space: pre-wrap;
}

.sense-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 2px;
}
</style>
