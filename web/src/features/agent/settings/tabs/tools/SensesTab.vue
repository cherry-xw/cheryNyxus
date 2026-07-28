<script setup lang="ts">
/**
 * SensesTab：器官（sense_groups）配置。
 * 瀑布流：组卡按工具数自然分列（CSS columns），列高随工具数；无需 footer 圆点导航。
 * 组名可点击改名（迁移 default/roles 引用）。
 * tag 化：每组已配工具显为可关闭 el-tag，监管等级挂 tag 内（点循环：继承→auto→confirm→manual）；
 * 一个 el-select（filterable + allow-create）作「加工具」入口，选项显中文名 + 说明。
 *   - 防重复：同组同名工具只一份；下拉剔除已选工具；allow-create 输入已选名也被拦。
 *   - 一列一个：flex-direction column，tag 名 ellipsis；hover tag 显工具描述（title）。
 * 删组走 ConfirmPopover 二次确认；工具移除=tag 关闭（频繁操作，不二次确认）。
 * 字段名 sense_groups / senseGroup 保留（后端协议），仅 UI 文案改"器官"。
 */
import { ref, computed, reactive, nextTick } from 'vue'
import { Delete, Plus } from '@element-plus/icons-vue'
import type { ConfigDto, SenseToolInfo } from '@/services/agentApi'
import { SUPERVISIONS, SUPERVISION_LABEL } from '../../config/constants'
import { toolName, toolLevel, isDangerousSense, matchedTool } from '../../config/shared'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import EditableTitle from '@/components/input/EditableTitle.vue'
import SenseIcon from './SenseIcon.vue'
import TabShell, { type IndexItem } from '@/components/layout/TabShell.vue'

const props = defineProps<{ draft: ConfigDto; senseTools: SenseToolInfo[] }>()
const emit = defineEmits<{ (e: 'error', msg: string): void }>()

const newGroupName = ref('')

function onError(msg: string): void {
  emit('error', msg)
}

// 监管等级循环序：继承('') → auto → smart → manual → 继承
const LEVELS = ['', ...SUPERVISIONS] as const

function addGroup(): void {
  const name = newGroupName.value.trim()
  if (!name) return
  if (!props.draft.sense_groups) props.draft.sense_groups = {}
  if (props.draft.sense_groups[name]) {
    emit('error', `器官组 "${name}" 已存在`)
    return
  }
  props.draft.sense_groups[name] = []
  newGroupName.value = ''
}
function removeGroup(name: string): void {
  if (!props.draft.sense_groups) return
  delete props.draft.sense_groups[name]
}
/** 改名：保序重建 sense_groups + 迁移角色引用。 */
function renameGroup(oldName: string, newName: string): void {
  if (!props.draft.sense_groups) return
  // 重建对象保持原顺序（不能 delete+add，否则 key 跳到末尾）
  const rebuilt = {} as typeof props.draft.sense_groups
  for (const [k, v] of Object.entries(props.draft.sense_groups)) {
    if (k === oldName) rebuilt[newName] = v
    else rebuilt[k] = v
  }
  props.draft.sense_groups = rebuilt
  // 迁移角色引用，避免 roles 指向已改名组。
  if (props.draft.roles) {
    for (const sa of Object.values(props.draft.roles)) {
      if (sa.senseGroup === oldName) {
        sa.senseGroup = newName
      }
    }
  }
  emit('error', '')
}
function validateRename(newName: string): string | null {
  return props.draft.sense_groups?.[newName] ? `器官组 "${newName}" 已存在` : null
}

// 工具行 entry 为 "name" 或 "name:level"，直接操作 string[]
function setToolLevel(group: string, idx: number, level: string): void {
  const arr = props.draft.sense_groups?.[group]
  if (!arr) return
  const name = toolName(arr[idx] ?? '')
  arr[idx] = level ? `${name}:${level}` : name
}
function removeTool(group: string, idx: number): void {
  const arr = props.draft.sense_groups?.[group]
  if (!arr) return
  arr.splice(idx, 1)
}
// 加工具：select 受控恒空（作「加工具」入口），选中即 push（默认继承等级），不回写 → 自动复位 placeholder。
// 防重复：按工具名查重，命中 emit error 不 push。
function onAddTool(group: string, raw: unknown): void {
  const arr = props.draft.sense_groups?.[group]
  if (!arr || typeof raw !== 'string' || !raw) return
  if (arr.some((e) => toolName(e) === raw)) {
    emit('error', `工具 "${raw}" 已在本组中`)
    return
  }
  arr.push(raw)
}
// 加工具 popover 内 el-select 实例表（per-group）：popover 展开时自动 focus select，直达选项过滤/输入。
const addSelectRefs: Record<string, { focus: () => void } | undefined> = {}
function setAddSelectRef(group: string, el: unknown): void {
  if (el) addSelectRefs[group] = el as { focus: () => void }
  else delete addSelectRefs[group]
}
// 行内加工具：点 + 切换为行内 select（替换 icon），失焦收起；选完复位可连续加。
const addingGroups = reactive(new Set<string>())
function openAdd(group: string): void {
  addingGroups.add(group)
  nextTick(() => addSelectRefs[group]?.focus())
}
function closeAdd(group: string): void {
  addingGroups.delete(group)
}
// 点 tag 内等级标循环切换
function cycleLevel(group: string, idx: number): void {
  const arr = props.draft.sense_groups?.[group]
  if (!arr) return
  const cur = toolLevel(arr[idx] ?? '')
  const i = LEVELS.indexOf(cur as (typeof LEVELS)[number])
  const next = LEVELS[(i + 1) % LEVELS.length] ?? ''
  setToolLevel(group, idx, next)
}

