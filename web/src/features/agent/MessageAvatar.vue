<script setup lang="ts">
/**
 * MessageAvatar：消息头像渲染（含 hover 详情面板）。
 * 从 MessageBubble 拆出，承载所有 role 分支的头像/徽章/角标/面板逻辑。
 *
 * role 分支：
 * - useSingleAvatar（direct 模式 master/role + assistant）：单头像
 * - mergedChildToMaster（layout=group + mergedView=child-to-master）：子 pet 大头像 + send-direction 角标 + 父 pet 徽章
 * - master：主 pet 大头像（发言者）+ 子 pet 小徽章（对方）
 * - role/subagent：子 pet 大头像（emoji+右上角 name 首字母）+ caller 小徽章（对方）
 *
 * 头像来源：主 pet = masterPetName 首字符；子 pet = subPetFace（face.calm emoji）。
 * 被唤起 agent 头像可点击 → emit jumpToSpawn，由父组件转发到 HistoryDrawer smooth scroll。
 */
import { computed } from "vue";
import type { HistoryItem } from "@/stores/agents";

const props = defineProps<{
  item: HistoryItem;
  role: string;
  layout: "group" | "direct";
  masterPetName?: string;
  subPetName?: string;
  subPetFace?: string;
  subPetType?: string;
  showMasterBadge?: boolean;
  callerPetFace?: string;
  callerPetName?: string;
  callerIsMaster?: boolean;
  canJumpToSpawn?: boolean;
  mergedChildToMaster?: boolean;
}>();

const emit = defineEmits<{
  (e: "jumpToSpawn", payload: { senseCallId: string }): void;
}>();

// ── avatar computeds ──────────────────────────────────────────────

/** 主 pet 头像文字（name 首字符，fallback ⊙） */
const masterText = computed(() => props.masterPetName?.charAt(0).toUpperCase() || "⊙");
/** 子 pet emoji face（fallback 🤖） */
const subFace = computed(() => props.subPetFace || "🤖");
/** 子 pet name 首字母（role 大头像右上角小字；空则不渲染） */
const subNameInitial = computed(() => props.subPetName?.charAt(0).toUpperCase() || "");
/** hover 面板 type 字段：合并式 subPetType，注入式 item.petName，缺则 — */
const subTypeText = computed(() => props.subPetType || props.item.petName || "—");
/** caller 头像文字（role 分支徽章用：caller pet face emoji 或 masterText fallback） */
const callerFace = computed(() => props.callerPetFace || masterText.value);
/** caller 名字（hover 面板 name：caller name 优先于 sub pet name；用于多级 spawn 显示上级） */
const resolvedCallerName = computed(() => props.callerPetName || "");

/** direct 模式（ghost 自身抽屉）：master/role 走单头像 1:1 布局。assistant 恒单头像。 */
const useSingleAvatar = computed(() => props.layout === "direct" || props.item.role === "assistant");
const singleAvatarClass = computed(() => {
  if (props.item.role === "master") return "pet-master";
  if (props.item.role === "subagent" || props.item.role === "role") return "pet-sub";
  return "role-assistant";
});
const singleAvatarText = computed(() => {
  if (props.item.role === "subagent" || props.item.role === "role") return subFace.value;
  return masterText.value; // master / assistant
});

/** hover 面板 name 表示发言者：master/assistant=主 pet；role=子 pet。 */
const resolvedName = computed(() => {
  switch (props.item.role) {
    case "master":
    case "assistant":
      return props.masterPetName || "";
    case "subagent":
    case "role":
      return props.subPetName || props.item.petName || resolvedCallerName.value || "";
    default:
      return "";
  }
});

// hover 详情面板 runtime：user=发送时配置，assistant=前一条 user runtime 后端关联
// 旧消息无 runtime（迁移前）→ 字段显「—」（规则12）
const senseGroupsText = computed(() => {
  const sg = props.item.runtime?.senseGroup;
  return sg && sg.length > 0 ? sg : "-";
});
const mcpServersText = computed(() => {
  const m = props.item.runtime?.mcpServers;
  return m && m.length > 0 ? m.join(", ") : "—";
});

// ── click → jumpToSpawn ───────────────────────────────────────────

function onAvatarClick(): void {
  const sid = props.item.spawnSenseCallId;
  if (!sid) return;
  emit("jumpToSpawn", { senseCallId: sid });
}
</script>

