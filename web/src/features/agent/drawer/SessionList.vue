<script setup lang="ts">
/**
 * SessionList：用户历史会话列表（左下角小卡片形态，CP8 改造）。
 * - 仅用户创建会话（排除 cheryNyxus——其走独立 NyxusHistoryPanel）。
 * - 形态：常驻左下索引签 launcher（点击展开/收起卡片），与 HistoryDrawer（消息史抽屉）形态区分。
 * - 显示驱动：agents.historyListOpen=true 展开；false 收起（AnimatePresence + motion.div）。
 * - 打开（watch open→true）：agents.fetchHistoryList() → chat.list(includePreview) 缓存 historyList。
 * - 行：preview（首条 user 消息截断，splitCommandPrompt 渲染 /cmd @role marker）+ 预设签 + 时间；矮行单行。
 * - 点行 → agents.loadSession(chatId)（建主+子 pet 入 stage）。
 * - 行尾 ✕ → ElMessageBox.confirm 后 agents.deleteSession(chatId)。
 * 命名区分 HistoryDrawer（单 pet 消息史，▤）；本组件 = 用户会话列表（☰，左下卡片）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { AnimatePresence, motion } from 'motion-v'
import { ElMessageBox } from 'element-plus'
import { useAgentsStore } from '@/stores'
import { formatTime } from '@/utils/formatTime'
import { splitCommandPrompt } from '../composables/commands'
import PresetTag from './PresetTag.vue'
import { CHERY_NYXUS_PRESET } from '@/stores/agents/data/petLifecycle'

const MotionDiv = motion.div
const agents = useAgentsStore()

const open = computed(() => agents.historyListOpen)
const loading = ref(false)
const error = ref<string | null>(null)
const pendingDelete = ref<string | null>(null)
const searchQuery = ref('')

// 仅用户会话（排除 cheryNyxus 独立核心）+ 主 chat + 搜索词过滤
const sessions = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  const all = agents.historyList.filter(
    (c) => !c.parentChatId && c.preset !== CHERY_NYXUS_PRESET,
  )
  if (!q) return all
  return all.filter((c) => (c.preview ?? '').toLowerCase().includes(q))
})

watch(open, async (v) => {
  if (!v) return
  loading.value = true
  error.value = null
  try {
    await agents.fetchHistoryList()
  } catch (e) {
    error.value = (e as Error).message
    console.error('[SessionList] fetchHistoryList 失败:', e)
  } finally {
    loading.value = false
  }
})

function toggleOpen(): void {
  agents.historyListOpen = !agents.historyListOpen
}
function close(): void {
  agents.historyListOpen = false
}

// 全局 ESC 关闭（仅 open 且为栈顶 overlay 时生效；topOverlay 守卫避免双重关闭）。
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value && agents.topOverlay === 'sessionList') {
    e.preventDefault()
    close()
  }
}
window.addEventListener('keydown', onGlobalKeydown)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
})

/** 删除确认文案池：8 种风格随机抽一，icon=应景 emoji。删除本身恒为危险操作，按钮保持 danger。 */
type DeletePromptStyle = { icon: string; title: string; body: string }
const DELETE_PROMPTS: readonly DeletePromptStyle[] = [
  {
    icon: '⚛️',
    title: '量子遗忘？',
    body: '本次操作将坍缩所有平行时间轴上的对话痕迹，确认启动记忆清除程序？',
  },
  {
    icon: '🤖',
    title: '数据清洗？',
    body: '所有比特记忆将永久格式化，缓存区彻底归零，是否继续执行？',
  },
  { icon: '🌫️', title: '如烟？', body: '让这场对话如晨雾般悄然散去，再不寻来路，你当真舍得？' },
  {
    icon: '🥀',
    title: '告别？',
    body: '那些字句曾温暖过寂寥的时光，如今要亲手将它们埋葬，只余空白与回响。',
  },
  {
    icon: '🕯️',
    title: '忘却？',
    body: '记忆是存在的影子，删除便是让影子消逝于光中，你确定要踏入无痕之境？',
  },
  {
    icon: '🐟',
    title: '失忆？',
    body: '一键开启金鱼模式，所有聊天记录统统蒸发，确定要这么绝情吗？',
  },
  { icon: '🌊', title: '相忘？', body: '此间言语，尽付东流，从此江湖不见，君意若何？' },
  {
    icon: '🕊️',
    title: '放下？',
    body: '让这段对话随风飘远，像从未发生过一样，你准备好轻装前行了吗？',
  },
]
function pickDeletePrompt(): DeletePromptStyle {
  return DELETE_PROMPTS[Math.floor(Math.random() * DELETE_PROMPTS.length)]!
}

