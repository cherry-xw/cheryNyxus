<script setup lang="ts">
/**
 * PresetsTab：预设管理（config.presets）。
 * 每预设 = 团队成员多选（引用 config.roles 单一源）+ 指定组长（leader）。
 * 运行时采用组长的角色配置（不在预设内重定义 brain/sense）。
 * 增删预设走底部输入框 + ConfirmPopover 二次确认；标题可点击改名。合法性由后端 config.save 校验 fail loud。
 */
import { ref } from "vue";
import { ArrowDown, Check, Delete } from "@element-plus/icons-vue";
import type { ConfigDto, SenseToolInfo } from "@/services/agentApi";
import ConfirmPopover from "../ConfirmPopover.vue";
import EditableTitle from "../components/EditableTitle.vue";
import SenseIcon from "../components/SenseIcon.vue";

const props = defineProps<{ draft: ConfigDto; senseTools: SenseToolInfo[] }>();
const emit = defineEmits<{ (e: "error", msg: string): void }>();

const newPresetName = ref("");

function onError(msg: string): void {
  emit("error", msg);
}

function addPreset(): void {
  const name = newPresetName.value.trim();
  if (!name) return;
  if (!props.draft.presets) props.draft.presets = {};
  if (props.draft.presets[name]) {
    emit("error", `预设 "${name}" 已存在`);
    return;
  }
  // 初始化：空组长 + 空成员。添加成员后选择组长（后端校验组长必填）。
  props.draft.presets[name] = { leader: "", roles: [] };
  newPresetName.value = "";
}

function removePreset(name: string): void {
  if (!props.draft.presets) return;
  delete props.draft.presets[name];
}

/** 改名：保序重建 presets。 */
function renamePreset(oldName: string, newName: string): void {
  if (!props.draft.presets) return;
  const cfg = props.draft.presets[oldName];
  const rebuilt = {} as typeof props.draft.presets;
  for (const [k, v] of Object.entries(props.draft.presets)) {
    if (k === oldName) rebuilt[newName] = cfg!;
    else rebuilt[k] = v;
  }
  props.draft.presets = rebuilt;
  emit("error", "");
}
function validateRename(newName: string): string | null {
  if (!props.draft.presets) return null;
  return props.draft.presets[newName] ? `预设 "${newName}" 已存在` : null;
}

/** 下拉多选成员；移除当前组长时同步清空组长。 */
function updateMembers(pname: string, roles: string[]): void {
  const p = props.draft.presets?.[pname];
  if (!p) return;
  p.roles = roles;
  if (p.leader && !roles.includes(p.leader)) p.leader = "";
}

/** 点击已选角色卡设为组长。 */
function setLeader(pname: string, role: string): void {
  const p = props.draft.presets?.[pname];
  if (!p) return;
  if (!(p.roles ?? []).includes(role)) p.roles = [...(p.roles ?? []), role];
  p.leader = role;
}
</script>

<template>
  <section class="sect">
    <p class="sect-hint">预设用于快速组建团队：选择成员，再从成员中指定组长。保存后的修改只会用于之后新建的会话，进行中的会话不受影响。</p>

    <article v-for="(preset, pname, idx) in draft.presets" :key="pname" class="card">
      <span class="card-idx">{{ idx + 1 }}</span>
      <header class="card-head">
        <EditableTitle
          :model-value="pname as string"
          :validate="validateRename"
          @rename="(n: string) => renamePreset(pname as string, n)"
          @error="onError"
        >
          <template #actions>
            <el-dropdown trigger="click" :hide-on-click="false" class="member-picker">
              <button type="button" class="member-picker-trigger" aria-label="选择团队成员">
                <span>选择成员</span>
                <ArrowDown class="picker-arrow" />
              </button>
              <template #dropdown>
                <el-dropdown-menu class="member-picker-menu">
                  <el-checkbox-group
                    :model-value="preset.roles ?? []"
                    @update:model-value="(roles: string[]) => updateMembers(pname as string, roles)"
                  >
                    <el-checkbox v-for="(_, rname) in draft.roles" :key="rname" :value="rname as string">
                      {{ rname }}
                    </el-checkbox>
                  </el-checkbox-group>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <ConfirmPopover :title="`确认删除预设「${pname}」？`" @confirm="removePreset(pname as string)">
              <template #trigger>
                <button type="button" class="icon-btn danger" aria-label="删除预设">
                  <Delete class="ico" />
                </button>
              </template>
            </ConfirmPopover>
          </template>
        </EditableTitle>
      </header>

      <div class="field">
        <span class="lbl">团队成员与组长</span>
        <template v-if="draft.roles && Object.keys(draft.roles).length">
          <div v-if="preset.roles?.length" class="member-roles">
            <button
              v-for="rname in preset.roles"
              :key="rname"
              class="member-role"
              :class="{ leader: preset.leader === rname }"
              :aria-label="`设 ${rname} 为组长`"
              :title="preset.leader === rname ? `${rname}（当前组长）` : `点击设 ${rname} 为组长`"
              @click="setLeader(pname as string, rname)"
            >
              <span class="member-role-name">{{ rname }}</span>
              <span v-if="draft.roles[rname]" class="member-role-card">
                <span class="member-card-line"><b>大脑</b>{{ draft.roles[rname].brain || '未选' }}</span>
                <span class="member-card-line"><b>感官组</b>{{ draft.roles[rname].senseGroup || '未选' }}</span>
                <span v-if="draft.roles[rname].senseGroup" class="member-card-senses">
                  <template v-for="entry in (draft.sense_groups?.[draft.roles[rname].senseGroup] ?? [])" :key="entry">
                    <SenseIcon :name="entry" :tools="senseTools" />
                  </template>
                  <span v-if="!(draft.sense_groups?.[draft.roles[rname].senseGroup] ?? []).length" class="no-senses">未配置能力</span>
                </span>
                <span v-if="draft.roles[rname].mcpServers?.length" class="member-card-line"><b>MCP</b>{{ draft.roles[rname].mcpServers.join('、') }}</span>
              </span>
              <span v-if="preset.leader === rname" class="leader-mark" aria-label="当前组长">
                <Check />
              </span>
            </button>
          </div>
          <span class="hint">在上方选择团队成员；点击成员卡片即可设为组长。</span>
        </template>
        <span v-else class="empty">请先在「角色」中添加成员</span>
        <span v-if="preset.roles && preset.roles.length && !preset.leader" class="hint">⚠️ 必须指定组长</span>
        <span v-else-if="!preset.roles || !preset.roles.length" class="hint">先选择团队成员</span>
      </div>
    </article>

    <p v-if="!draft.presets || !Object.keys(draft.presets).length" class="empty">
      暂无预设。输入名称后新建一个团队预设。
    </p>

    <div class="add-row">
      <el-input v-model="newPresetName" placeholder="新预设名（如 light / project）" @keydown.enter="addPreset" />
      <button type="button" class="ghost-btn" @click="addPreset">+ 新增预设</button>
    </div>
  </section>
