<script setup lang="ts">
import { useRolesTabController, type RolesTabControllerProps, type RolesTabControllerEmits } from './useRolesTabController'
const props = defineProps<RolesTabControllerProps>()
const emit = defineEmits<RolesTabControllerEmits>()
const controller = useRolesTabController(props, emit)
const {
  AvatarPicker, ConfirmPopover, CopyDocument, Delete, EditableTitle, EquipmentEditor,
  EquipmentPicker, LabelTip, Lock, Plus, ResourceWorkbench, TEMPLATE_CARDS, activeEquipment,
  addRole, allowedShells, brainNames, cancelDescEdit, checkOverflow, closeEquipment, commitDescEdit,
  copiedRole, current, descEditValue, descEditing, duplicateRole, effectivePermission,
  equipmentEditor, isFixedRole, isOverflowing, mcpNames, mcpTokens, newRoleType, openEquipment,
  permissionPreview, permissionTemplate, promptOptions, railItems, ref, removeImpact, removeRole,
  renameRole, roleMode, roleTokens, roles, selectedRole, senseNames, setBrain, setOverflowRef,
  setPermissionSection, startDescEdit, supportsTools, swapping, systemPromptModel, titleRef,
  toggleRoleMode, updateEquipment, validateRename,
} = controller
</script>