// 下拉剔除本组已选工具（按工具名）
function availableTools(group: string): SenseToolInfo[] {
  const arr = props.draft.sense_groups?.[group] ?? []
  const used = new Set(arr.map((e) => toolName(e)))
  return props.senseTools.filter((t) => !used.has(t.name))
}
// tag hover 描述：命中内置工具返回其 description，自定义工具返回空（title="" 不显）
function toolDesc(entry: string): string {
  return matchedTool(entry, props.senseTools)?.description ?? ''
}
// tag 显示名：命中内置工具显中文 label，自定义工具回退原名
function toolLabel(entry: string): string {
  return matchedTool(entry, props.senseTools)?.label ?? toolName(entry)
}

function levelLabel(level: string): string {
  return level || '继承'
}
// 监管等级行为说明：tooltip 用，让用户直观看到等级/继承到的具体权限含义。
// 文案与 GlobalTab 全局监管说明对齐（自动更流畅 / 确认关键操作前询问 / 手动最谨慎）。
const SUPERVISION_DESC: Record<(typeof SUPERVISIONS)[number], string> = {
  auto: 'AI 自行调用，无需确认（更流畅）',
  smart: '安全操作自动执行，敏感操作先问你',
  manual: '最谨慎，每次需手动放行',
}
// tag tooltip：合并工具描述 + 危险标志 + 监管等级/继承信息（pre-line 换行，popper-class sense-level-tip）。
// 替代原 el-tag 上的原生 title，所有 hover 信息汇入一个 tip。
function tagTip(entry: string): string {
  const lines: string[] = []
  const desc = toolDesc(entry)
  if (desc) lines.push(desc)
  if (isDangerousSense(entry)) lines.push('⚠ 危险器官')
  const lv = toolLevel(entry)
  if (lv) {
    lines.push(`监管等级（点等级标切换）：${SUPERVISION_LABEL[lv as (typeof SUPERVISIONS)[number]] ?? lv}`)
    lines.push(SUPERVISION_DESC[lv as (typeof SUPERVISIONS)[number]] ?? '')
  } else {
    const g = props.draft.global.supervision
    lines.push('继承（点等级标切换）')
    lines.push(SUPERVISION_DESC[g])
    lines.push(`继承全局监管：${SUPERVISION_LABEL[g]}（${g}）`)
  }
  return lines.join('\n')
}
// tag 着色按监管松紧：auto（放权）= danger，smart = warning，manual/info = info，继承 = info+plain
function levelTagType(level: string): 'info' | 'warning' | 'danger' {
  switch (level) {
    case 'auto':
      return 'danger'
    case 'smart':
      return 'warning'
    default:
      return 'info'
  }
}

/** 瀑布流后所有组卡平铺，无需 footer 圆点导航；返回空数组隐藏 IndexPaginator。 */
const indexItems = computed<IndexItem[]>(() => [])
</script>

