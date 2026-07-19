<script setup lang="ts">
/**
 * GlobalTab：全局配置（config.global），所有宠物共享的脾气。
 * supervision 默认监管 / thinking / stream / 各超时与上限 / logger / file_compression / memory。
 *
 * 散落浮动玻璃卡片布局（plans/1-2-floating-willow.md §7）：
 *  - 7 张卡按 SCATTER_TABLE 散落 + 静态旋转，pinwheel 部分重叠，玻璃遮挡后卡。
 *  - 点卡或左下数字标置顶（pointerdown 冒泡）；可拖拽；惰性 setPointerCapture 保 el-input 选文。
 *  - 每次进入 global tab 触发坠落入场动画；SettingsDialog v-if 卸载 → 每次重开重置散落。
 *  - 窄屏 (<760px) 回退堆叠滚动；左下数字索引 Teleport 到弹窗 footer，点数字置顶对应卡。
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { ConfigDto, EditorInfo } from '@/services/agentApi'
import { agentApi } from '@/services/agentApi'
import { SUPERVISIONS, SUPERVISION_LABEL } from '../../config/constants'
import LabelTip from './LabelTip.vue'
import TabShell from '@/components/layout/TabShell.vue'
import NeonNumberControl from '../../controls/NeonNumberControl.vue'
import { useCardScatter, type GlobalCardAnchor } from '../useCardScatter'

const props = defineProps<{ draft: ConfigDto }>()

/** 编辑器选项列表（从后端获取） */
const editorOptions = ref<EditorInfo[]>([])
const editorLoading = ref(false)
const customEditor = ref('')
const newLogExtension = ref('')

function addLogExtension(): void {
  const value = newLogExtension.value.trim()
  if (!value || !props.draft.global.file_compression) return
  const current = props.draft.global.file_compression.log_file_extensions ?? []
  if (!current.includes(value))
    props.draft.global.file_compression.log_file_extensions = [...current, value]
  newLogExtension.value = ''
}
function removeLogExtension(value: string): void {
  const compression = props.draft.global.file_compression
  if (compression)
    compression.log_file_extensions = (compression.log_file_extensions ?? []).filter(
      (item) => item !== value,
    )
}
function toggleLoggerOutput(value: 'console' | 'file'): void {
  const logger = props.draft.global.logger
  if (!logger) return
  const current = logger.output ?? []
  logger.output = current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value]
}

/** 加载编辑器列表 */
async function loadEditors(): Promise<void> {
  editorLoading.value = true
  try {
    editorOptions.value = await agentApi.listEditors()
  } catch (err) {
    // 加载失败时静默处理，不影响用户手动输入
    console.error('加载编辑器列表失败:', err)
  } finally {
    editorLoading.value = false
  }
}

onMounted(loadEditors)

/** memory 段可能未在 config.yaml 中定义（config.get 返回 undefined），初始化双层空白对象供 v-model 绑定。 */
watch(
  () => props.draft.memory,
  (mem) => {
    if (!mem) {
      props.draft.memory = { global: {}, workspace: {} }
    } else {
      if (!mem.global) mem.global = {}
      if (!mem.workspace) mem.workspace = {}
    }
  },
  { immediate: true },
)

/** 模块墙需要每个拼图区都有内容；缺省段初始化为空配置，仍由各字段 placeholder 表达系统默认值。 */
watch(
  () => props.draft.global,
  (global) => {
    if (!global.logger) global.logger = {}
    if (!global.file_compression) global.file_compression = {}
  },
  { immediate: true },
)

/**
 * 审批等待时长（global.approval_timeout）：后端存 ms，前端 UI 按秒录入。
 * - 读取：ms ÷ 1000 → 秒（undefined 时保持 undefined，placeholder 显示「0 = 不超时」）
 * - 写入：秒 × 1000 → ms；清空时回退到 undefined（不强制写 0，保留 yaml 原状）
 */