</template>

<style scoped lang="less">
@import "../shared.less";

.member-picker-trigger {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 24px;
  padding: 0 7px;
  border: 1px solid rgba(36, 38, 45, 0.2);
  border-radius: 5px;
  background: #fff;
  color: rgba(20, 22, 26, 0.7);
  font-size: 11px;
  cursor: pointer;
  &:hover {
    border-color: rgba(246, 183, 60, 0.8);
    color: rgba(20, 22, 26, 0.9);
  }
}
.picker-arrow {
  width: 11px;
  height: 11px;
}
.member-picker-menu {
  min-width: 128px;
  padding: 5px 9px;
  :deep(.el-checkbox-group) {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  :deep(.el-checkbox) {
    margin-right: 0;
    font-size: 12px;
  }
}
.member-roles {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.member-role {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  padding: 0 9px;
  border: 1px solid rgba(20, 22, 26, 0.18);
  border-radius: 6px;
  background: #fff;
  color: rgba(20, 22, 26, 0.62);
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
  &:hover,
  &:focus-visible {
    outline: none;
    border-color: rgba(246, 183, 60, 0.75);
    background: rgba(246, 183, 60, 0.1);
    color: rgba(20, 22, 26, 0.9);
  }
  &.leader {
    padding-right: 20px;
    border-color: #d99717;
    background: rgba(246, 183, 60, 0.23);
  }
}
.member-role-name {
  font-size: 12px;
  font-weight: 700;
  color: rgba(20, 22, 26, 0.86);
}
.member-role-card {
  position: absolute;
  z-index: 3;
  left: 0;
  top: calc(100% + 7px);
  display: none;
  width: max-content;
  max-width: 260px;
  padding: 8px 10px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 8px;
  background: #fffdf8;
  box-shadow: 0 5px 14px rgba(36, 38, 45, 0.14);
  color: rgba(20, 22, 26, 0.72);
  font-size: 10px;
  line-height: 1.35;
}
.member-role:hover .member-role-card,
.member-role:focus-visible .member-role-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.member-card-line {
  display: flex;
  gap: 6px;
  b {
    color: rgba(20, 22, 26, 0.48);
    font-weight: 700;
  }
}
.member-card-senses {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-height: 15px;
  padding-top: 2px;
  border-top: 1px solid rgba(20, 22, 26, 0.08);
}
.no-senses {
  color: rgba(20, 22, 26, 0.42);
}
.leader-mark {
  position: absolute;
  top: -1px;
  right: -0.6px;
  width: 24px;
  height: 14px;
  display: inline-flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 2px 2px 0 0;
  box-sizing: border-box;
  // 右上贴合成员 pill 的圆角；左下留出斜切的三角缺口。
  border-radius: 0 6px 0 0;
  clip-path: polygon(100% 0, 100% 100%, 0 0);
  background: #d99717;
  color: #fff;
  svg {
    width: 6px;
    height: 6px;
  }
}
</style>
