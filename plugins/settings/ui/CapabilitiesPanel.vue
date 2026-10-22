<script setup lang="ts">
import SearchSettings from './SearchSettings.vue'
import FilesSettings from './FilesSettings.vue'
import ImageInputSettings from '../../../packages/manager-ui/src/ImageInputSettings.vue'
import Dropdown from '../../../packages/manager-ui/src/Dropdown.vue'
import PresetPrompts from './PresetPrompts.vue'
import { onMounted, onUnmounted, watch, ref } from 'vue'
import { protocols, useCapabilities } from './useCapabilities'
const {
  state,
  editors,
  model,
  choices,
  availableTools,
  thinkingLevels,
  toolName,
  toolInfo,
  busy,
  loadCatalog,
  openResource,
  saveResource,
  deleteResource,
  readBack,
  fetchModels,
  identify,
  addTool,
  clearSecrets,
  effectiveCapabilities, effectiveProtocol, defaultAddress, modelBlockedBy, resetField, adoptContextLimit,
} = useCapabilities()
const props = defineProps<{ active?: boolean }>()
watch(
  () => props.active,
  (active) => {
    if (!active) clearSecrets()
  },
)
const pendingTool = ref('')
const kinds = ['brains', 'sense-groups', 'presets'] as const
const titles = { brains: '模型设置', 'sense-groups': '工具设置', presets: '预设创建' }
function chooseTool() {
  addTool(pendingTool.value)
  pendingTool.value = ''
}
onMounted(() => void loadCatalog())
onUnmounted(clearSecrets)
</script>