const approvalTimeoutSeconds = computed<number | undefined>({
  get: () => {
    const ms = props.draft.global.approval_timeout
    return ms === undefined ? undefined : Math.round(ms / 1000)
  },
  set: (sec) => {
    if (sec === undefined || sec === null || Number.isNaN(sec)) {
      delete props.draft.global.approval_timeout
    } else {
      props.draft.global.approval_timeout = sec * 1000
    }
  },
})

/** 画布容器（.global-canvas）。 */
const canvasRef = ref<HTMLElement | null>(null)

/** 当前实际渲染的卡 anchor 顺序（logger / compression 按配置 v-if 动态出现）。决定 cardNumber 编号 + entry 顺序。 */
const visibleAnchors = computed<GlobalCardAnchor[]>(() => {
  const out: GlobalCardAnchor[] = ['default', 'editor', 'limits']
  if (props.draft.global.logger) out.push('logger')
  if (props.draft.global.file_compression) out.push('compression')
  out.push('memory-global', 'memory-workspace')
  return out
})

const {
  ready,
  activeAnchor,
  isActive,
  cardStyle,
  cardClass,
  cardNumber,
  raise,
  onPointerDown,
  onPointerMove,
  endPointer,
  onEnterEnd,
} = useCardScatter(canvasRef, visibleAnchors)
</script>

