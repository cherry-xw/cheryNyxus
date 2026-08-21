---
name: install-skill
description: 当用户请求安装/导入技能、skill 包、商店、插件市场时，引导派出 Cherry Nexus 完成安装。
trigger: "用户请求安装技能、导入 skill 包、从商店/URL 安装、添加新技能时"
---

# 安装技能

当用户表达安装技能的意图（例如「根据 `<url>` 安装技能」「装一下这个 skill 包」「从技能商店安装 X」）时：

1. **不要自己尝试下载或写文件**——你没有安装感官，且 `.chery/` 路径守卫会拦截直接写。
2. 用 `spawn_role` 感官派出 Cherry Nexus（配置管理核心角色）：
   - `type`: `cheryNyxus`
   - `prompt`: 转述用户的安装需求（含 URL / 技能名 / 来源说明）
   - `wait`: `true`（等 Cherry Nexus 装完回报）
3. 等 Cherry Nexus 回报结果后，向用户转述（装了哪些技能 / 是否成功 / 有无错误）。

## 识别安装意图

- 明确的 URL（`https://...` / `git@...`）+「安装/装/导入」→ 触发
- 「技能商店」「skill market」「安装技能」「添加技能」→ 触发
- 用户只是问技能怎么用（不涉及安装）→ 不触发，正常回答

## 注意

- Cherry Nexus 会自己处理下载、候选确认（`ask_user_question`）、落盘。你只需派出并转述结果。
- 安装是 `smart` 监管（用户审批）+ 候选逐项确认，不会静默安装。