<template>
  <TabShell tab-key="senses" :index-items="indexItems">
    <template #hints>
      <p class="sect-hint">
        给宠物装配的器官套餐。组名可点击改名；每组工具显为 tag，点 tag 内等级标切换监管，✕
        移除，hover 看说明。
      </p>
      <p class="warn-hint">
        ⚠️ execute_command / write_file 类器官危险（能跑命令/写文件）；配 :auto
        等于放它自己执行不问你。
      </p>
    </template>
    <template #popper="{ item }">
      <div class="index-card">
        <div class="index-card-title">{{ item.label as string }}</div>
        <div class="index-card-line">
          <b>工具数</b><span>{{ (item.count as number) || '无' }}</span>
        </div>
        <div class="index-card-line">
          <b>最高监管</b><span>{{ item.maxLevel as string }}</span>
        </div>
      </div>
    </template>
    <template #toolbar>
      <div class="senses-toolbar">
        <el-input
          v-model="newGroupName"
          placeholder="新器官组名"
          size="small"
          @keydown.enter="addGroup"
        />
        <button type="button" class="ghost-btn" @click="addGroup">+ 新增组</button>
      </div>
    </template>
    <div class="senses-grid">
      <article
        v-for="(_, gname, idx) in draft.sense_groups"
        :key="gname"
        class="card"
        :data-anchor="idx"
      >
        <span class="card-idx">{{ idx + 1 }}</span>
        <header class="card-head">
          <EditableTitle
            :model-value="gname as string"
            :validate="validateRename"
            @rename="(n: string) => renameGroup(gname as string, n)"
            @error="onError"
          >
            <template #actions>
              <span
                v-if="(draft.sense_groups?.[gname as string] ?? []).some(isDangerousSense)"
                class="warn-hint inline-warn"
                title="含危险器官"
                >⚠️ 危险</span
              >
              <button
                v-if="!addingGroups.has(gname as string)"
                type="button"
                class="icon-btn"
                title="加工具"
                aria-label="加工具"
                @click="openAdd(gname as string)"
              >
                <Plus class="ico" />
              </button>
              <el-select
                v-else
                :ref="(el: unknown) => setAddSelectRef(gname as string, el)"
                :model-value="''"
                filterable
                allow-create
                default-first-option
                size="small"
                placeholder="搜工具"
                class="add-tool-inline-select"
                popper-class="sense-tool-popper"
                @update:model-value="onAddTool(gname as string, $event)"
                @blur="closeAdd(gname as string)"
              >
                <el-option
                  v-for="t in availableTools(gname as string)"
                  :key="t.name"
                  :value="t.name"
                  :label="t.label"
                >
                  <div class="opt-item">
                    <SenseIcon :name="t.name" :tools="senseTools" />
                    <span class="opt-label">{{ t.label }}</span>
                    <span class="opt-desc" :title="t.description">{{ t.description }}</span>
                  </div>
                </el-option>
              </el-select>
              <ConfirmPopover
                :title="`确认删除器官组「${gname}」？`"
                @confirm="removeGroup(gname as string)"
              >
                <template #trigger>
                  <button type="button" class="icon-btn danger" aria-label="删除">
                    <Delete class="ico" />
                  </button>
                </template>
              </ConfirmPopover>
            </template>
          </EditableTitle>
        </header>
        <div class="tags">
          <el-tag
            v-for="(entry, idx) in draft.sense_groups?.[gname as string] ?? []"
            :key="idx"
            :type="levelTagType(toolLevel(entry))"
            :effect="toolLevel(entry) ? 'light' : 'plain'"
            closable
            size="default"
            class="sense-tag"
            @close="removeTool(gname as string, idx)"
          >
            <span class="tag-name">
              <SenseIcon :name="entry" :tools="senseTools" />
              <span v-if="isDangerousSense(entry)" class="danger-mark">⚠</span
              >{{ toolLabel(entry) }}
            </span>
            <el-tooltip
              :content="tagTip(entry)"
              placement="top"
              :show-after="120"
              popper-class="sense-level-tip"
            >
              <span
                class="tag-level-btn"
                :class="{ inherit: !toolLevel(entry) }"
                @click.stop="cycleLevel(gname as string, idx)"
                >{{ levelLabel(toolLevel(entry)) }}</span
              >
            </el-tooltip>
          </el-tag>
          <span v-if="!draft.sense_groups?.[gname as string]?.length" class="empty"
            >无工具，点标题 ＋</span
          >
        </div>
      </article>
    </div>
  </TabShell>
</template>

<style scoped lang="less">
@import '../../config/shared.less';

// 瀑布流：列宽 200px，列数随容器宽度自适应（空间够自动增多列）；卡片按工具数自然分列、各列高等于内容。
.senses-grid {
  column-width: 200px;
  column-gap: 8px;
}
.senses-grid > .card {
  break-inside: avoid;
  width: 100%;
  margin: 0 0 8px;
  box-sizing: border-box;
}
.senses-toolbar {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  :deep(.el-input) {
    width: 160px;
  }
}
.tags {
  display: flex;
  flex-direction: column; // 每行一个工具，垂直堆叠
  gap: 6px;
  align-items: stretch;
}
.sense-tag {
  width: 100%;
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
// 行内加工具 select：替换 + icon 原位展开；size=small 已对齐标题行高（24px），限宽 + 小字号适配行内。
.add-tool-inline-select {
  display: inline-flex;
  width: 80px;
  :deep(.el-input__inner) {
    font-size: 12px;
  }
}
.tag-name {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  .danger-mark {
    color: #be3939;
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

// 行内警告：缩到与 icon-btn 同档（24px 行高内），置于删除按钮左侧。
// 全局 .warn-hint 在 shared.less 中 padding 5px 8px、行高 1.4，对 24px 标题行偏厚。
.warn-hint.inline-warn {
  padding: 2px 6px;
  font-size: 10px;
  line-height: 1.4;
  border-radius: 4px;
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
// 等级标 tooltip：popper teleport 到 body，scoped 不穿透，故置全局样式；
// pre-line 让 content 内 \n 换行（三行：切换提示 / 行为说明 / 继承来源）。
.sense-level-tip {
  white-space: pre-line;
}
</style>