<template>
  <section class="panel capability-panel">
    <div class="section-heading">
      <h1>能力管理</h1>
      <button :disabled="state.loading || state.writing" @click="loadCatalog">
        {{ state.loading ? '加载中…' : '刷新目录' }}
      </button>
    </div>
    <p v-if="state.error" class="error" role="alert">{{ state.error }}</p>
    <p v-else-if="state.loading" role="status">正在读取已保存资源和工具目录…</p>
    <div class="capability-grid">
      <FilesSettings />
      <article
        v-for="kind in kinds"
        :key="kind"
        class="capability-block"
        :data-capability="kind"
        :aria-busy="busy(kind)"
      >
        <div class="resource-heading">
          <h2>{{ titles[kind] }}</h2>
          <button
            v-if="editors[kind].selected"
            type="button"
            class="text-action"
            :disabled="busy(kind) || editors[kind].uncertain"
            @click="deleteResource(kind)"
          >
            删除所选资源
          </button>
        </div>
        <SearchSettings v-if="kind === 'sense-groups'" />
        <p v-if="kind === 'sense-groups'" class="notice">
          允许自动会直接执行工具。QQ 无人工确认入口，QQ
          使用的工具须选择允许自动；目前不支持用户反馈/用户交互相关操作。
        </p>
        <label
          >编辑已有{{ kind === 'brains' ? '模型' : kind === 'sense-groups' ? '工具组' : '预设' }}
          <Dropdown
            v-model="editors[kind].selected"
            :disabled="busy(kind) || !state.ready"
            @change="openResource(kind)"
          >
            <option value="">新建</option>
            <option v-for="name in choices(kind)" :key="name" :value="name">{{ name }}</option>
          </Dropdown>
        </label>
        <p v-if="state.ready && !choices(kind).length" class="muted">
          尚无已保存资源，可在下方创建。
        </p>
        <p v-if="editors[kind].loading" role="status">读取中…</p>
        <form @submit.prevent="saveResource(kind)">
          <fieldset :disabled="busy(kind) || !state.ready || editors[kind].uncertain">
            <label>名称<input v-model="editors[kind].name" required maxlength="128" /></label>
            <template v-if="kind === 'brains'">
              <ImageInputSettings :brain="editors.brains.value" :inherited="effectiveCapabilities" :catalog-status="model.identifying ? 'loading' : model.recommendation ? 'ready' : 'error'" />
              <div class="field-stack">
                <label
                  >模型 URL<input
                    :value="editors.brains.value.url ?? ''"
                    type="text"
                    :placeholder="defaultAddress"
                    @input="($event.target as HTMLInputElement).value ? editors.brains.value.url = ($event.target as HTMLInputElement).value : resetField('brains', 'url')"
                    autocomplete="off"
                /></label>
                <small v-if="editors.brains.value.url === undefined">{{ defaultAddress }} · 实际默认地址</small>
                <button v-if="editors.brains.value.url !== undefined" type="button" @click="resetField('brains', 'url')">恢复默认地址</button>
                <label class="check-label"
                  ><input v-model="editors.brains.value.fullUrl" type="checkbox" />完整请求
                  URL（已包含端点）</label
                >
              </div>
              <div class="field-stack">
                <label
                  >Key（只提交，不回显）<input
                    v-model="editors.brains.key"
                    type="password"
                    autocomplete="new-password"
                    :placeholder="
                      editors.brains.keyConfigured
                        ? '已配置；留空复用，输入新 Key 可替换'
                        : '输入模型服务 Key'
                    "
                /></label>
                <button
                  type="button"
                  :disabled="
                    model.loading || !!modelBlockedBy
                  "
                  @click="fetchModels"
                >
                  {{ model.loading ? '获取中…' : '获取模型列表' }}
                </button>
                <small v-if="modelBlockedBy">{{ modelBlockedBy }}</small>
                <button v-if="editors.brains.keyConfigured" type="button" @click="resetField('brains', 'key')">清除已存密钥</button>
              </div>
              <p v-if="model.error" class="error" role="alert">{{ model.error }}</p>
              <label>服务<input v-model="editors.brains.value.provider" required /></label>
              <label>上下文容量（K，1K = 1000 token）<input type="number" step="any" min="0.001" :value="editors.brains.value.contextLimit === undefined ? '' : editors.brains.value.contextLimit / 1000" required :aria-invalid="!Number.isInteger(editors.brains.value.contextLimit) || editors.brains.value.contextLimit <= 0" aria-describedby="manager-context-error" @input="editors.brains.value.contextLimit = ($event.target as HTMLInputElement).value ? Number(($event.target as HTMLInputElement).value) * 1000 : undefined" /></label>
              <small v-if="!Number.isInteger(editors.brains.value.contextLimit) || editors.brains.value.contextLimit <= 0" id="manager-context-error" role="alert">请填写正整数 token 容量；目录推荐不会自动写入。</small>
              <button v-if="model.recommendation?.recommend?.contextLimit" type="button" @click="adoptContextLimit">采用推荐值 {{ model.recommendation.recommend.contextLimit / 1000 }}K</button>
              <label
                >模型<Dropdown
                  v-model="editors.brains.value.model"
                  required
                  :disabled="
                    model.loading || (!model.options.length && !editors.brains.value.model)
                  "
                >
                  <option value="">先获取列表，再选择模型</option>
                  <option
                    v-if="
                      editors.brains.value.model &&
                      !model.options.some((item) => item.id === editors.brains.value.model)
                    "
                    :value="editors.brains.value.model"
                  >
                    {{ editors.brains.value.model }}（已保存）
                  </option>
                  <option v-for="item in model.options" :key="item.id" :value="item.id">
                    {{ item.name || item.id }}
                  </option>
                </Dropdown></label
              >

              <div class="field-stack">
                <label
                  >协议<Dropdown
                    :model-value="editors.brains.value.protocol ?? ''"
                    @update:model-value="(value: string) => value ? editors.brains.value.protocol = value : resetField('brains', 'protocol')"
                    @change="model.automatic = false"
                  >
                    <option value="">{{ effectiveProtocol ?? '必填：无法确定实际协议' }} · 运行缺省</option>
                    <option
                      v-if="!protocols.some((item) => item.id === editors.brains.value.protocol)"
                      :value="editors.brains.value.protocol"
                    >
                      {{ editors.brains.value.protocol }}（已有配置）
                    </option>
                    <option v-for="item in protocols" :key="item.id" :value="item.id">
                      {{ item.label }}
                    </option>
                  </Dropdown></label
                >
                <label class="check-label"
                  ><input
                    v-model="model.automatic"
                    type="checkbox"
                    @change="identify(true)"
                  />使用后端推荐协议</label
                >
              </div>
              <p role="status" class="muted">
                {{ model.identifying ? '后端识别中…' : model.notice }}
              </p>
              <label
                >思考等级<Dropdown
                    :model-value="editors.brains.value.thinking ?? ''"
                    @update:model-value="(value: string) => value ? editors.brains.value.thinking = value : resetField('brains', 'thinking')"
                  :disabled="model.identifying || !thinkingLevels.length"
                >
                  <option value="">off · 运行默认（仍受型号与全局开关限制）</option>
                  <option
                    v-if="editors.brains.value.thinking && !thinkingLevels.includes(editors.brains.value.thinking)"
                    :value="editors.brains.value.thinking"
                  >
                    {{ editors.brains.value.thinking }}（当前值）
                  </option>
                  <option v-for="level in thinkingLevels" :key="level" :value="level">
                    {{ level }}
                  </option>
                </Dropdown></label
              >
              <p class="muted">
                仅显示后端 model-catalog.yaml
                为此模型与协议配置的档位；运行时按配置映射参数，并受全局思考开关控制。
              </p>
            </template>
            <template v-else-if="kind === 'sense-groups'">
              <label
                >从工具目录添加<Dropdown v-model="pendingTool" :disabled="!availableTools.length"
                  ><option value="">选择工具</option>
                  <option v-for="tool in availableTools" :key="tool.name" :value="tool.name">
                    {{ tool.label || tool.name }}
                  </option></Dropdown
                ><button type="button" :disabled="!pendingTool" @click="chooseTool">
                  添加工具
                </button></label
              >
              <p v-if="!state.catalog.tools.length" class="muted">当前后端没有可用工具。</p>
              <p v-else-if="!availableTools.length" class="muted">目录中的工具已全部添加。</p>
              <p v-if="!editors['sense-groups'].value.length" class="muted">
                尚未添加工具；可保存空工具组。
              </p>
              <ul class="capability-tools">
                <li v-for="(entry, index) in editors['sense-groups'].value" :key="toolName(entry)">
                  <div class="tool-heading">
                    <b>{{ toolInfo(entry)?.label || toolName(entry) }}</b
                    ><button
                      class="text-action"
                      type="button"
                      @click="editors['sense-groups'].value.splice(index, 1)"
                    >
                      移除
                    </button>
                  </div>
                  <p v-if="!toolInfo(entry) || toolInfo(entry)?.unavailableReason" class="warning">配置保留，本次请求将排除：{{ toolInfo(entry)?.unavailableReason === 'plugin_disabled' ? '插件已停用' : toolInfo(entry)?.unavailableReason === 'plugin_uninstalled' ? '插件已卸载' : toolInfo(entry)?.unavailableReason === 'plugin_failed' ? '插件启动失败' : '未找到该工具' }}。不会自动换用其他工具。</p>
                  <details>
                    <summary>能力与边界</summary>
                    <p>
                      {{
                        toolInfo(entry)?.description ||
                        '该工具不在当前目录中；名称与允许范围仍可保存，恢复插件后重新读取目录。'
                      }}
                    </p>
                  </details>
                  <label class="permission-row"
                    ><span>允许范围</span
                    ><Dropdown
                      :value="entry.split(':')[1] || 'auto'"
                      @change="
                        editors['sense-groups'].value[index] =
                          `${toolName(entry)}:${($event.target as HTMLSelectElement).value}`
                      "
                      ><option value="auto">允许自动</option>
                      <option value="smart">智能判断</option>
                      <option value="manual">人工确认</option></Dropdown
                    ></label
                  >
                </li>
              </ul>
            </template>
            <template v-else>
              <label
                >已保存模型<Dropdown v-model="editors.presets.value.brain" required
                  ><option value="">选择模型配置</option>
                  <option
                    v-if="
                      editors.presets.value.brain &&
                      !state.catalog.brains.includes(editors.presets.value.brain)
                    "
                    :value="editors.presets.value.brain"
                  >
                    {{ editors.presets.value.brain }}（资源不存在）
                  </option>
                  <option v-for="name in state.catalog.brains" :key="name" :value="name">
                    {{ name }}
                  </option></Dropdown
                ></label
              >
              <label
                >已保存工具组<Dropdown v-model="editors.presets.value.senseGroup"
                  ><option value="">不使用工具（仅限无工具能力模型）</option>
                  <option
                    v-if="
                      editors.presets.value.senseGroup &&
                      !state.catalog.senseGroups.includes(editors.presets.value.senseGroup)
                    "
                    :value="editors.presets.value.senseGroup"
                  >
                    {{ editors.presets.value.senseGroup }}（资源不存在）
                  </option>
                  <option v-for="name in state.catalog.senseGroups" :key="name" :value="name">
                    {{ name }}
                  </option></Dropdown
                ></label
              >
              <p
                v-if="!state.catalog.brains.length || !state.catalog.senseGroups.length"
                class="muted"
              >
                先保存模型和工具组，再创建预设。
              </p>
              <div class="preset-references">
                <b>角色信息</b>
                <p>角色：{{ editors.presets.value.roles?.join('、') || '保存时创建' }}</p>
                <p v-if="editors.presets.value.leader">
                  组长角色：{{ editors.presets.value.leader }}
                </p>
                <p>解释角色：{{ editors.presets.value.detailRole || '未启用解释角色' }}</p>
                <button v-if="editors.presets.value.detailRole !== undefined" type="button" @click="resetField('presets', 'detailRole')">恢复未启用解释角色</button>
                <p>工作区：{{ editors.presets.value.workspace || '未限定工作区' }}</p>
                <button v-if="editors.presets.value.workspace !== undefined" type="button" @click="resetField('presets', 'workspace')">恢复不限定工作区</button>
              </div>
            </template>
            <div class="form-actions">
              <button type="submit">
                {{ editors[kind].saving ? '保存中…' : '保存并回读确认' }}
              </button>
            </div>
          </fieldset>
        </form>
        <PresetPrompts v-if="kind === 'presets'" :preset="editors.presets.selected" :disabled="busy(kind) || editors.presets.uncertain" @saved="readBack('presets')" />
        <p v-if="editors[kind].error" class="error" role="alert">{{ editors[kind].error }}</p>
        <p v-if="editors[kind].message" role="status">{{ editors[kind].message }}</p>
        <button
          v-if="editors[kind].selected || editors[kind].uncertain"
          :disabled="busy(kind) || state.loading"
          @click="readBack(kind)"
        >
          重新读取同名资源（替换草稿）
        </button>
      </article>
    </div>
  </section>
