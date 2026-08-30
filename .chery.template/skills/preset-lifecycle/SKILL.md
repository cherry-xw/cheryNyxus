---
name: preset-lifecycle
description: 安全创建或删除完整预设、角色编制及其零引用配置/提示词/技能/规则资产，并处理历史会话纪元与退役子树。
trigger: 用户要求创建、重建、删除预设，或连带清理角色、大脑、感官组、MCP、系统提示词、技能、规则等资源时。
---

# Preset Lifecycle

本技能只用于 Cherry Nexus 的预设全生命周期操作。执行时必须使用 `config_manage`，不得用命令或通用文件工具改 `.chery`。

## 删除

1. `config_manage(get)`，记录 `baseRevision`，并以 `preset.id`/`role.id` 确认目标。
2. 建立引用集合：其余 presets 的 roles/leader/detailRole/shadows；其余 roles 的 brain/senseGroup/mcpServers/systemPrompt/skills/plugins；preset 的 rule。角色未配置 `skills` 或 `plugins` 表示该维度全部可用，不能把对应资产误判为零引用。
3. 构造 `removePreset/removeRole/removeBrain/removeSenseGroup` 增量操作；删除角色/预设时携带 `expectedId`。仅删除零剩余引用的普通资源，固定 cheryNyxus 资源不可删。
4. `config_manage(patch)` 携带步骤 1 的 `baseRevision` 与操作数组。失败即停止；revision 过期必须重新 get 和核对，不能直接重试旧操作。
5. 对零引用的 prompt/skill/rule 调 `config_manage(asset_archive)`；被引用检查拒绝的资产必须保留。
6. 回读并报告：新修订、废弃/退役子树、归档路径、因共享引用而保留的资源。

## 创建

1. 同名重建仍生成从未用过的新 preset/role ID。
2. 用 `asset_save` 创建角色系统提示词和必要背景资产。
3. 用同一次 `patch` 中的资源级 `put` 操作闭合 roles、leader、brain、senseGroup、skills、rule 引用。
4. `get` 回读核对；新角色只能由主 Agent 后续 `spawn_role` 产生新子会话。

## 历史会话

- 配置激活后，由系统建立新纪元并迁移历史会话；不得手工改写会话或节点树。
- 未结束的退役角色子树会标记为 `abandoned`，已完成子树会标记为只读 `retired`。
- 不得唤醒、恢复或把新角色绑定到旧子树；旧结果只能作为历史事实读取。

## 授权与失败

用户明确给出目标和范围的创建/删除指令即为本次操作授权，不重复确认。目标歧义、共享资源是否连带删除不明确、或需要扩大范围时才询问。任何校验失败都不得继续后续删除，也不得宣称完成。