async function remove(chatId: string): Promise<void> {
  // 二次确认：ElMessageBox（会话级删除后果重，用居中 modal）；pendingDelete 防 ✕ 重复点
  if (pendingDelete.value) return
  try {
    const prompt = pickDeletePrompt()
    await ElMessageBox.confirm(prompt.body, `${prompt.icon} ${prompt.title}`, {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
    })
  } catch {
    return // 用户取消
  }
  pendingDelete.value = chatId
  try {
    await agents.deleteSession(chatId)
  } catch (e) {
    error.value = (e as Error).message
    console.error('[SessionList] deleteSession 失败:', e)
  } finally {
    pendingDelete.value = null
  }
}

function load(chatId: string): void {
  agents.loadSession(chatId)
}
</script>

<template>
  <!-- 常驻左下索引签 launcher（点击展开/收起卡片） -->
  <button
    type="button"
    class="session-launcher"
    :class="{ active: open }"
    :aria-expanded="open"
    aria-label="用户历史会话"
    @click="toggleOpen"
  >
    <span class="launcher-icon">☰</span>
    <span class="launcher-label">会话</span>
    <span v-if="sessions.length" class="launcher-count">{{ sessions.length }}</span>
  </button>

  <AnimatePresence>
    <MotionDiv
      v-if="open"
      key="session-card"
      class="session-card"
      role="dialog"
      aria-modal="false"
      aria-label="用户历史会话列表"
      :initial="{ opacity: 0, y: 12 }"
      :animate="{ opacity: 1, y: 0 }"
      :exit="{ opacity: 0, y: 12 }"
      :transition="{ duration: 0.18, ease: 'easeOut' }"
    >
      <header class="card-head">
        <span class="title">历史会话</span>
        <button type="button" class="close-btn" aria-label="Close" @click="close">✕</button>
      </header>

      <div class="card-search">
        <input
          v-model="searchQuery"
          type="search"
          class="search-input"
          placeholder="搜索会话标题…"
          aria-label="搜索会话标题"
        />
      </div>

      <div class="card-body">
        <div v-if="loading" class="row-hint">载入会话…</div>
        <div v-else-if="error" class="row-hint err" role="alert">{{ error }}</div>
        <div v-else-if="sessions.length === 0" class="row-hint">
          {{ searchQuery.trim() ? '无匹配会话' : '暂无历史会话' }}
        </div>
        <template v-else>
          <div
            v-for="s in sessions"
            :key="s.chatId"
            class="session-row"
            :title="s.preview || '(无消息)'"
            @click="load(s.chatId)"
          >
            <PresetTag :preset="s.preset" />
            <span class="preview">
              <template
                v-for="(seg, i) in splitCommandPrompt(s.preview || '(无消息)')"
                :key="`${seg.type}-${i}`"
              >
                <span v-if="seg.type === 'role'" class="marker-tag marker-role">{{
                  seg.value
                }}</span>
                <span v-else-if="seg.type === 'command'" class="marker-tag marker-cmd">{{
                  seg.value
                }}</span>
                <template v-else>{{ seg.value }}</template>
              </template>
            </span>
            <span class="time">{{ formatTime(s.updatedAt) }}</span>
            <button
              type="button"
              class="del-btn"
              aria-label="删除会话"
              :disabled="pendingDelete === s.chatId"
              @click.stop="remove(s.chatId)"
            >
              ✕
            </button>
          </div>
        </template>
      </div>
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
@ink: #14161a;

