<script setup lang="ts">
/**
 * SensesTab：器官（sense_groups）配置。
 * 瀑布流：组卡按工具数自然分列（CSS columns），列高随工具数；无需 footer 圆点导航。
 * 组名可点击改名（迁移 default/roles 引用）。
 * 标题栏只留组名 + 删除按钮；「危险」标识与「添加工具」搜索框独占标题下一整行，
 * 空间宽裕所以搜索框常驻展示（不再 + 图标展开）。
 * tag 化：每组已配工具显为可关闭 el-tag，监管等级挂 tag 内（点循环：继承→auto→smart→manual）；
 * 一个 el-select（filterable + allow-create）作「加工具」入口，选项显中文名 + 说明。
 *   - 防重复：同组同名工具只一份；下拉剔除已选工具；allow-create 输入已选名也被拦。
 *   - 一列一个：flex-direction column，tag 名 ellipsis。
 * hover tag 显结构化完整说明（ToolInfoTip.vue：toolDoc 优先 sense.tools.docs 的
 *   【作用/能力/边界/注意】分节文档，缺失回退短描述 + 危险标志 + 监管等级/继承信息，重点强调）。
 * 删组走 ConfirmPopover 二次确认；工具移除=tag 关闭（频繁操作，不二次确认）。
 * 字段名 sense_groups / senseGroup 保留（后端协议），仅 UI 文案改"器官"。
 */
import { ref, computed } from 'vue'
import { Delete } from '@element-plus/icons-vue'
import type { ConfigDto, SenseToolDocInfo, SenseToolInfo } from '@/services/agentApi'
import { SUPERVISIONS } from '../../config/constants'
import { toolName, toolLevel, isDangerousSense, matchedTool } from '../../config/shared'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import EditableTitle from '@/components/input/EditableTitle.vue'
import SenseIcon from './SenseIcon.vue'
import ToolInfoTip from './ToolInfoTip.vue'
import TabShell, { type IndexItem } from '@/components/layout/TabShell.vue'

const props = withDefaults(
  defineProps<{ draft: ConfigDto; senseTools: SenseToolInfo[]; senseDocs?: SenseToolDocInfo[] }>(),
  { senseDocs: () => [] },
)
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
// tag 短描述：命中内置工具返回其 description，自定义工具返回空
function toolDesc(entry: string): string {
  return matchedTool(entry, props.senseTools)?.description ?? ''
}

// sense.tools.docs 全量文档 → name→doc 映射（一次拉取缓存，hover 按需取用）。
const docsByTool = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  for (const d of props.senseDocs) map[d.name] = d.doc
  return map
})
/**
 * 工具完整说明：优先 sense.tools.docs 的专用文档（【作用】【能力】【边界】【注意】），
 * 缺失（未拉取/自定义工具）回退内置短描述；自定义工具无任何说明返回 ''。
 */
function toolDoc(entry: string): string {
  const name = toolName(entry)
  return docsByTool.value[name] ?? toolDesc(entry)
}
// tag 显示名：命中内置工具显中文 label，自定义工具回退原名
function toolLabel(entry: string): string {
  return matchedTool(entry, props.senseTools)?.label ?? toolName(entry)
}

