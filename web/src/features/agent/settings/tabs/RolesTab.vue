<script setup lang="ts">
/**
 * RolesTab：角色（config.roles）配置。
 * 主宠派出的助手与预设组长，各配大脑与感官。标题可点击改名（保序重建 + 迁移 presets.*.roles/leader 引用）；
 * 删除走 ConfirmPopover 二次确认。
 */
import { ref, computed } from "vue";
import { Delete } from "@element-plus/icons-vue";
import type { ConfigDto } from "@/services/agentApi";
import ConfirmPopover from "../ConfirmPopover.vue";
import EditableTitle from "../components/EditableTitle.vue";
import { buildPromptTree } from "./promptTree";

const props = defineProps<{ draft: ConfigDto; prompts: string[] }>();
const emit = defineEmits<{ (e: "error", msg: string): void }>();

/** systemPrompt 级联选择器目录树（prompts 路径 → 组文件夹 → .md）。 */
const promptTree = computed(() => buildPromptTree(props.prompts));

const newRoleType = ref("");

function onError(msg: string): void {
  emit("error", msg);
}

function addRole(): void {
  const type = newRoleType.value.trim();
  if (!type) return;
  if (!props.draft.roles) props.draft.roles = {};
  if (props.draft.roles[type]) {
    emit("error", `角色 "${type}" 已存在`);
    return;
  }
  props.draft.roles[type] = { brain: "", senseGroup: "" };
  newRoleType.value = "";
}
function removeRole(type: string): void {
  if (!props.draft.roles) return;
  delete props.draft.roles[type];
  // 清理预设引用（与 renameRole 同模式：被删 type 从 presets.*.roles 移除，若 leader 为该 type 则清空）
  // 否则后端 validateRawConfig 会因 leader/roles 引用未知 type 拒写盘（规则12 fail loud）
  if (props.draft.presets) {
    for (const p of Object.values(props.draft.presets)) {
      if (p.roles) p.roles = p.roles.filter((r) => r !== type);
      if (p.leader === type) p.leader = "";
    }
  }
}
/** 改名：保序重建 roles + 迁移 presets.*.roles 成员与 leader 引用。 */
function renameRole(oldType: string, newType: string): void {
  if (!props.draft.roles) return;
  const cfg = props.draft.roles[oldType];
  const rebuilt = {} as typeof props.draft.roles;
  for (const [k, v] of Object.entries(props.draft.roles)) {
    if (k === oldType) rebuilt[newType] = cfg!;
    else rebuilt[k] = v;
  }
  props.draft.roles = rebuilt;
  if (props.draft.presets) {
    for (const p of Object.values(props.draft.presets)) {
      if (p.roles) p.roles = p.roles.map((r) => (r === oldType ? newType : r));
      if (p.leader === oldType) p.leader = newType;
    }
  }
  emit("error", "");
}
function validateRename(newType: string): string | null {
  if (!props.draft.roles) return null;
  return props.draft.roles[newType] ? `角色 "${newType}" 已存在` : null;
}
function supportsTools(brainName: string): boolean {
  return props.draft.llm.brain[brainName]?.capabilities?.toolCall !== false;
}
function onBrainChange(cfg: { brain: string; senseGroup: string; mcpServers?: string[] }, brain: string): void {
  cfg.brain = brain;
  if (!supportsTools(brain)) {
    cfg.senseGroup = "";
    cfg.mcpServers = [];
  }
}
</script>

<template>
  <section class="sect">
    <p class="sect-hint">主宠派出的助手与预设组长，各配大脑与感官。标题可点击改名。</p>
    <article v-for="(cfg, type, idx) in draft.roles" :key="type" class="card">
      <span class="card-idx">{{ idx + 1 }}</span>
      <header class="card-head">
        <EditableTitle
          :model-value="type as string"
          :validate="validateRename"
          @rename="(n: string) => renameRole(type as string, n)"
          @error="onError"
        >
          <template #actions>
            <ConfirmPopover :title="`确认删除角色「${type}」？`" @confirm="removeRole(type as string)">
              <template #trigger>
                <button type="button" class="icon-btn danger" aria-label="删除">
                  <Delete class="ico" />
                </button>
              </template>
            </ConfirmPopover>
          </template>
        </EditableTitle>
      </header>
      <div class="card-grid">
        <label class="field">
          <span class="lbl">大脑 brain</span>
          <el-select :model-value="cfg.brain" @update:model-value="(v: unknown) => onBrainChange(cfg, v as string)">
            <el-option label="（未选）" value="" />
            <el-option v-for="(_, bname) in draft.llm.brain" :key="bname" :label="String(bname)" :value="bname" />
          </el-select>
        </label>
        <label class="field">
          <span class="lbl">systemPrompt（.chery/prompts 分级选择）</span>
          <el-cascader
            :model-value="cfg.systemPrompt ?? ''"
            :options="promptTree"
            :props="{ expandTrigger: 'hover', emitPath: false }"
            filterable
            clearable
            placeholder="缺省 = 全局 system_prompt"
            class="prompt-cascader"
            @update:model-value="(v: unknown) => (cfg.systemPrompt = v ? (v as string) : undefined)"
          />
        </label>
      </div>
      <div class="field">
        <span class="lbl">感官组 senseGroup</span>
        <el-select
          :model-value="cfg.senseGroup ?? ''"
          placeholder="选择感官组"
          :disabled="!supportsTools(cfg.brain)"
          @update:model-value="(v: unknown) => (cfg.senseGroup = (v as string) ?? '')"
        >
          <el-option label="（未选）" value="" />
          <el-option v-for="(_, gname) in draft.sense_groups" :key="gname" :label="gname as string" :value="gname as string" />
        </el-select>
      </div>
      <div class="field">
        <span class="lbl">MCP 服务 mcpServers</span>
        <template v-if="supportsTools(cfg.brain) && draft.mcp_servers && Object.keys(draft.mcp_servers).length">
          <el-checkbox-group
            :model-value="cfg.mcpServers ?? []"
            class="chk-list"
            @change="(v: unknown) => (cfg.mcpServers = v as string[])"
          >
            <el-checkbox v-for="(_, mname) in draft.mcp_servers" :key="mname" :value="mname as string">
              {{ mname }}
            </el-checkbox>
          </el-checkbox-group>
        </template>
        <span v-else class="empty">{{ supportsTools(cfg.brain) ? '未配置 MCP 服务（空 = 关闭所有 MCP）' : '当前模型仅支持问答，不能配置工具或 MCP' }}</span>
      </div>
    </article>
    <div class="add-row">
      <el-input v-model="newRoleType" placeholder="新角色类型名" @keydown.enter="addRole" />
      <button type="button" class="ghost-btn" @click="addRole">+ 新增</button>
    </div>
  </section>
</template>

<style scoped lang="less">
@import "../shared.less";

.prompt-cascader {
  width: 100%;
}
</style>