</template>
<style scoped>
.capability-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 14px;
}
@media (max-width: 900px) {
  .capability-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 620px) {
  .capability-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
.capability-block {
  min-width: 0;
}
.capability-block h2 {
  margin: 0 0 10px;
  font-size: 18px;
}
.capability-block label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 10px 0;
}
.capability-block input,
.capability-block select {
  width: 100%;
  min-width: 0;
}
.capability-block fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.capability-block fieldset > p,
.capability-tools,
.preset-references {
  grid-column: 1 / -1;
}
@media (max-width: 620px) {
  .capability-block fieldset {
    grid-template-columns: minmax(0, 1fr);
  }
}
.capability-block .check-label {
  flex-direction: row;
  align-items: center;
}
.check-label input {
  width: auto;
}
.capability-block p {
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.capability-tools {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px;
}
.capability-block button {
  align-self: center;
  justify-self: start;
  min-height: 30px;
}
.capability-tools li {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px;
  align-items: center;
}
.capability-tools li b,
.capability-tools li details {
  grid-column: 1 / -1;
}
.capability-tools li label {
  margin: 0;
}
.capability-tools li,
.preset-references {
  border: 1px solid #808080;
  padding: 6px;
  margin: 0;
}
.capability-tools summary {
  cursor: pointer;
  padding: 6px 0;
}
.capability-notice {
  margin-top: 16px;
}

.resource-heading,
.tool-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.capability-block .text-action {
  background: none;
  border: 0;
  color: #1677ff;
  padding: 2px 0;
  min-height: 0;
  cursor: pointer;
  box-shadow: none;
  white-space: nowrap;
}
.capability-block fieldset {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px 20px;
}
.capability-block fieldset > label,
.field-stack {
  flex: 1 1 260px;
  min-width: 0;
}
.capability-block fieldset > p,
.capability-tools,
.preset-references,
.form-actions {
  flex: 1 0 100%;
}
.field-stack label {
  margin: 0 0 8px;
}
.field-stack .check-label {
  font-size: 13px;
}
.capability-tools li {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  border-color: #d4d8df;
  border-radius: 6px;
  padding: 10px;
}
.capability-tools .permission-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.permission-row > span {
  white-space: nowrap;
  flex: none;
}
.permission-row :deep(.dropdown) {
  flex: 1;
  min-width: 0;
}
.form-actions {
  display: flex;
  gap: 10px;
}
.capability-block label {
  margin: 4px 0;
}
</style>
