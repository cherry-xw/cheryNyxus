<script setup lang="ts">
/**
 * McpTab：MCP 服务（config.mcp_servers）配置。
 * stdio=本地子进程；streamable-http=连远程。删除走 ConfirmPopover 二次确认。
 */
import { ref } from "vue";
import { Delete } from "@element-plus/icons-vue";
import type { ConfigDto } from "@/services/agentApi";
import { SUPERVISIONS, SUPERVISION_LABEL } from "../constants";
import ConfirmPopover from "../ConfirmPopover.vue";

const props = defineProps<{ draft: ConfigDto }>();
const emit = defineEmits<{ (e: "error", msg: string): void }>();

const newMcpName = ref("");

function addMcp(): void {
  const name = newMcpName.value.trim();
  if (!name) return;
  if (!props.draft.mcp_servers) props.draft.mcp_servers = {};
  if (props.draft.mcp_servers[name]) {
    emit("error", `MCP server "${name}" 已存在`);
    return;
  }
  props.draft.mcp_servers[name] = { transport: "stdio" };
  newMcpName.value = "";
}
function removeMcp(name: string): void {
  if (!props.draft.mcp_servers) return;
  delete props.draft.mcp_servers[name];
}
</script>

<template>
  <section class="sect">
    <p class="sect-hint">外挂工具站。stdio=本地起子进程；streamable-http=连远程。</p>
    <p class="warn-hint">⚠️ env 注入与远程 server 网络可达性需自行确认。</p>
    <article v-for="(cfg, mname, idx) in draft.mcp_servers" :key="mname" class="card">
      <span class="card-idx">{{ idx + 1 }}</span>
      <header class="card-head">
        <span class="card-name">{{ mname }}</span>
        <ConfirmPopover :title="`确认删除 MCP 服务「${mname}」？`" @confirm="removeMcp(mname as string)">
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
          <el-select v-model="cfg.transport">
            <el-option label="stdio（本地子进程）" value="stdio" />
            <el-option label="streamable-http（远程）" value="streamable-http" />
          </el-select>
        </label>
        <label class="field">
          <span class="lbl">supervision 默认监管</span>
          <el-select v-model="cfg.supervision" placeholder="（用全局）">
            <el-option label="（用全局）" :value="undefined" />
            <el-option v-for="s in SUPERVISIONS" :key="s" :label="SUPERVISION_LABEL[s]" :value="s" />
          </el-select>
        </label>
        <template v-if="cfg.transport === 'stdio'">
          <label class="field">
            <span class="lbl">command 命令</span>
            <el-input v-model="cfg.command" placeholder="npx" />
          </label>
          <label class="field">
            <span class="lbl">args 参数（逗号分隔）</span>
            <el-input
              :value="(cfg.args ?? []).join(', ')"
              placeholder="-y, @modelcontextprotocol/server-filesystem, /tmp"
              @input="cfg.args = $event.split(',').map((s: string) => s.trim()).filter(Boolean)"
            />
          </label>
        </template>
        <label v-else class="field">
          <span class="lbl">url 远程地址</span>
          <el-input v-model="cfg.url" placeholder="http://localhost:8081/mcp" />
        </label>
      </div>
    </article>
    <div class="add-row">
      <el-input v-model="newMcpName" placeholder="新 server 名" @keydown.enter="addMcp" />
      <button type="button" class="ghost-btn" @click="addMcp">+ 新增</button>
    </div>
  </section>
</template>

<style scoped lang="less">
@import "../shared.less";
</style>