<template>
  <TabShell tab-key="global">
    <template #hints>
      <p class="sect-hint">
        所有会话共用的运行规则。留空的数值将使用系统默认值，输入后才会覆盖默认设置。
      </p>
      <p class="sect-hint">
        点卡或左下数字置顶；长按卡片再移动可拖拽重排；进入本页时卡片坠落就位。
      </p>
    </template>

    <div ref="canvasRef" class="global-canvas" :class="{ 'is-ready': ready }">
      <section
        class="neon-block block-supervision"
        data-anchor="default"
        :style="cardStyle('default')"
        :class="cardClass('default')"
        @pointerdown="onPointerDown('default', $event)"
        @pointermove="onPointerMove"
        @pointerup="endPointer"
        @pointercancel="endPointer"
        @animationend="onEnterEnd('default')"
      >
        <div class="block-heading">
          <div>
            <div class="block-kicker">
              <span class="kicker-no">{{ cardNumber('default') }}</span
              >GUARD MODE
            </div>
            <h3>默认监管</h3>
          </div>
          <button
            type="button"
            class="stream-chip"
            :class="{ active: draft.global.stream }"
            :aria-pressed="draft.global.stream"
            :title="
              draft.global.stream
                ? '流式输出已开启，点击改为完整返回'
                : '流式输出已关闭，点击改为边生成边返回'
            "
            @click="draft.global.stream = !draft.global.stream"
          >
            <span>≋</span><b>流式</b><small>{{ draft.global.stream ? '即时' : '整段' }}</small>
          </button>
        </div>
        <div class="supervision-deck">
          <button
            v-for="s in SUPERVISIONS"
            :key="s"
            type="button"
            :class="{ active: draft.global.supervision === s }"
            @click="draft.global.supervision = s"
          >
            <span>{{ s === 'auto' ? '⚡' : s === 'confirm' ? '◉' : '✋' }}</span
            ><b>{{ SUPERVISION_LABEL[s] }}</b>
          </button>
        </div>
        <p>自动更流畅；确认会在关键操作前询问；手动最谨慎。</p>
      </section>

      <section
        class="neon-block block-editor"
        data-anchor="editor"
        :style="cardStyle('editor')"
        :class="cardClass('editor')"
        @pointerdown="onPointerDown('editor', $event)"
        @pointermove="onPointerMove"
        @pointerup="endPointer"
        @pointercancel="endPointer"
        @animationend="onEnterEnd('editor')"
      >
        <div class="block-kicker">
          <span class="kicker-no">{{ cardNumber('editor') }}</span
          >WORKBENCH
        </div>
        <div class="field">
          <LabelTip label="文本编辑器" tip="点击可用编辑器直接切换；留空使用系统默认" />
          <div class="editor-deck">
            <button
              type="button"
              :class="{ active: !draft.global.textEditor }"
              @click="draft.global.textEditor = undefined"
            >
              系统默认
            </button>
            <button
              v-for="editor in editorOptions.filter((item) => item.available).slice(0, 3)"
              :key="editor.command"
              type="button"
              :class="{ active: draft.global.textEditor === editor.command }"
              @click="draft.global.textEditor = editor.command"
            >
              {{ editor.name }}
            </button>
            <el-popover trigger="click" placement="bottom" :width="230">
              <template #reference
                ><button
                  type="button"
                  :class="{
                    active:
                      !!draft.global.textEditor &&
                      !editorOptions.some((item) => item.command === draft.global.textEditor),
                  }"
                >
                  自定义
                </button></template
              >
              <div class="custom-editor">
                <el-input
                  v-model="customEditor"
                  placeholder="编辑器命令"
                  @keydown.enter="draft.global.textEditor = customEditor.trim() || undefined"
                /><button
                  type="button"
                  @click="draft.global.textEditor = customEditor.trim() || undefined"
                >
                  使用
                </button>
              </div>
            </el-popover>
          </div>
        </div>
        <div class="editor-status">
          <span
            v-for="editor in editorOptions.slice(0, 4)"
            :key="editor.command"
            :class="{ online: editor.available }"
            ><i />{{ editor.name }}</span
          ><small v-if="!editorOptions.length">未检测到编辑器，保存后使用系统默认</small>
        </div>
      </section>

      <section
        class="neon-block block-limits"
        data-anchor="limits"
        :style="cardStyle('limits')"
        :class="cardClass('limits')"
        @pointerdown="onPointerDown('limits', $event)"
        @pointermove="onPointerMove"
        @pointerup="endPointer"
        @pointercancel="endPointer"
        @animationend="onEnterEnd('limits')"
      >
        <div class="block-kicker">
          <span class="kicker-no">{{ cardNumber('limits') }}</span
          >LIMIT MATRIX
        </div>
        <div class="limit-grid">
          <NeonNumberControl
            v-model="draft.global.sense_execute_timeout"
            label="工具执行超时"
            tip="超过此时间将进入后台执行"
            placeholder="30000"
            unit="ms"
            :step="5000"
            :min="0"
          />
          <NeonNumberControl
            v-model="approvalTimeoutSeconds"
            label="审批等待"
            tip="0 = 不限时；超时按拒绝处理"
            placeholder="不限时"
            unit="秒"
            :step="10"
            :min="0"
          />
          <NeonNumberControl
            v-model="draft.global.maxLoopCount"
            label="工具调用上限"
            tip="单轮可连续调用工具的次数"
            placeholder="30"
            :step="5"
            :min="1"
          />
          <NeonNumberControl
            v-model="draft.global.bash_log_retention_hours"
            label="命令日志保留"
            tip="只清理 execute_command 日志"
            placeholder="24"
            unit="小时"
            :step="6"
            :min="0"
          />
        </div>
      </section>

      <section
        v-if="draft.global.logger"
        class="neon-block block-logger"
        data-anchor="logger"
        :style="cardStyle('logger')"
        :class="cardClass('logger')"
        @pointerdown="onPointerDown('logger', $event)"
        @pointermove="onPointerMove"
        @pointerup="endPointer"
        @pointercancel="endPointer"
        @animationend="onEnterEnd('logger')"
      >
        <div class="block-kicker">
          <span class="kicker-no">{{ cardNumber('logger') }}</span
          >TRACE CONSOLE
        </div>
        <h3 class="sub-title">应用日志</h3>
        <div class="logger-console">
          <div>
            <span>等级</span>
            <div class="segment-deck">
              <button
                v-for="level in ['debug', 'info', 'warn', 'error', 'silent'] as const"
                :key="level"
                type="button"
                :class="{ active: draft.global.logger!.level === level }"
                @click="draft.global.logger!.level = level"
              >
                {{ level }}
              </button>
            </div>
          </div>
          <div>
            <span>格式</span>
            <div class="segment-deck">
              <button
                v-for="format in ['plain', 'json'] as const"
                :key="format"
                type="button"
                :class="{ active: draft.global.logger!.format === format }"
                @click="draft.global.logger!.format = format"
              >
                {{ format }}
              </button>
            </div>
          </div>
          <div>
            <span>信号</span>
            <div class="signal-deck">
              <button
                type="button"
                :class="{ active: draft.global.logger!.output?.includes('console') }"
                @click="toggleLoggerOutput('console')"
              >
                终端</button
              ><button
                type="button"
                :class="{ active: draft.global.logger!.output?.includes('file') }"
                @click="toggleLoggerOutput('file')"
              >
                文件</button
              ><button
                type="button"
                :class="{ active: draft.global.logger!.timestamp }"
                @click="draft.global.logger!.timestamp = !draft.global.logger!.timestamp"
              >
                时间</button
              ><button
                type="button"
                :class="{ active: draft.global.logger!.location }"
                @click="draft.global.logger!.location = !draft.global.logger!.location"
              >
                位置
              </button>
            </div>
          </div>
        </div>
      </section>

      <section
        v-if="draft.global.file_compression"
        class="neon-block block-compression"
        data-anchor="compression"
        :style="cardStyle('compression')"
        :class="cardClass('compression')"
        @pointerdown="onPointerDown('compression', $event)"
        @pointermove="onPointerMove"
        @pointerup="endPointer"
        @pointercancel="endPointer"
        @animationend="onEnterEnd('compression')"
      >
        <div class="block-kicker">
          <span class="kicker-no">{{ cardNumber('compression') }}</span
          >FILE SIGNAL
        </div>
        <h3 class="sub-title">读取大文件内容压缩</h3>
        <p class="block-summary"><code>read_file</code> 返回层压缩；不修改磁盘文件。</p>
        <div class="card-grid">
          <NeonNumberControl
            v-model="draft.global.file_compression.truncate_threshold"
            label="大文件阈值"
            tip="超过此字节数只返回预览"
            placeholder="102400"
            unit="B"
            :step="10240"
            :min="1"
          />
          <NeonNumberControl
            v-model="draft.global.file_compression.truncate_preview_lines"
            label="截断预览"
            tip="超大普通文件保留的开头行数"
            placeholder="100"
            unit="行"
            :step="20"
            :min="1"
          />
          <NeonNumberControl
            v-model="draft.global.file_compression.drain_preview_count"
            label="日志样例"
            tip="每种重复格式保留的样例数"
            placeholder="3"
            unit="条"
            :step="1"
            :min="1"
          />
          <div class="extension-magazine">
            <span class="lbl">日志扩展名</span>
            <div>
              <button
                v-for="ext in draft.global.file_compression.log_file_extensions ?? []"
                :key="ext"
                type="button"
                title="点击移除"
                @click="removeLogExtension(ext)"
              >
                {{ ext }} ×</button
              ><el-popover trigger="click" placement="bottom" :width="190"
                ><template #reference
                  ><button type="button" class="add-extension">＋ 添加</button></template
                >
                <div class="custom-editor">
                  <el-input
                    v-model="newLogExtension"
                    placeholder=".log"
                    @keydown.enter="addLogExtension"
                  /><button type="button" @click="addLogExtension">加入</button>
                </div></el-popover
              >
            </div>
          </div>
        </div>
      </section>

      <section
        class="neon-block block-memory-global"
        data-anchor="memory-global"
        :style="cardStyle('memory-global')"
        :class="cardClass('memory-global')"
        @pointerdown="onPointerDown('memory-global', $event)"
        @pointermove="onPointerMove"
        @pointerup="endPointer"
        @pointercancel="endPointer"
        @animationend="onEnterEnd('memory-global')"
      >
        <div class="block-kicker">
          <span class="kicker-no">{{ cardNumber('memory-global') }}</span
          >SHARED MEMORY
        </div>
        <h3 class="sub-title">全局记忆（所有 chat 共享）</h3>
        <p class="block-summary"><code>global</code> · 跨会话共享 · 超限自动归档</p>
        <div class="card-grid">
          <NeonNumberControl
            v-model="draft.memory!.global!.max_count"
            label="活跃条数"
            tip="跨 chat 共享的活跃记忆上限"
            placeholder="30"
            unit="条"
            :step="5"
            :min="1"
          />
          <NeonNumberControl
            v-model="draft.memory!.global!.max_chars"
            label="单条字数"
            tip="单条正文软性字数建议"
            placeholder="500"
            unit="字"
            :step="100"
            :min="1"
          />
        </div>
      </section>

      <section
        class="neon-block block-memory-workspace"
        data-anchor="memory-workspace"
        :style="cardStyle('memory-workspace')"
        :class="cardClass('memory-workspace')"
        @pointerdown="onPointerDown('memory-workspace', $event)"
        @pointermove="onPointerMove"
        @pointerup="endPointer"
        @pointercancel="endPointer"
        @animationend="onEnterEnd('memory-workspace')"
      >
        <div class="block-kicker">
          <span class="kicker-no">{{ cardNumber('memory-workspace') }}</span
          >LOCAL MEMORY
        </div>
        <h3 class="sub-title">Workspace 记忆（per 项目 / 单 chat）</h3>
        <p class="block-summary"><code>workspace</code> · 项目隔离 · 超限自动归档</p>
        <div class="card-grid">
          <NeonNumberControl
            v-model="draft.memory!.workspace!.max_count"
            label="活跃条数"
            tip="当前项目的活跃记忆上限"
            placeholder="15"
            unit="条"
            :step="5"
            :min="1"
          />
          <NeonNumberControl
            v-model="draft.memory!.workspace!.max_chars"
            label="单条字数"
            tip="单条正文软性字数建议"
            placeholder="500"
            unit="字"
            :step="100"
            :min="1"
          />
        </div>
      </section>
    </div>

    <!-- 左下数字索引：Teleport 到弹窗 footer 左侧（关闭/保存之左）；点数字置顶对应卡 -->
    <Teleport defer to="#settings-footer-nav">
      <div v-if="isActive" class="global-card-index">
        <button
          v-for="a in visibleAnchors"
          :key="a"
          type="button"
          class="global-card-no"
          :class="{ active: activeAnchor === a }"
          :title="`置顶卡片 ${cardNumber(a)}`"
          @click.stop="raise(a)"
        >
          {{ cardNumber(a) }}
        </button>
      </div>
    </Teleport>
  </TabShell>
