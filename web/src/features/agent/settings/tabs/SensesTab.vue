<script setup lang="ts">
/**
 * SensesTab：感官分组（sense_groups）配置。
 * 组名可点击改名（迁移 default/subagents 引用）。
 * tag 化：每组已配工具显为可关闭 el-tag，监管等级挂 tag 内（点循环：继承→auto→confirm→manual）；
 * 一个 el-select（filterable + allow-create）作「加工具」入口，选项显中文名 + 说明。
 *   - 防重复：同组同名工具只一份；下拉剔除已选工具；allow-create 输入已选名也被拦。
 *   - 一行 3 个：flex 三等分，tag 名 ellipsis；hover tag 显工具描述（title）。
 * 删组走 ConfirmPopover 二次确认；工具移除=tag 关闭（频繁操作，不二次确认）。
 */
import { ref } from "vue";
import { Check, Close, Delete } from "@element-plus/icons-vue";
import type { ConfigDto, SenseToolInfo } from "@/services/agentApi";
import { SUPERVISIONS } from "../constants";
import { toolName, toolLevel, isDangerousSense, matchedTool } from "../shared";
import ConfirmPopover from "../ConfirmPopover.vue";

const props = defineProps<{ draft: ConfigDto; senseTools: SenseToolInfo[] }>();
const emit = defineEmits<{ (e: "error", msg: string): void }>();

const newGroupName = ref("");
const editingGroupName = ref<string | null>(null);
const editGroupValue = ref("");
const vFocus = { mounted: (el: HTMLElement) => el.querySelector("input")?.focus() };

// 监管等级循环序：继承('') → auto → confirm → manual → 继承
const LEVELS = ["", ...SUPERVISIONS] as const;

function addGroup(): void {
  const name = newGroupName.value.trim();
  if (!name) return;
  if (!props.draft.sense_groups) props.draft.sense_groups = {};
  if (props.draft.sense_groups[name]) {
    emit("error", `感官组 "${name}" 已存在`);
    return;
  }
  props.draft.sense_groups[name] = [];
  newGroupName.value = "";
}
function removeGroup(name: string): void {
  if (!props.draft.sense_groups) return;
  delete props.draft.sense_groups[name];
}
function startRenameGroup(name: string): void {
  editingGroupName.value = name;
  editGroupValue.value = name;
  emit("error", "");
}
function cancelRenameGroup(): void {
  editingGroupName.value = null;
  editGroupValue.value = "";
}
function commitGroupName(oldName: string): void {
  if (!props.draft.sense_groups) return;
  const newName = editGroupValue.value.trim();
  if (!newName || newName === oldName) {
    editingGroupName.value = null;
    return;
  }
  if (props.draft.sense_groups[newName]) {
    emit("error", `感官组 "${newName}" 已存在`);
    return;
  }
  // 重建对象保持原顺序（不能 delete+add，否则 key 跳到末尾）
  const rebuilt = {} as typeof props.draft.sense_groups;
  for (const [k, v] of Object.entries(props.draft.sense_groups)) {
    if (k === oldName) rebuilt[newName] = v;
    else rebuilt[k] = v;
  }
  props.draft.sense_groups = rebuilt;
  // 迁移引用，避免 default/subagents 指向已改名组
  if (props.draft.default?.senseGroups) {
    props.draft.default.senseGroups = props.draft.default.senseGroups.map((g) =>
      g === oldName ? newName : g,
    );
  }
  if (props.draft.subagents) {
    for (const sa of Object.values(props.draft.subagents)) {
      if (sa.senseGroups) {
        sa.senseGroups = sa.senseGroups.map((g) => (g === oldName ? newName : g));
      }
    }
  }
  editingGroupName.value = null;
  emit("error", "");
}

