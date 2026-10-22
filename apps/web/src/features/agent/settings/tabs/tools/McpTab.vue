<script setup lang="ts">
/**
 * McpTab：MCP 服务（config.mcp_servers）配置。
 * stdio=本地子进程；streamable-http=连远程。删除走 ConfirmPopover 二次确认。
 */
import { ref, computed } from 'vue'
import { Delete } from '@element-plus/icons-vue'
import type { ConfigDto } from '@/application/backend/public'
import { SUPERVISIONS, SUPERVISION_LABEL } from '../../config/constants'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import TabShell, { type IndexItem } from '@/features/agent/settings/components/TabShell.vue'
import { SettingsMcpServerSchema } from '@chery/protocol'

const props = defineProps<{ draft: ConfigDto }>()
const emit = defineEmits<{ (e: 'error', msg: string): void }>()

const newMcpName = ref('')
function errors(name: string) {
  const result = SettingsMcpServerSchema.safeParse(props.draft.mcp_servers?.[name])
  return result.success ? '' : result.error.issues.map(issue => `mcp_servers.${name}.${issue.path.join('.')}: ${issue.message}`).join('\n')
}

function addMcp(): void {
  const name = newMcpName.value.trim()
  if (!name) return
  if (!props.draft.mcp_servers) props.draft.mcp_servers = {}
  if (props.draft.mcp_servers[name]) {
    emit('error', `MCP server "${name}" 已存在`)
    return
  }
  props.draft.mcp_servers[name] = { transport: 'stdio' }
  newMcpName.value = ''
}
function removeMcp(name: string): void {
  if (!props.draft.mcp_servers) return
  delete props.draft.mcp_servers[name]
}

/** 序号按钮列表：每 MCP 服务一项。brief 给 mini popper 用（transport + url/command）。 */
const indexItems = computed<IndexItem[]>(() => {
  const servers = props.draft.mcp_servers ?? {}
  return Object.entries(servers).map(([mname, cfg]) => ({
    label: mname,
    transport: cfg.transport ?? '必填：请选择传输方式',
    target: cfg.transport === 'streamable-http' ? (cfg.url ?? '') : (cfg.command ?? ''),
  }))
})
</script>

<template>
  <TabShell tab-key="mcp" :index-items="indexItems">
    <template #hints>
      <p class="sect-hint">外挂工具站。stdio=本地起子进程；streamable-http=连远程。</p>
      <p class="warn-hint">stdio 环境未设置时的默认未核实；显式 env 仍按现有配置传递，不代表完整继承主进程环境。不会在查看时启动或连接 MCP。</p>
    </template>
    <template #popper="{ item }">
      <div class="index-card">
        <div class="index-card-title">{{ item.label as string }}</div>
        <div class="index-card-line">
          <b>传输</b><span>{{ item.transport as string }}</span>
        </div>
        <div v-if="item.target" class="index-card-line">
          <b>{{ item.transport === 'streamable-http' ? 'url' : 'cmd' }}</b>
          <span>{{ item.target as string }}</span>
        </div>
      </div>
    </template>
    <article
      v-for="(cfg, mname, idx) in draft.mcp_servers"
      :key="mname"
      class="card"
      :data-anchor="idx"
    >
      <span class="card-idx">{{ idx + 1 }}</span>
      <header class="card-head">
        <span class="card-name">{{ mname }}</span>
        <ConfirmPopover
          :title="`确认删除 MCP 服务「${mname}」？`"
          @confirm="removeMcp(mname as string)"
        >
          <template #trigger>
            <button type="button" class="icon-btn danger" aria-label="删除">
              <Delete class="ico" />
            </button>
          </template>
        </ConfirmPopover>
      </header>
      <div class="card-grid">
        <label class="field">
          <span class="lbl">transport 传输</span>
          <el-select v-model="cfg.transport" placeholder="必填：请选择传输方式" :aria-invalid="!!errors(mname)" :aria-describedby="`mcp-${mname}-error`">
            <el-option label="stdio（本地子进程）" value="stdio" />
            <el-option label="streamable-http（远程）" value="streamable-http" />
          </el-select>
        </label>
        <label class="field">
          <span class="lbl">supervision 默认监管</span>
          <el-select v-model="cfg.supervision" placeholder="（用全局）">
            <el-option label="（用全局）" :value="undefined" />
            <el-option
              v-for="s in SUPERVISIONS"
              :key="s"
              :label="SUPERVISION_LABEL[s]"
              :value="s"
            />
          </el-select>
        </label>
        <template v-if="cfg.transport === 'stdio'">
          <label class="field">
            <span class="lbl">command 命令</span>
            <el-input v-model="cfg.command" placeholder="必填，例如 npx" :aria-invalid="!!errors(mname)" :aria-describedby="`mcp-${mname}-error`" />
          </label>
          <label class="field">
            <span class="lbl">args 参数（逗号分隔）</span>
            <el-input
              :value="(cfg.args ?? []).join(', ')"
              placeholder="-y, @modelcontextprotocol/server-filesystem, /tmp"
              @input="
                cfg.args = $event
                  .split(',')
                  .map((s: string) => s.trim())
                  .filter(Boolean)
              "
            />
          </label>
        </template>
        <label v-else-if="cfg.transport === 'streamable-http'" class="field">
          <span class="lbl">url 远程地址</span>
          <el-input v-model="cfg.url" placeholder="必填：http://localhost:8081/mcp" :aria-invalid="!!errors(mname)" :aria-describedby="`mcp-${mname}-error`" />
        </label>
      </div>
      <p v-if="errors(mname)" :id="`mcp-${mname}-error`" role="alert">{{ errors(mname) }}</p>
    </article>
    <div class="add-row">
      <el-input v-model="newMcpName" placeholder="新 server 名" @keydown.enter="addMcp" />
      <button type="button" class="ghost-btn" @click="addMcp">+ 新增</button>
    </div>
  </TabShell>
</template>

<style scoped lang="less">
@import '../../config/shared.less';

// 输入框/下拉 focus 边框跟随 mcp 主题色（取代全局 primary 暖橙）
:deep(.el-input),
:deep(.el-select) {
  --el-color-primary: var(--tab-color, @accent);
}
</style>