<template>
  <section class="roles-workspace">
    <p class="sect-hint">
      <template v-if="roleMode === 'role'">
        普通角色会进入团队、@ 菜单和节点树。点击左侧头像进入详情；技能、插件和 MCP
        支持继承、自选与全部关闭。
      </template>
      <template v-else>
        Shadow 只运行内部临时流程，不创建会话、Pet 或节点树，也不能成为组长、团队成员或 @ 目标。
      </template>
    </p>
    <div
      class="role-mode-stack"
      :class="{ 'is-swapping': swapping }"
      role="group"
      aria-label="角色类别"
    >
      <button
        type="button"
        class="role-kind-card is-ordinary"
        :class="{ 'is-front': roleMode === 'role', 'is-back': roleMode !== 'role' }"
        :aria-pressed="roleMode === 'role'"
        @click="toggleRoleMode"
      >
        普通角色
      </button>
      <button
        type="button"
        class="role-kind-card is-shadow"
        :class="{ 'is-front': roleMode === 'shadow', 'is-back': roleMode !== 'shadow' }"
        :aria-pressed="roleMode === 'shadow'"
        @click="toggleRoleMode"
      >
        影子角色
      </button>
    </div>
    <ResourceWorkbench
      v-model="selectedRole"
      :items="railItems"
      :search-placeholder="roleMode === 'shadow' ? '搜索影子角色' : '搜索普通角色'"
      :glow-rail="true"
    >
      <template #rail-actions>
        <el-popover trigger="click" placement="bottom-start" :width="230">
          <template #reference
            ><button
              type="button"
              class="rail-add"
              :aria-label="roleMode === 'shadow' ? '新增影子角色' : '新增普通角色'"
            >
              <Plus /></button
          ></template>
          <div class="new-role-pop">
            <el-input
              v-model="newRoleType"
              :placeholder="roleMode === 'shadow' ? '新 Shadow 类型名' : '新角色类型名'"
              @keydown.enter="addRole"
            /><button type="button" class="primary-btn" @click="addRole">创建</button>
          </div>
        </el-popover>
      </template>

      <article
        v-if="current"
        class="role-detail-card"
        :class="{ copied: copiedRole === selectedRole }"
      >
        <header class="role-identity">
          <AvatarPicker
            v-model="current.avatar"
            :role-type="selectedRole"
            :disabled="!!current.lock || isFixedRole"
            @error="emit('error', $event)"
          />
          <div class="role-title-zone">
            <EditableTitle
              ref="titleRef"
              class="role-name-edit"
              :model-value="selectedRole"
              :validate="validateRename"
              :disabled="!!current.lock || isFixedRole"
              @rename="(name: string) => renameRole(selectedRole, name)"
              @error="emit('error', $event)"
            >
              <template #actions>
                <button
                  v-if="!current.lock && !isFixedRole"
                  type="button"
                  class="icon-btn"
                  aria-label="复制角色"
                  @click="duplicateRole(selectedRole)"
                >
                  <CopyDocument class="ico" />
                </button>
                <button
                  v-if="current.lock || isFixedRole"
                  type="button"
                  class="icon-btn"
                  disabled
                  :title="
                    isFixedRole
                      ? '固定角色：仅可切换大脑'
                      : '角色已锁定：禁止改名/复制/改专属背景说明/改角色说明'
                  "
                >
                  <Lock class="ico" />
                </button>
                <ConfirmPopover
                  v-else
                  :title="`删除角色「${selectedRole}」？`"
                  :impact="removeImpact"
                  @confirm="removeRole(selectedRole)"
                >
                  <template #trigger>
                    <button type="button" class="icon-btn danger" aria-label="删除角色">
                      <Delete class="ico" />
                    </button>
                  </template>
                </ConfirmPopover>
              </template>
            </EditableTitle>
            <!-- 角色说明：header 内注释样式，点击 inline 编辑（锁定角色只读） -->
            <div class="role-desc-line">
              <span
                v-if="!descEditing"
                class="role-desc-text"
                :class="{ editable: !current.lock && !isFixedRole }"
                :title="current.lock || isFixedRole ? undefined : '点击编辑说明'"
                @click="startDescEdit"
                >{{
                  current.description || (current.lock || isFixedRole ? '—' : '点击添加角色说明')
                }}</span
              >
              <el-input
                v-else
                v-model="descEditValue"
                v-focus
                size="small"
                placeholder="角色说明（仅 UI 展示，不进 prompt）"
                @keydown.enter="commitDescEdit"
                @keydown.esc="cancelDescEdit"
                @blur="commitDescEdit"
              />
            </div>
            <div class="role-status-line">
              <span class="status-chip">系统负重 ≈ {{ roleTokens(current) }} token</span>
            </div>
          </div>
        </header>

        <section class="detail-section">
          <h3>运行核心</h3>
          <div class="core-field">
            <span>AI 大脑</span>
            <div class="choice-board">
              <button
                v-for="name in brainNames"
                :key="name"
                type="button"
                class="brain-choice"
                :disabled="isFixedRole && !supportsTools(name)"
                :class="{ active: current.brain === name }"
                :data-overflow-name="isOverflowing[`brain-name-${name}`] ? 'true' : undefined"
                :data-overflow-model="isOverflowing[`brain-model-${name}`] ? 'true' : undefined"
                @click="setBrain(current, name)"
              >
                <el-tooltip
                  :content="name"
                  placement="top"
                  :show-after="300"
                  :disabled="!isOverflowing[`brain-name-${name}`]"
                >
                  <b
                    :ref="(el) => setOverflowRef(el, `brain-name-${name}`)"
                    class="brain-choice-name"
                    @mouseenter="checkOverflow(`brain-name-${name}`, $event)"
                    >◈ {{ name }}</b
                  >
                </el-tooltip>
                <el-tooltip
                  :content="draft.llm.brain[name]?.model || '未配置模型'"
                  placement="bottom"
                  :show-after="300"
                  :disabled="!isOverflowing[`brain-model-${name}`]"
                >
                  <small
                    :ref="(el) => setOverflowRef(el, `brain-model-${name}`)"
                    class="brain-choice-model"
                    @mouseenter="checkOverflow(`brain-model-${name}`, $event)"
                    >{{ draft.llm.brain[name]?.model || '未配置模型' }}</small
                  >
                </el-tooltip>
              </button>
            </div>
          </div>
          <div class="core-field">
            <span>器官套装</span>
            <div class="choice-board compact">
              <button
                type="button"
                :disabled="isFixedRole"
                :class="{ active: !current.senseGroup }"
                @click="current.senseGroup = ''"
              >
                无</button
              ><button
                v-for="name in senseNames"
                :key="name"
                type="button"
                :disabled="isFixedRole || !supportsTools(current.brain)"
                :class="{ active: current.senseGroup === name }"
                @click="current.senseGroup = name"
              >
                {{ name }}
              </button>
            </div>
          </div>
          <div class="core-field">
            <span>专属背景说明</span>
            <el-cascader
              v-model="systemPromptModel"
              :options="promptOptions"
              :props="{ emitPath: false }"
              placeholder="无专属背景(仅全局)"
              filterable
              clearable
              :disabled="!!current.lock || isFixedRole"
              popper-class="role-prompt-cascader"
              class="prompt-cascader"
            />
          </div>
        </section>

        <section class="detail-section permission-section">
          <h3>行为权限</h3>
          <p class="permission-hint">器官套装决定角色能看到哪些工具；这里决定每次调用时直接放行、弹审批卡还是拒绝。修改从下一次调用生效。</p>
          <div class="perm-board-head">
            <LabelTip
              label="策略模板"
              :tip="'预设的安全基线，四档风险递增。\n下方覆盖项在模板基础上逐项调整，留空即继承模板值；切换模板会保留已设置的覆盖项。更细粒度的规则（按工具通配、命令风险分类）可手改 config.yaml。'"
            />
          </div>
          <div class="permission-template-board">
            <button
              v-for="card in TEMPLATE_CARDS"
              :key="card.value"
              type="button"
              class="tpl-card"
              :class="[`risk-${card.risk}`, { active: permissionTemplate === card.value }]"
              @click="permissionTemplate = card.value"
            >
              <b class="tpl-name"
                ><i class="risk-dot" />{{ card.label }}<em v-if="card.isDefault" class="tpl-default">默认</em></b
              >
              <small class="tpl-tagline">{{ card.tagline }}</small>
              <small class="tpl-summary">{{ card.summary }}</small>
            </button>
          </div>
          <div class="permission-groups">
            <div class="perm-group">
              <h4>文件</h4>
              <label class="perm-field" :class="{ customized: effectivePermission.customized.read }">
                <span class="perm-field-head">
                  <LabelTip
                    label="读取范围"
                    :tip="'角色读文件可触达的路径。\n工作区 = 会话工作区目录内；越出范围的读取直接拒绝。'"
                  />
                  <em v-if="effectivePermission.customized.read">已自定义</em>
                </span>
                <el-select :model-value="current.permissions?.filesystem?.read" placeholder="继承模板" clearable size="small" @update:model-value="(v: string | undefined) => setPermissionSection('filesystem', 'read', v)">
                  <el-option label="禁止" value="deny" /><el-option label="仅工作区" value="workspace" /><el-option label="任意路径" value="any" />
                </el-select>
              </label>
              <label class="perm-field" :class="{ customized: effectivePermission.customized.write }">
                <span class="perm-field-head">
                  <LabelTip
                    label="写入范围"
                    :tip="'角色写文件的范围。\n仅工作区内：区外一律拒绝；区内直写 · 区外需审核：工作区内直接写入，工作区外先弹审批卡确认。'"
                  />
                  <em v-if="effectivePermission.customized.write">已自定义</em>
                </span>
                <el-select :model-value="current.permissions?.filesystem?.write" placeholder="继承模板" clearable size="small" @update:model-value="(v: string | undefined) => setPermissionSection('filesystem', 'write', v)">
                  <el-option label="禁止" value="deny" /><el-option label="仅工作区内" value="workspace" /><el-option label="区内直写 · 区外需审核" value="any-with-approval" />
                </el-select>
              </label>
            </div>
            <div class="perm-group">
              <h4>命令</h4>
              <label class="perm-field" :class="{ customized: effectivePermission.customized.maxSandboxMode }">
                <span class="perm-field-head">
                  <LabelTip
                    label="最大沙箱权限"
                    :tip="'execute_command 的 OS 沙箱权限上限。\n命令分析器判定需要更高权限的命令会被直接拒绝而非降级执行；完全访问也仍运行在 OS 沙箱内。'"
                  />
                  <em v-if="effectivePermission.customized.maxSandboxMode">已自定义</em>
                </span>
                <el-select :model-value="current.permissions?.commands?.maxSandboxMode" placeholder="继承模板" clearable size="small" @update:model-value="(v: string | undefined) => setPermissionSection('commands', 'maxSandboxMode', v)">
                  <el-option label="只读沙箱" value="read-only" /><el-option label="工作区可写" value="workspace-write" /><el-option label="完全访问（仍经 OS 沙箱）" value="danger-full-access" />
                </el-select>
              </label>
              <div class="perm-field" :class="{ customized: effectivePermission.customized.shells }">
                <span class="perm-field-head">
                  <LabelTip
                    label="允许脚本方言"
                    :tip="'角色执行命令可用的 shell 方言。\n未勾选的方言调用会被直接拒绝。'"
                  />
                  <em v-if="effectivePermission.customized.shells">已自定义</em>
                </span>
                <el-checkbox-group v-model="allowedShells"><el-checkbox value="bash">Bash</el-checkbox><el-checkbox value="powershell">PowerShell</el-checkbox></el-checkbox-group>
              </div>
            </div>
            <div class="perm-group">
              <h4>集成</h4>
              <label class="perm-field" :class="{ customized: effectivePermission.customized.mcpDefault }">
                <span class="perm-field-head">
                  <LabelTip
                    label="MCP 默认"
                    :tip="'调用 MCP 工具的默认处置。\n继承 = 按模板与未知工具监管处理：受信模板放行，其余模板每次审核。'"
                  />
                  <em v-if="effectivePermission.customized.mcpDefault">已自定义</em>
                </span>
                <el-select :model-value="current.permissions?.mcp?.default" placeholder="继承模板" clearable size="small" @update:model-value="(v: string | undefined) => setPermissionSection('mcp', 'default', v)">
                  <el-option label="继承（按模板监管）" value="inherit" /><el-option label="允许" value="allow" /><el-option label="每次审核" value="ask" /><el-option label="拒绝" value="deny" />
                </el-select>
              </label>
              <label class="perm-field" :class="{ customized: effectivePermission.customized.spawnEffect }">
                <span class="perm-field-head">
                  <LabelTip
                    label="派遣角色"
                    :tip="'spawn_role 派遣子角色的处置。\n继承 = 按模板默认（只读模板拒绝，其余允许）。'"
                  />
                  <em v-if="effectivePermission.customized.spawnEffect">已自定义</em>
                </span>
                <el-select :model-value="current.permissions?.spawn?.effect" placeholder="继承模板" clearable size="small" @update:model-value="(v: string | undefined) => setPermissionSection('spawn', 'effect', v)">
                  <el-option label="继承（按模板）" value="inherit" /><el-option label="允许" value="allow" /><el-option label="每次审核" value="ask" /><el-option label="拒绝" value="deny" />
                </el-select>
              </label>
            </div>
          </div>
          <div class="effective-preview">
            <span class="preview-k">生效策略</span>
            <span
              v-for="dim in permissionPreview"
              :key="dim.key"
              class="preview-dim"
              :class="{ customized: dim.customized }"
              >{{ dim.label }} {{ dim.value }}<em v-if="dim.customized">自定义</em></span
            >
          </div>
        </section>

        <section class="detail-section">
          <h3>装备栏</h3>
          <div class="equipment-grid">
            <EquipmentPicker
              v-model="current.skills"
              label="技能"
              :options="skillCatalog.skills"
              :token-map="skillCatalog.skillTokens"
              :disabled="isFixedRole"
              @edit="openEquipment('skills')"
              @mode-change="closeEquipment"
            />
            <EquipmentPicker
              v-model="current.plugins"
              label="插件"
              :options="skillCatalog.plugins"
              :token-map="skillCatalog.pluginTokens"
              :disabled="isFixedRole"
              @edit="openEquipment('plugins')"
              @mode-change="closeEquipment"
            />
            <EquipmentPicker
              v-model="current.mcpServers"
              label="MCP 服务"
              :options="mcpNames"
              :token-map="mcpTokens"
              :disabled="isFixedRole"
              @edit="openEquipment('mcpServers')"
              @mode-change="closeEquipment"
            />
          </div>
          <EquipmentEditor
            v-if="equipmentEditor"
            :editor-key="`${selectedRole}:${equipmentEditor.key}`"
            :label="equipmentEditor.label"
            :model-value="equipmentEditor.value"
            :options="equipmentEditor.options"
            :token-map="equipmentEditor.tokenMap"
            @update:model-value="updateEquipment"
            @close="closeEquipment"
          />
          <div class="equipment-roster" :class="{ 'equipment-editing': !!activeEquipment }">
            <div class="roster-row">
              <span class="roster-k">技能</span>
              <span v-if="!current.skills" class="roster-empty">继承全部</span>
              <span v-else-if="!current.skills.length" class="roster-empty">已关闭</span>
              <span v-for="name in current.skills" :key="`sk-${name}`" class="roster-tag"
                >{{ name
                }}<small v-if="skillCatalog.skillTokens[name]">
                  ≈{{ skillCatalog.skillTokens[name] }}</small
                ></span
              >
            </div>
            <div class="roster-row">
              <span class="roster-k">插件</span>
              <span v-if="!current.plugins" class="roster-empty">继承全部</span>
              <span v-else-if="!current.plugins.length" class="roster-empty">已关闭</span>
              <span v-for="name in current.plugins" :key="`pl-${name}`" class="roster-tag"
                >{{ name
                }}<small v-if="skillCatalog.pluginTokens[name]">
                  ≈{{ skillCatalog.pluginTokens[name] }}</small
                ></span
              >
            </div>
            <div class="roster-row">
              <span class="roster-k">MCP</span>
              <span v-if="!current.mcpServers" class="roster-empty">继承全部</span>
              <span v-else-if="!current.mcpServers.length" class="roster-empty">已关闭</span>
              <span v-for="name in current.mcpServers" :key="`mc-${name}`" class="roster-tag"
                >{{ name }}<small v-if="mcpTokens[name]"> ≈{{ mcpTokens[name] }}</small></span
              >
            </div>
          </div>
        </section>
      </article>
    </ResourceWorkbench>
  </section>
</template>

<style scoped lang="less" src="./RolesTab.styles.less"></style>

<style lang="less">
// cascader 下拉面板 teleport 到 body，scoped 够不着；用 popper-class 注入粉色覆盖默认主题黄
.role-prompt-cascader {
  --el-color-primary: #fb7185;
}
</style>