</template>

<style scoped lang="less">
@import '../../config/shared.less';

// ── 散落画布：填满 .shell-scroll，position:relative 容纳 absolute 卡 ──
.global-canvas {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  width: 100%;
  height: 100%;
  padding: 6px;
  box-sizing: border-box;
}
// 布局未就绪时（隐藏挂载 / 首帧 0,0）隐藏卡，防初始 7 张叠在左上角闪烁；ready 后由 entry / 静态 opacity 接管。
.global-canvas:not(.is-ready) .neon-block {
  opacity: 0;
}

// ── 卡片本体：absolute + left/top 由 --cx/--cy 驱动（drag 改这两个值） ──
// 静止无 transform：旋转/缩放会让 backdrop-filter + 文字子像素采样发糊；只有置顶/按下才放大。
.neon-block {
  .neon-glass();
  position: absolute;
  left: var(--cx, 0);
  top: var(--cy, 0);
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease,
    filter 0.18s ease;
  touch-action: none;
  // 卡片整体禁选：长按未到点（0–320ms）/ 短按拖动窗口内也不会选中静态文本，拖拽不糊字
  user-select: none;
  // 玻璃态：在 .neon-glass() 默认 blur(14px) 上加深 + 加 saturate
  backdrop-filter: blur(16px) saturate(1.06);
  // 后卡轻微去饱和，让 .is-top 的 filter:none 凸显层次
  filter: saturate(0.96);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px;
  border: 1px solid rgba(129, 140, 248, 0.17);
  border-radius: 12px;
  cursor: grab;
}
.neon-block::before {
  content: '';
  position: absolute;
  width: 110px;
  height: 110px;
  border-radius: 50%;
  right: -45px;
  top: -54px;
  background: rgba(99, 102, 241, 0.16);
  filter: blur(22px);
  pointer-events: none;
}
.neon-block::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 34%;
  top: 0;
  height: 1px;
  background: linear-gradient(90deg, var(--block-neon, #818cf8), transparent);
  box-shadow: 0 0 7px var(--block-neon, #818cf8);
  opacity: 0.58;
  pointer-events: none;
}
.neon-block:nth-child(3n)::before {
  background: rgba(14, 165, 233, 0.16);
}
.neon-block:nth-child(3n + 2)::before {
  background: rgba(217, 70, 233, 0.13);
}
.neon-block h3 {
  position: relative;
  margin: 0;
  font-size: 13px;
  color: #3730a3;
}
.block-kicker {
  position: relative;
  font:
    800 9px/1 ui-monospace,
    SFMono-Regular,
    monospace;
  letter-spacing: 0.14em;
  color: rgba(79, 70, 229, 0.55);
}

// ── 装饰载流：每卡保留原 --block-neon 颜色 + 圆角变体（去 grid-area） ──
.block-supervision {
  --block-neon: #d946ef;
  border-radius: 16px 9px 13px 8px;
}
.block-editor {
  --block-neon: #60a5fa;
  border-radius: 9px 16px 8px 13px;
}
.block-limits {
  --block-neon: #38bdf8;
  border-radius: 14px 8px 15px 9px;
}
.block-logger {
  --block-neon: #2dd4bf;
  border-radius: 8px 14px 10px 16px;
}
.block-compression {
  --block-neon: #8b5cf6;
  border-radius: 15px 9px 17px 8px;
}
.block-memory-global {
  --block-neon: #34d399;
  border-radius: 8px 15px 9px 13px;
}
.block-memory-workspace {
  --block-neon: #06b6d4;
  border-radius: 13px 8px 15px 10px;
}

// ── 状态变体 ──
.neon-block.is-top {
  // 顶卡：放大（悬浮感）+ 更深模糊 + saturate 凸显 + 边光（玻璃遮挡后卡的视觉机制）
  backdrop-filter: blur(20px) saturate(1.12);
  filter: none;
  transform: scale(1.03);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.82),
    0 18px 38px rgba(67, 56, 202, 0.18),
    0 0 0 1px rgba(255, 255, 255, 0.08);
}
.neon-block.is-pressed {
  // 「拿起」：放大 1.045 + 加深阴影（长按 / 拖拽中持续保持）
  transform: scale(1.045);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.82),
    0 22px 44px rgba(67, 56, 202, 0.22);
}
.neon-block.is-dragging {
  cursor: grabbing;
  // 拖拽中禁 transition 跟手感跟手；放手回弹时再让 transition 接管
  transition: none;
}