// 工具行 entry 为 "name" 或 "name:level"，直接操作 string[]
function setToolLevel(group: string, idx: number, level: string): void {
  const arr = props.draft.sense_groups?.[group];
  if (!arr) return;
  const name = toolName(arr[idx] ?? "");
  arr[idx] = level ? `${name}:${level}` : name;
}
function removeTool(group: string, idx: number): void {
  const arr = props.draft.sense_groups?.[group];
  if (!arr) return;
  arr.splice(idx, 1);
}
// 加工具：select 受控恒空（作「加工具」入口），选中即 push（默认继承等级），不回写 → 自动复位 placeholder。
// 防重复：按工具名查重，命中 emit error 不 push。
function onAddTool(group: string, raw: unknown): void {
  const arr = props.draft.sense_groups?.[group];
  if (!arr || typeof raw !== "string" || !raw) return;
  if (arr.some((e) => toolName(e) === raw)) {
    emit("error", `工具 "${raw}" 已在本组中`);
    return;
  }
  arr.push(raw);
}
// 点 tag 内等级标循环切换
function cycleLevel(group: string, idx: number): void {
  const arr = props.draft.sense_groups?.[group];
  if (!arr) return;
  const cur = toolLevel(arr[idx] ?? "");
  const i = LEVELS.indexOf(cur as (typeof LEVELS)[number]);
  const next = LEVELS[(i + 1) % LEVELS.length];
  setToolLevel(group, idx, next);
}

// 下拉剔除本组已选工具（按工具名）
function availableTools(group: string): SenseToolInfo[] {
  const arr = props.draft.sense_groups?.[group] ?? [];
  const used = new Set(arr.map((e) => toolName(e)));
  return props.senseTools.filter((t) => !used.has(t.name));
}
// tag hover 描述：命中内置工具返回其 description，自定义工具返回空（title="" 不显）
function toolDesc(entry: string): string {
  return matchedTool(entry, props.senseTools)?.description ?? "";
}
// tag 显示名：命中内置工具显中文 label，自定义工具回退原名
function toolLabel(entry: string): string {
  return matchedTool(entry, props.senseTools)?.label ?? toolName(entry);
}

function levelLabel(level: string): string {
  return level || "继承";
}
// tag 着色按监管松紧：auto（放权）= danger，confirm = warning，manual/info = info，继承 = info+plain
function levelTagType(level: string): "info" | "warning" | "danger" {
  switch (level) {
    case "auto":
      return "danger";
    case "confirm":
      return "warning";
    default:
      return "info";
  }
}
</script>