<template>
  <div class="avatar-wrap">
    <!-- 单头像：direct 模式 master·subagent（1:1 布局）/ assistant -->
    <template v-if="useSingleAvatar">
      <div class="avatar" :class="singleAvatarClass" aria-hidden="true">{{ singleAvatarText }}</div>
    </template>
    <!-- F-展示合并：子 pet 发送消息给父 pet（新视觉）。
         大头像 = 子 pet face（紫）+ name 首字母 + 左下「→」send-direction 角标；
         小徽章 = 实际父 pet。仅 layout=group + mergedView 触发。 -->
    <template v-else-if="mergedChildToMaster && layout === 'group'">
      <div
        class="avatar pet-sub is-speaker is-child-to-master"
        :class="{ 'is-clickable': canJumpToSpawn }"
        :tabindex="canJumpToSpawn ? 0 : -1"
        :title="canJumpToSpawn ? '点击跳到 spawn 工具调用' : undefined"
        role="button"
        :aria-label="canJumpToSpawn ? '跳到 spawn 工具调用' : undefined"
        @click="onAvatarClick"
        @keydown.enter.space.prevent="onAvatarClick"
        aria-hidden="true"
      >
        {{ subFace }}
        <span v-if="subNameInitial" class="name-initial" aria-hidden="true">{{ subNameInitial }}</span>
        <span class="send-direction" aria-hidden="true">→</span>
      </div>
      <div class="avatar is-badge" :class="callerIsMaster === false ? 'pet-sub' : 'pet-master'" aria-hidden="true">
        {{ callerIsMaster === false ? callerFace : masterText }}
      </div>
    </template>
    <!-- group master：主 pet 大头像（发言者）+ 子 pet 小徽章（对方） -->
    <template v-else-if="item.role === 'master'">
      <div
        class="avatar pet-master is-speaker"
        :class="{ 'is-clickable': canJumpToSpawn }"
        :tabindex="canJumpToSpawn ? 0 : -1"
        :title="canJumpToSpawn ? '点击跳到 spawn 工具调用' : undefined"
        role="button"
        :aria-label="canJumpToSpawn ? '跳到 spawn 工具调用' : undefined"
        @click="onAvatarClick"
        @keydown.enter.space.prevent="onAvatarClick"
        aria-hidden="true"
      >{{ masterText }}</div>
      <div class="avatar pet-sub is-badge" aria-hidden="true">{{ subFace }}</div>
    </template>
    <!-- group subagent（旧）/ role（新）：子 pet 大头像（发言者，emoji+右上角 name 首字母）+ caller 小徽章（对方）
         多级 spawn 时 caller 是上层 sub pet（callerIsMaster=false → pet-sub + callerFace emoji） -->
    <template v-else-if="item.role === 'subagent' || item.role === 'role'">
      <div
        class="avatar pet-sub is-speaker"
        :class="{ 'is-clickable': canJumpToSpawn }"
        :tabindex="canJumpToSpawn ? 0 : -1"
        :title="canJumpToSpawn ? '点击跳到 spawn 工具调用' : undefined"
        role="button"
        :aria-label="canJumpToSpawn ? '跳到 spawn 工具调用' : undefined"
        @click="onAvatarClick"
        @keydown.enter.space.prevent="onAvatarClick"
        aria-hidden="true"
      >
        {{ subFace }}
        <span v-if="subNameInitial" class="name-initial" aria-hidden="true">{{ subNameInitial }}</span>
      </div>
      <div v-if="showMasterBadge" class="avatar is-badge" :class="callerIsMaster === false ? 'pet-sub' : 'pet-master'" aria-hidden="true">
        {{ callerIsMaster === false ? callerFace : masterText }}
      </div>
    </template>
    <div class="info-panel" role="tooltip">
      <div class="panel-name">{{ resolvedName || "agent" }}</div>
      <dl class="panel-fields">
        <div class="field"><dt>brain</dt><dd>{{ item.runtime?.brain ?? "—" }}</dd></div>
        <div class="field"><dt>senseGroup</dt><dd>{{ senseGroupsText }}</dd></div>
        <div class="field"><dt>mcpServers</dt><dd>{{ mcpServersText }}</dd></div>
        <div v-if="mergedChildToMaster || item.role === 'subagent' || item.role === 'role'" class="field"><dt>type</dt><dd>{{ subTypeText }}</dd></div>
      </dl>
    </div>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;

.avatar-wrap {
  position: relative;
  flex-shrink: 0;
}

// 头像基础圆 + 字色 + 阴影（原在 MessageBubble.vue scoped，跨子组件失效，迁回此处）
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

  // assistant 单头像：暖橙
  &.role-assistant {
    background: linear-gradient(135deg, #ffd27a, #f6b73c);
    color: #3b2b12;
  }
  // 主 pet 头像（master 发言者大 / role 对方小徽章）：米色
  &.pet-master {
    background: linear-gradient(135deg, #ffd27a, #f6b73c);
    color: #3b2b12;
  }
  // 子 pet 头像（role 发言者大 / master 对方小徽章）：紫色
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

// 双头像容器：限定尺寸，承载右下角小徽章绝对定位（仅 master/role 含 .is-speaker）
.avatar-wrap:has(.is-speaker) {
  width: 28px;
  height: 28px;
}

// 子 pet 大头像右上角 name 首字母小字（role 发言者标识，避开右下角小徽章）
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

// F：被唤起 agent 头像点击 → smooth scroll 到 spawn sense call
.avatar.is-clickable {
  cursor: pointer;
  transition: transform 160ms ease;

  &:hover {
    transform: scale(1.06);
  }
  &:focus-visible {
    outline: 2px solid #7c3aed;
    outline-offset: 2px;
  }
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

// F-展示合并：子 pet 大头像左下角「→」send-direction 角标（明示"发送给主"方向）
.send-direction {
  position: absolute;
  bottom: -3px;
  left: -3px;
  min-width: 12px;
  height: 12px;
  padding: 0 2px;
  border-radius: 6px;
  background: #fbf9f4;
  color: #f6b73c;
  font-size: 9px;
  font-weight: 800;
  line-height: 12px;
  text-align: center;
  border: 1px solid rgba(246, 183, 60, 0.4);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}

// F-展示合并：info-panel name 加「↗」前缀，标识"发给主 pet"方向
.msg-row.is-child-to-master .panel-name::before {
  content: "↗ ";
  color: fade(@ink, 50%);
  font-weight: 600;
}
</style>
