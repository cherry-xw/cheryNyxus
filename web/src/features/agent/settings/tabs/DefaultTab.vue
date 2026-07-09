<script setup lang="ts">
/**
 * DefaultTab：默认宠物配置（config.default）。
 * 「+」召唤主宠时套用的大脑 / 感官组 / MCP。移除默认配置不二次确认（非破坏性，可重建）。
 */
import type { ConfigDto } from "@/services/agentApi";

const props = defineProps<{ draft: ConfigDto }>();
</script>

<template>
  <section class="sect">
    <p class="sect-hint">「+」召唤出的主宠默认套用哪颗大脑、开放哪些感官、连哪些外部工具。</p>
    <template v-if="draft.default">
      <label class="field">
        <span class="lbl">大脑 brain</span>
        <el-select v-model="draft.default.brain">
          <el-option v-for="(_, name) in draft.llm.brain" :key="name" :label="String(name)" :value="name" />
        </el-select>
      </label>
      <div class="field">
        <span class="lbl">感官组 senseGroups</span>
        <el-checkbox-group
          :model-value="draft.default.senseGroups"
          class="chk-list"
          @change="(v) => (draft.default.senseGroups = v as string[])"
        >
          <el-checkbox v-for="(_, gname) in draft.sense_groups" :key="gname" :value="gname as string">
            {{ gname }}
          </el-checkbox>
          <span v-if="!draft.sense_groups || !Object.keys(draft.sense_groups).length" class="empty">无感官组（先在「感官分组」建）</span>
        </el-checkbox-group>
      </div>
      <div class="field">
        <span class="lbl">MCP mcpServers</span>
        <el-checkbox-group
          :model-value="draft.default.mcpServers ?? []"
          class="chk-list"
          @change="(v) => (draft.default.mcpServers = v as string[])"
        >
          <el-checkbox v-for="(_, mname) in draft.mcp_servers" :key="mname" :value="mname as string">
            {{ mname }}
          </el-checkbox>
          <span v-if="!draft.mcp_servers || !Object.keys(draft.mcp_servers).length" class="empty">无 MCP server</span>
        </el-checkbox-group>
      </div>
      <button type="button" class="link-btn" @click="props.draft.default = undefined">移除默认配置</button>
    </template>
    <button v-else type="button" class="link-btn" @click="props.draft.default = { brain: '', senseGroups: [] }">
      + 设置默认宠物配置
    </button>
  </section>
</template>

<style scoped lang="less">
@import "../shared.less";
</style>