<template>
  <section class="sect">
    <p class="sect-hint">给宠物装配的感官套餐。组名可点击改名；每组工具显为 tag，点 tag 内等级标切换监管，✕ 移除，hover 看说明。</p>
    <p class="warn-hint">⚠️ execute_command / write_file 类感官危险（能跑命令/写文件）；配 :auto 等于放它自己执行不问你。</p>
    <article v-for="(_, gname) in draft.sense_groups" :key="gname" class="card">
      <header class="card-head">
        <span class="card-title">
          <el-input
            v-if="editingGroupName === gname"
            v-focus
            v-model="editGroupValue"
            class="card-name-input"
            size="small"
            @keydown.enter="commitGroupName(gname as string)"
            @keydown.esc="cancelRenameGroup()"
          />
          <span v-else class="card-name editable" title="点击改名" @click="startRenameGroup(gname as string)">{{ gname }}</span>
        </span>
        <span class="card-actions">
          <template v-if="editingGroupName === gname">
            <button type="button" class="icon-btn ok" aria-label="确认改名" @click="commitGroupName(gname as string)">
              <Check class="ico" />
            </button>
            <button type="button" class="icon-btn" aria-label="取消" @click="cancelRenameGroup()">
              <Close class="ico" />
            </button>
          </template>
          <template v-else>
            <ConfirmPopover :title="`确认删除感官组「${gname}」？`" @confirm="removeGroup(gname as string)">
              <template #trigger>
                <button type="button" class="icon-btn danger" aria-label="删除">
                  <Delete class="ico" />
                </button>
              </template>
            </ConfirmPopover>
          </template>
        </span>
      </header>
      <div class="tags">
        <el-tag
          v-for="(entry, idx) in (draft.sense_groups?.[gname as string] ?? [])"
          :key="idx"
          :type="levelTagType(toolLevel(entry))"
          :effect="toolLevel(entry) ? 'light' : 'plain'"
          :title="toolDesc(entry)"
          closable
          size="default"
          class="sense-tag"
          @close="removeTool(gname as string, idx)"
        >
            <span class="tag-name">
              <span v-if="isDangerousSense(entry)" class="danger-mark" title="危险感官">⚠</span>{{ toolLabel(entry) }}
            </span>
            <span
              class="tag-level-btn"
              :class="{ inherit: !toolLevel(entry) }"
              :title="`监管等级（点切换）：${levelLabel(toolLevel(entry))}`"
              @click.stop="cycleLevel(gname as string, idx)"
            >{{ levelLabel(toolLevel(entry)) }}</span>
        </el-tag>
        <span v-if="!(draft.sense_groups?.[gname as string]?.length)" class="empty">无工具，点右侧添加 →</span>
        <el-select
          :model-value="''"
          filterable
          allow-create
          default-first-option
          placeholder="+ 加工具"
          class="add-tool-select"
          popper-class="sense-tool-popper"
          @update:model-value="onAddTool(gname as string, $event)"
        >
          <el-option v-for="t in availableTools(gname as string)" :key="t.name" :value="t.name" :label="t.label">
            <div class="opt-item">
              <span class="opt-label">{{ t.label }}</span>
              <span class="opt-desc" :title="t.description">{{ t.description }}</span>
            </div>
          </el-option>
        </el-select>
      </div>
      <p v-if="(draft.sense_groups?.[gname as string] ?? []).some(isDangerousSense)" class="warn-hint">
        ⚠️ 含危险感官
      </p>
    </article>
    <div class="add-row">
      <el-input v-model="newGroupName" placeholder="新组名" @keydown.enter="addGroup" />
      <button type="button" class="ghost-btn" @click="addGroup">+ 新增组</button>
    </div>
  </section>
</template>

<style scoped lang="less">
@import "../shared.less";

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
// 一行 3 个：三等分（2 个 gap × 6px）
.sense-tag {
  width: calc((100% - 12px) / 3);
  max-width: 100%;
  box-sizing: border-box;
  font-size: 12px;
  cursor: default;
  // el-tag 根默认 justify-content:center → 内容居中、两侧留空。
  // 改：content 撑满，工具名居左、监管等级靠右，EP 自带 close ✕ 紧随最右。
  justify-content: flex-start;
  :deep(.el-tag__content) {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
  }
}
.add-tool-select {
  width: calc((100% - 12px) / 3);
  max-width: 100%;
}
.tag-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  .danger-mark {
    color: #991b1b;
    margin-right: 2px;
  }
}
.tag-level-btn {
  flex-shrink: 0;
  padding-left: 6px;
  border-left: 1px solid rgba(20, 22, 26, 0.15);
  cursor: pointer;
  font-size: 11px;
  opacity: 0.75;
  user-select: none;
  &:hover {
    opacity: 1;
  }
  &.inherit {
    font-style: italic;
    opacity: 0.5;
  }
}
</style>

<!--
  el-select 下拉面板默认 teleport 到 body，scoped 样式无法穿透。
  故用 popper-class="sense-tool-popper" + 非 scoped 全局样式定制选项（中文名 + 说明两行）。
-->
<style lang="less">
.sense-tool-popper {
  .opt-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    overflow: hidden;
  }
  .opt-label {
    font-size: 13px;
    flex-shrink: 0;
  }
  .opt-desc {
    font-size: 11px;
    color: rgba(20, 22, 26, 0.45);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
}
</style>