function levelLabel(level: string): string {
  return level || '继承'
}
// tag hover 结构化 tip 的 props：完整文档（sense.tools.docs，缺失回退短描述）+ 危险 + 监管/继承。
// 渲染交给 ToolInfoTip.vue（分节解析 + 重点强调样式，整 tag 一个 tip）。
function tipProps(entry: string) {
  return {
    label: toolLabel(entry),
    doc: toolDoc(entry),
    dangerous: isDangerousSense(entry),
    level: toolLevel(entry),
    globalSupervision: props.draft.global.supervision,
  }
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
        移除，hover 看完整说明。
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
            :name-title="gname as string"
            :validate="validateRename"
            @rename="(n: string) => renameGroup(gname as string, n)"
            @error="onError"
          >
            <template #actions>
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
        <!-- 标题下一整行：危险标识 + 常驻「添加工具」搜索框（空间宽裕，不再用 + 图标展开） -->
        <div class="card-actions">
          <span
            v-if="(draft.sense_groups?.[gname as string] ?? []).some(isDangerousSense)"
            class="warn-hint inline-warn"
            title="含危险器官"
            >⚠️ 危险</span
          >
          <el-select
            :model-value="''"
            filterable
            allow-create
            default-first-option
            size="small"
            placeholder="搜工具 / 添加工具…"
            class="add-tool-select"
            popper-class="sense-tool-popper"
            @update:model-value="onAddTool(gname as string, $event)"
          >
            <el-option
              v-for="t in availableTools(gname as string)"
              :key="t.name"
              :value="t.name"
              :label="t.label"
            >
              <div class="opt-item">
                <div class="opt-title-row">
                  <SenseIcon :name="t.name" :tools="senseTools" />
                  <span class="opt-label">{{ t.label }}</span>
                </div>
                <span class="opt-desc" :title="t.description">{{ t.description }}</span>
              </div>
            </el-option>
          </el-select>
        </div>
        <div class="tags">
          <el-tooltip
            v-for="(entry, idx) in draft.sense_groups?.[gname as string] ?? []"
            :key="idx"
            placement="top"
            :show-after="120"
            popper-class="tool-tip-popper"
          >
            <template #content><ToolInfoTip v-bind="tipProps(entry)" /></template>
            <el-tag
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
              <span
                class="tag-level-btn"
                :class="{ inherit: !toolLevel(entry) }"
                @click.stop="cycleLevel(gname as string, idx)"
                >{{ levelLabel(toolLevel(entry)) }}</span
              >
            </el-tag>
          </el-tooltip>
          <span v-if="!draft.sense_groups?.[gname as string]?.length" class="empty"
            >无工具，用上方搜索框添加</span
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
// 组名超长：省略缩略显示，title 由 EditableTitle 的 nameTitle 传入完整名（hover tip）。
// min-width:0 让 .card-title 内的 .flex-1 吸收剩余空间，避免把右侧动作按钮挤出卡片。
.card-head :deep(.card-title) {
  min-width: 0;
}
.card-head :deep(.card-name) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
// 标题下一整行：危险标识 + 常驻添加工具搜索框。flex 布局，搜索框吸收剩余宽度。
.card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0 8px;
  min-width: 0;
}
.add-tool-select {
  flex: 1 1 auto;
  min-width: 0;
  // EP 2.8 触发框为 .el-select__wrapper（无 .el-input__inner），整体字重收敛 400；
  // filterable 搜索输入即触发框内 .el-select__input，placeholder 一并覆盖 400。
  :deep(.el-select__wrapper) {
    font-weight: 400;
  }
  :deep(.el-select__placeholder),
  :deep(.el-select__placeholder.is-transparent) {
    font-weight: 400;
  }
  :deep(.el-select__input) {
    font-weight: 400;
  }
  :deep(.el-select__input)::placeholder {
    font-weight: 400;
  }
}
.tag-name {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  .danger-mark {
    color: var(--danger);
    margin-right: 2px;
  }
}
.tag-level-btn {
  flex-shrink: 0;
  padding-left: 6px;
  border-left: 1px solid color-mix(in srgb, var(--ink) 15%, transparent);
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

// 行内警告：高度对齐右侧 small el-select（--el-component-size-small: 24px），一行不换行。
// 固定高度 + inline-flex 居中，行高不再撑高；全局 .warn-hint 在 shared.less 中 padding 5px 8px、行高 1.4，
// 对 24px 行偏厚。nowrap + flex-shrink:0：防止「⚠️ 危险」被 flex 压缩在空格处断行（"危险"换到第二行）。
.warn-hint.inline-warn {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 6px;
  box-sizing: border-box;
  font-size: 10px;
  line-height: 1;
  border-radius: 4px;
  white-space: nowrap;
  flex-shrink: 0;
}
</style>

<!--
  el-select 下拉面板默认 teleport 到 body，scoped 样式无法穿透。
  故用 popper-class="sense-tool-popper" + 非 scoped 全局样式定制选项（中文名 + 说明两行）。
-->
<style lang="less">
.sense-tool-popper {
  // 弹框选项全部文本字重 400（Element 选中态默认 700，一并覆盖为 400）
  .el-select-dropdown__item,
  .el-select-dropdown__item.is-hovering,
  .el-select-dropdown__item.is-selected {
    font-weight: 400;
  }
  // EP 默认 item 固定 height:34px + overflow:hidden + nowrap，会裁掉两行布局的第二行说明，
  // 覆盖为 auto 高度 + 正常换行；显式 padding 压过 .el-select-dropdown__list>.el-select-dropdown__item 的
  // padding-left:32px（同特异性靠后置源序生效）；单选无右侧 ✓，32px 右内边距作保险。
  .el-select-dropdown__item {
    height: auto;
    min-height: 34px;
    line-height: 1.3;
    white-space: normal;
    overflow: visible;
    padding: 6px 32px 6px 20px;
    display: flex;
    align-items: center;
  }
  // 选项两行布局：第一行图标+标题，第二行描述（可换行完整展示）
  .opt-item {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    width: 100%;
  }
  .opt-title-row {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .opt-label {
    font-size: 13px;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .opt-desc {
    font-size: 11px;
    font-weight: 400;
    color: color-mix(in srgb, var(--ink) 64%, transparent);
    line-height: 1.4;
    word-break: break-word;
  }
}
</style>