// ── 常驻索引签 launcher（左下角，便利贴式）──
.session-launcher {
  position: fixed;
  left: 16px;
  bottom: 16px;
  z-index: 258;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px 5px 8px;
  border: 1px solid rgba(180, 110, 20, 0.4);
  border-radius: 8px;
  background: linear-gradient(135deg, #ffd27a, #f6b73c);
  color: #3d2606;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
  transition: transform 120ms ease, box-shadow 120ms ease;

  .launcher-icon {
    font-size: 13px;
    line-height: 1;
  }
  .launcher-count {
    padding: 0 6px;
    border-radius: 8px;
    background: rgba(61, 38, 6, 0.16);
    font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    font-size: 10px;
    line-height: 1.5;
  }
  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.22);
  }
  &.active {
    background: linear-gradient(135deg, #ffe9b8, #ffd27a);
  }
}

// ── 卡片（左下浮卡，位于 launcher 上方）──
.session-card {
  position: fixed;
  left: 16px;
  bottom: 56px;
  z-index: 269;
  width: 286px;
  max-height: 360px;
  display: flex;
  flex-direction: column;
  background: #fbf9f4;
  border: 1px solid rgba(36, 38, 45, 0.12);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
  overflow: hidden;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  border-bottom: 1px solid rgba(36, 38, 45, 0.1);
  background: rgba(255, 255, 255, 0.6);

  .title {
    font-size: 12px;
    font-weight: 800;
    color: fade(@ink, 86%);
  }
}

.close-btn {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.7);
  color: fade(@ink, 70%);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;

  &:hover {
    background: #ffffff;
    color: fade(@ink, 88%);
  }
}

.card-search {
  padding: 6px 8px;
  border-bottom: 1px solid rgba(36, 38, 45, 0.1);
  background: rgba(255, 255, 255, 0.5);

  .search-input {
    width: 100%;
    height: 24px;
    padding: 0 8px;
    border: 1px solid rgba(36, 38, 45, 0.16);
    border-radius: 5px;
    background: #ffffff;
    color: fade(@ink, 86%);
    font-size: 11px;
    outline: none;
    transition: border-color 120ms ease;

    &::placeholder {
      color: fade(@ink, 40%);
    }
    &:focus {
      border-color: fade(@ink, 48%);
    }
    &::-webkit-search-cancel-button {
      display: none;
    }
  }
}

.card-body {
  flex: 1;
  overflow-y: auto;
  padding: 5px 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row-hint {
  padding: 18px 8px;
  text-align: center;
  color: fade(@ink, 48%);
  font-size: 11px;
  font-style: italic;

  &.err {
    color: #b91c1c;
    font-style: normal;
  }
}

.session-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 7px;
  cursor: pointer;
  transition: background 120ms ease;

  &:hover {
    background: rgba(246, 183, 60, 0.14);
  }

  .preview {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    font-weight: 600;
    color: fade(@ink, 84%);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* 预览内联 marker tag（command 琥珀 / role 蓝） */
  .marker-tag {
    display: inline-block;
    margin: 0 3px 0 0;
    padding: 0 4px;
    border: 1px solid rgba(190, 132, 28, 0.28);
    border-radius: 3px;
    background: linear-gradient(135deg, rgba(255, 242, 195, 0.94), rgba(246, 183, 60, 0.14));
    color: #76500e;
    font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    font-size: 10px;
    font-weight: 700;
    line-height: 1.5;
    vertical-align: baseline;
  }
  .marker-role {
    border-color: rgba(70, 126, 202, 0.28);
    background: linear-gradient(135deg, rgba(224, 239, 255, 0.94), rgba(70, 126, 202, 0.14));
    color: #2f6fae;
  }

  .time {
    flex-shrink: 0;
    font-size: 10px;
    color: fade(@ink, 44%);
  }

  .del-btn {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 1px solid rgba(185, 28, 28, 0.24);
    border-radius: 4px;
    background: transparent;
    color: #b91c1c;
    font-size: 10px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition: opacity 120ms ease, background 120ms ease;

    &:hover:not(:disabled) {
      background: #fee2e2;
    }
    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  // 行 hover 时显删除按钮（触屏无 hover 始终显）
  &:hover .del-btn {
    opacity: 1;
  }
}
</style>