// ── 坠落入场动画：每次进入 global tab 重放，stagger 由 --i 控制；落点无 transform（防糊） ──
@keyframes card-fall {
  from {
    opacity: 0;
    transform: translateY(-40px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.neon-block.is-entering {
  animation: card-fall 0.5s cubic-bezier(0.2, 0.9, 0.25, 1.15) both;
  animation-delay: calc(var(--i) * 55ms);
}

// ── 卡顶英文前的序号：融合进 .block-kicker（同款等宽小字，淡化以区分）──
.block-kicker .kicker-no {
  padding-right: 5px;
  margin-right: 5px;
  opacity: 0.5;
}

// ── 内部控件样式（保留原样） ──
.block-heading {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 27px;
}
.block-heading > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.stream-chip {
  flex: 0 0 auto;
  height: 27px;
  display: grid;
  grid-template-columns: 16px auto auto;
  align-items: center;
  gap: 4px;
  padding: 2px 7px 2px 5px;
  border: 1px solid rgba(14, 165, 233, 0.22);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.62);
  color: fade(@ink, 50%);
  cursor: pointer;
  transition:
    border-color 0.16s ease,
    background 0.16s ease,
    box-shadow 0.16s ease,
    transform 0.16s ease;
  > span {
    font-size: 15px;
    line-height: 1;
    color: #38bdf8;
  }
  b {
    font-size: 9px;
  }
  small {
    padding-left: 4px;
    border-left: 1px solid rgba(14, 165, 233, 0.17);
    font-size: 8px;
    color: fade(@ink, 42%);
  }
  &.active {
    border-color: rgba(34, 211, 238, 0.58);
    background: linear-gradient(110deg, rgba(224, 242, 254, 0.82), rgba(243, 232, 255, 0.74));
    color: #4338ca;
    box-shadow:
      0 0 9px rgba(14, 165, 233, 0.2),
      inset 0 0 7px rgba(217, 70, 233, 0.08);
    > span {
      color: #06b6d4;
      text-shadow: 0 0 7px rgba(34, 211, 238, 0.68);
    }
  }
  &:hover {
    transform: translateY(-1px);
  }
}
.supervision-deck {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5px;
}
.supervision-deck button {
  min-height: 50px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 1px solid rgba(99, 102, 241, 0.13);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.72);
  color: rgba(36, 38, 45, 0.58);
  cursor: pointer;
  transition: 0.16s ease;
  span {
    font-size: 17px;
  }
  b {
    font-size: 10px;
  }
  &.active {
    border-color: rgba(96, 165, 250, 0.75);
    color: #4338ca;
    background: linear-gradient(145deg, rgba(224, 242, 254, 0.8), rgba(243, 232, 255, 0.72));
    box-shadow:
      0 0 0 1px rgba(94, 234, 255, 0.25),
      0 0 13px rgba(99, 102, 241, 0.22),
      inset 0 -2px 8px rgba(217, 70, 233, 0.08);
    transform: translateY(-1px);
  }
}
.block-supervision p {
  position: relative;
  margin: 0;
  font-size: 9px;
  color: fade(@ink, 48%);
}
.limit-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}
.card-grid {
  position: relative;
  gap: 6px;
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.neon-block .field {
  gap: 2px;
}
.neon-block :deep(.lbl) {
  font-size: 10px;
}
.neon-block :deep(.el-input__wrapper),
.neon-block :deep(.el-select__wrapper) {
  min-height: 28px;
  background: rgba(255, 255, 255, 0.72);
  box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.12) inset;
}
.neon-block :deep(.el-input__inner),
.neon-block :deep(.el-select__selected-item),
.neon-block :deep(.el-select__placeholder) {
  font-size: 11px;
  line-height: 18px;
}
.neon-block :deep(.el-input__inner) {
  height: 26px;
}
.neon-block :deep(.el-input__wrapper.is-focus),
.neon-block :deep(.el-select__wrapper.is-focused) {
  box-shadow:
    0 0 0 1px rgba(56, 189, 248, 0.62) inset,
    0 0 10px rgba(99, 102, 241, 0.15);
}
// 卡片整体禁选后，表单控件内部仍允许选中/编辑（保 NeonNumberControl / el-input 可用）
.neon-block :deep(.el-input__inner),
.neon-block :deep(.el-textarea__inner),
.neon-block :deep(.el-select__input) {
  user-select: text;
}
.block-summary {
  position: relative;
  margin: 0;
  font-size: 9px;
  color: fade(@ink, 48%);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  code {
    font-size: 9px;
  }
}
.editor-status {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
.editor-status span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 5px;
  border-radius: 999px;
  background: rgba(36, 38, 45, 0.055);
  font-size: 8px;
  color: fade(@ink, 45%);
}
.editor-status i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #94a3b8;
}
.editor-status span.online i {
  background: #22d3ee;
  box-shadow: 0 0 5px #22d3ee;
}
.editor-status small {
  font-size: 8px;
  color: fade(@ink, 40%);
}
.editor-deck,
.segment-deck,
.signal-deck {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
.editor-deck button,
.segment-deck button,
.signal-deck button {
  min-height: 24px;
  padding: 3px 7px;
  border: 1px solid rgba(99, 102, 241, 0.13);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.66);
  color: fade(@ink, 55%);
  font-size: 9px;
  cursor: pointer;
}
.editor-deck button.active,
.segment-deck button.active,
.signal-deck button.active {
  border-color: rgba(56, 189, 248, 0.48);
  background: linear-gradient(120deg, rgba(224, 242, 254, 0.8), rgba(243, 232, 255, 0.76));
  color: #4338ca;
  box-shadow: 0 0 8px rgba(99, 102, 241, 0.14);
}
.custom-editor {
  display: flex;
  gap: 5px;
}
.custom-editor button {
  border: 0;
  border-radius: 6px;
  background: #6366f1;
  color: #fff;
  font-size: 10px;
  padding: 0 9px;
  cursor: pointer;
}
.logger-console {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.logger-console > div {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  align-items: center;
  gap: 5px;
}
.logger-console > div > span {
  font-size: 9px;
  font-weight: 800;
  color: fade(@ink, 48%);
}
.segment-deck button {
  flex: 1;
  min-width: 34px;
  padding: 3px 4px;
}
.signal-deck button {
  min-width: 42px;
}
.extension-magazine {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.extension-magazine > div {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
.extension-magazine button {
  height: 24px;
  padding: 2px 6px;
  border: 1px solid rgba(139, 92, 246, 0.17);
  border-radius: 7px;
  background: rgba(245, 243, 255, 0.78);
  color: #6d28d9;
  font-size: 9px;
  cursor: pointer;
}
.extension-magazine .add-extension {
  border-style: dashed;
  background: transparent;
  color: #6366f1;
}

// ── 窄屏兜底：散落失效，回退堆叠滚动 ──
@media (max-width: 760px) {
  .global-canvas {
    position: static;
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: auto;
    padding: 0;
  }
  .global-canvas .neon-block {
    position: static;
    left: auto !important;
    top: auto !important;
    transform: none !important;
  }
  .limit-grid {
    grid-template-columns: 1fr;
  }
}

// reduced-motion 全局降级见 neon.less；这里不重复声明。
</style>

<!--
  非 scoped：:has() 跨组件选择 .shell-scroll（由 TabShell 渲染）。
  精确命中「内含 .global-canvas 的」.shell-scroll（= GlobalTab 自己的 scroll 容器；global-canvas 是其直接子）。
  不用 .tab-body:has(.global-canvas) .shell-scroll——那会命中同 .tab-body 内其他 tab 的 shell-scroll，
  因为 GlobalTab v-show 常驻挂载，global-canvas 总在 DOM。仅在 ≥761px 把它改 overflow:hidden，让散落画布铺满。
-->
<style lang="less">
@media (min-width: 761px) {
  .shell-scroll:has(> .global-canvas) {
    overflow: hidden;
    overflow-y: hidden;
    padding-right: 0;
    gap: 0;
  }
}
// 左下数字索引（Teleport 到 #settings-footer-nav，故须非 scoped）：点数字置顶对应卡。
.global-card-index {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.global-card-no {
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  box-sizing: border-box;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.7);
  color: #595e66;
  font:
    800 11px/20px ui-monospace,
    SFMono-Regular,
    monospace;
  text-align: center;
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease,
    transform 0.15s ease,
    box-shadow 0.15s ease;
}
.global-card-no:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--tab-color, #06b6d4) 50%, transparent);
  color: #2a2a2a;
}
.global-card-no.active {
  background: color-mix(in srgb, var(--tab-color, #06b6d4) 22%, white);
  border-color: color-mix(in srgb, var(--tab-color, #06b6d4) 60%, transparent);
  color: #1f2937;
  box-shadow: 0 2px 8px color-mix(in srgb, var(--tab-color, #06b6d4) 30%, transparent);
}
</style>
