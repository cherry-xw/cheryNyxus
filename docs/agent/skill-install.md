# AI 安装技能（install_skill 感官 + Cherry Nexus 角色 + 路径守卫）

> 源码 [src/agent/sense/installSkill.ts](../../src/agent/sense/installSkill.ts) ｜ [src/utils/pathGuard.ts](../../src/utils/pathGuard.ts) ｜ [src/agent/middleware/tool.ts](../../src/agent/middleware/tool.ts) ｜ 上级 [agent](./README.md) ｜ 相关 [./plugin.md](./plugin.md)（人工导入对照）、[./prompt.md](./prompt.md)（默认 Skill）、[./config-manage.md](./config-manage.md)（配置管理感官）、[../core/sense.md](../core/sense.md)（感官注册）、[./middleware.md](./middleware.md)（守卫在 tool middleware）

## 职责

让 AI 自行安装技能——用户对主 agent 说「根据 `<url>` 安装技能」，主 agent 通过默认 Skill 引导 `spawn_role` 派出 **Cherry Nexus**（cheryNyxus，配置管理核心角色），Cherry Nexus 调用 `install_skill` 感官完成 fetch → `/tmp` 暂存 → 候选确认 → 落盘 `.chery/skills/`。

与 [plugin.md](./plugin.md) 的人工 settings 导入对比：

| 维度 | 人工导入（skills.importUrl / plugins.*） | AI 安装（install_skill） |
|------|------------------------------------------|--------------------------|
| 触发 | 前端 settings UI 人工操作 | 主 agent 自然语言 → spawn Cherry Nexus |
| 执行者 | RPC handler（前端驱动） | install_skill 感官（Cherry Nexus 角色专用） |
| 来源 | GitHub URL（分支选择 + 鉴权，git 强依赖） | 三态：zip 直链 / git / manifest |
| 隔离 | staging `/tmp` | staging `/tmp`（外部内容物理隔离） |
| 路径保护 | 无 | `.chery/` 路径守卫（仅 install_skill 可写） |
| 来源记录 | 中央索引 `.chery/.skill-sources.json`（支持 re-sync） | per-skill `.chery-source.json`（仅追溯，无 re-sync） |

## 架构（三组件）

```
① 默认 Skill（install-skill）          ← 主 agent 注入，识别安装意图
   └─ 引导 spawn_role({type:"cheryNyxus", wait:true})

② Cherry Nexus 角色（cheryNyxus）      ← 配置管理核心角色，senseGroup 隔离
   └─ senseGroup: chery_nexus = [..., install_skill, config_manage]
       其他角色 senseGroup 不含 install_skill → 调不到（双重隔离第一层）

③ install_skill 感官 + 路径守卫          ← 执行引擎 + .chery/ 保护
   ├─ stage：fetch → 三态分发 → /tmp 解压 → 候选
   ├─ commit：ask_user 确认后 cpSync → .chery/skills/ + manifest
   └─ 守卫豁免：仅 install_skill 可写 .chery/（双重隔离第二层）
```

**双重隔离自洽**：install_skill 只在 Cherry Nexus senseGroup（配置层）→ 其他角色 senseTable 看不到调不到；路径守卫 `GUARD_EXEMPT` 只认 install_skill → 其他角色即使绕路用 write_file/bash 写 `.chery/` 也被拦。无需 RuntimeSelection 带 role type。

## install_skill 感官（[installSkill.ts](../../src/agent/sense/installSkill.ts)，smart 监管）

### schema（union 两阶段）

```ts
z.union([
  z.object({
    phase: z.literal("stage"),
    url: z.string().describe("技能来源 URL：zip 直链 / git 仓库 / manifest"),
    branch: z.string().optional().describe("git 来源分支，缺省用默认分支"),
  }),
  z.object({
    phase: z.literal("commit"),
    stagingId: z.string().describe("stage 返回的 stagingId"),
    selections: z.array(z.object({ name: z.string(), import: z.boolean() })),
  }),
])
```

### stage（fetch → 三态分发 → /tmp 暂存 → 候选）

```
fetch(url)
  ├─ git URL（parseGithubUrl 命中 + http/git@/ssh 协议）
  │    └─ ensureGitAvailable → cloneRepo(gitUrl, /tmp/<uuid>/_raw, {branch})
  │         私有仓 needsAuth → 返错误，Cherry Nexus ask_user 取凭据后重试
  ├─ zip（fetch 后魔数 PK 0x50 0x4B）
  │    └─ extractZipBuffer(buf, /tmp/<uuid>/_raw)        ← 复用 importShared
  └─ manifest / 单文件（fetch 后非 zip）
       ├─ frontmatter 含 source 字段 → manifest：解析 type/source/branch → 递归 stage（深度 1）
       └─ 否则当单文件 SKILL.md → 直接落 /tmp/<uuid>/_raw/SKILL.md
→ analyzeSkillStaging(stagingId, rawDir, sourceUrl)      ← 复用 import.ts（export 扩展）
   ├─ findSkillFolders + peekSkillMeta + sanitizeName + skillDirExists（conflict）
   └─ 写 staging manifest（{kind:"skill", sourceUrl, items:[{name,rawFolder,description,trigger,conflict}]}）
→ 返 {stagingId, candidates:[{name,description,trigger,conflict}], sourceUrl}
```

**三态确定性（规则 5）**：按 URL 形状 + 内容魔数机器识别，**不让 LLM 读 md 自由发挥**。manifest 的 YAML frontmatter 须含 `source` 字段才触发递归，否则当普通 SKILL.md。

### commit（cpSync 落盘 + 规范化 + 清 /tmp）

```
读 staging manifest → 按 selections 逐项：
  import=false → skip
  import=true  → cpSync(rawFolder, .chery/skills/<name>/, {recursive,force})
                 → normalizeSkillFileName（skill.md → SKILL.md）
                 → 落 .chery/skills/<name>/.chery-source.json（{sourceUrl, installedAt} 追溯）
→ removeStaging(stagingId)（清 /tmp）
→ 返 {imported:[...], skipped:[...]}
```

**复用 importShared 全套安全基建**：`extractZipBuffer`（zip bomb 阈值 100MB/5000 条 + 路径穿越防护）、`sanitizeName`、`createStaging`/`removeStaging`、`findSkillFolders`、`peekSkillMeta`、`normalizeSkillFileName`。感官直接 import service 层（[middleware.md](./middleware.md) 4 先例，无层级障碍）。

### 两阶段 + ask_user 适配

Cherry Nexus stage 后调 `ask_user_question`（逐项选装 / conflict 确认）→ `ctx.yieldTurn()` 释放 turn → 用户答题（service `resolveQuestionBatch` 回灌）→ Cherry Nexus 据答案调 commit。仿 [ask.ts](../../src/agent/sense/ask.ts) / spawn.ts wait=true 的 yield-turn 模式（详见 [middleware.md 问答流程 C](./middleware.md)）。

## 路径守卫（[pathGuard.ts](../../src/utils/pathGuard.ts) + [tool.ts](../../src/agent/middleware/tool.ts)）

### 动机

通用感官 `write_file`/`read_file`/`execute_command` 无路径范围校验（[探索结论](./middleware.md)），能任意读写 `.chery/`。需隔离：仅 Cherry Nexus 通过 install_skill 可改 `.chery/` 技能目录，其他角色禁操作。

### 机制（tool middleware 前置拦截，不侵入各工具 handler）

```ts
// pathGuard.ts
export const GUARD_EXEMPT = new Set(["install_skill"]);   // 仅 install_skill 可写 .chery/

export function isCheryPath(target: string): boolean {
  // 匹配 .chery 作为路径段：(^|[\/\\])\.chery([\/\\]|$)
  // 覆盖 .chery/x、./.chery/x、/abs/.chery、x/.chery；不误伤 my.chery.txt
  // 绝对路径额外 resolve 判定是否落 cheryRoot/.chery 下
}

export function extractSensePaths(name, args): string[] {
  // write_file/read_file/search_codebase → args.path；execute_command → args.command
}

export function checkCheryGuard(name, args): string | null {
  // GUARD_EXEMPT 命中 → null（放行）；否则提取路径，任一命中 isCheryPath → 返拦截文案
}
```

```ts
// tool.ts doExecuteSense（L269 execute 前）
const guardHit = checkCheryGuard(name, args);
if (guardHit) return { content: guardHit, replaced };   // 不执行 handler
const result = await senseEntry.execute(args, ...);
```

**拦截文案**：`".chery/ 是系统配置目录（技能/插件/提示词/命令/数据库），不能直接读写。配置管理请交给 Cherry Nexus（config_manage 感官），安装或修改技能请用 spawn_role 派出「Cherry Nexus」角色完成。"`

### 前置 vs 后置（与 .env 脱敏的区别）

- `.env` 现状 = **后置输出脱敏**（[envGuard.ts redactEnvKeys](../../src/utils/envGuard.ts) + [tool.ts doExecuteSense](../../src/agent/middleware/tool.ts) L474，感官执行后遮蔽 `.env` 敏感 key 的值——key 名保留、值 → `[REDACTED]`）。
- 本守卫 = **前置拦截**（感官执行前直接拒，不执行 handler）。
- 参考的是 envGuard 的「统一拦截层位置 + 注入说明」模式，**语义不同**（拦 vs 脱敏）。

### 可扩展

守卫按 `.chery` 路径段匹配，天然覆盖 `.chery/` 下所有子目录（skills/plugins/prompt/command/db/memory/secrets）。未来「修改提示词」「改命令」等设置类操作同理命中，均需走专用感官 + 专用角色（如 `config_manage`）。

## Cherry Nexus 角色（纯配置 + persona）

`.chery.template/config.yaml`：
```yaml
sense_groups:
  leader:              # 纯组长组（coordinator 等）：不配配置管理感官，配置需交 Cherry Nexus
    - read_file
    - skill
    - write_file
    - execute_command
    - search_codebase
    - spawn_role
    - ask_user_question
    - history_recall
  chery_nexus:         # Cherry Nexus 专属组：组长能力 + 配置管理（install_skill/config_manage 独占）
    - read_file
    - skill
    - write_file
    - execute_command
    - search_codebase
    - spawn_role
    - ask_user_question
    - history_recall
    - install_skill             # 技能安装（Cherry Nexus 职责）
    - config_manage             # 配置管理（Cherry Nexus 独占）
roles:
  cheryNyxus:
    brain: my-brain
    senseGroup: chery_nexus
    mcpServers: []
    systemPrompt: prompt/cheryNyxus/cheryNyxus.md
    lock: true                  # 锁定禁止前端删除/改名（保护配置管理能力）
presets:
  cheryNyxus:
    roles: [cheryNyxus, roleArchitect, curator, explanation]   # 加入固定预设，主 agent 可 spawn
```

persona [`.chery.template/prompt/cheryNyxus/cheryNyxus.md`](../../.chery.template/prompt/cheryNyxus/cheryNyxus.md)：双职责——**配置管理核心**（`config_manage` 感官 get/patch/rollback + 强类型候选与备份回滚，详见 [./config-manage.md](./config-manage.md)）+ **技能安装**（install_skill stage → ask_user 逐项确认 → commit → 回报）。所有 `.chery/` 写操作集中在 Cherry Nexus，结构化感官（config_manage / install_skill）天然不触发路径守卫。

**编制锁定**：Cherry Nexus 加入预设 `roles` 后，主 agent（leader）可 `spawn_role({type:"cheryNyxus", wait:true})` 派出（roster gate 自动生效，详见 [agent-pet.md](./agent-pet.md)）。

## 默认 Skill（[`.chery.template/skills/install-skill/SKILL.md`](../../.chery.template/skills/install-skill/SKILL.md)）

frontmatter `name/description/trigger`（trigger = 「用户请求安装/导入技能、skill 包、商店时」）。正文：识别安装意图 → `spawn_role({type:"cheryNyxus", prompt:<需求>, wait:true})` → 等 Cherry Nexus 回报。主 agent 不直接装（无 install_skill 感官，被 senseGroup 隔离）。

## staging 改 /tmp

[importShared.ts stagingRoot()](../../src/service/skill/importShared.ts) 由 `cheryDir/.chery/.staging` → `os.tmpdir()/chery-staging`。所有导入路径（RPC `skills.importUrl`/`plugins.*` + install_skill 感官）统一 `/tmp`。commit 用 `cpSync`（[import.ts:137](../../src/service/skill/import.ts)、[plugin/import.ts:191](../../src/service/plugin/import.ts)）跨 fs 安全，无 EXDV 问题。

## 文件清单

| 文件 | 职责 |
|------|------|
| [src/utils/pathGuard.ts](../../src/utils/pathGuard.ts) | `isCheryPath`/`extractSensePaths`/`GUARD_EXEMPT`/`checkCheryGuard` + 拦截文案 |
| [src/agent/middleware/tool.ts](../../src/agent/middleware/tool.ts) | `doExecuteSense` execute 前调 `checkCheryGuard`（前置拦截） |
| [src/agent/sense/installSkill.ts](../../src/agent/sense/installSkill.ts) | `install_skill` 感官（stage/commit 两阶段 + 三态分发） |
| [src/agent/sense/index.ts](../../src/agent/sense/index.ts) | import + `registerBuiltinSenses` + `BUILTIN_SENSE_TOOLS` |
| [src/service/skill/importShared.ts](../../src/service/skill/importShared.ts) | `stagingRoot()` → `/tmp` |
| [src/service/skill/import.ts](../../src/service/skill/import.ts) | export `analyzeSkillStaging` + 加 `sourceUrl` 参数（感官复用） |
| [.chery.template/skills/install-skill/SKILL.md](../../.chery.template/skills/install-skill/SKILL.md) | 默认 Skill 提示词 |
| [.chery.template/prompt/cheryNyxus/cheryNyxus.md](../../.chery.template/prompt/cheryNyxus/cheryNyxus.md) | Cherry Nexus persona（配置管理 + 技能安装） |
| [.chery.template/config.yaml](../../.chery.template/config.yaml) | sense_groups.chery_nexus（含 install_skill/config_manage）+ roles.cheryNyxus + presets |

## 依赖与关联

| 依赖 | 用途 |
|------|------|
| [service/skill/importShared](../../src/service/skill/importShared.ts) | staging/extract/sanitize/find/peek/normalize 全套原语 |
| [service/skill/gitClone](../../src/service/skill/gitClone.ts) | `cloneRepo`/`ensureGitAvailable`（git 来源） |
| [service/skill/import](../../src/service/skill/import.ts) | `analyzeSkillStaging`（export 复用） |
| [utils/config](../../src/utils/config.ts) | `skills_dir`（commit 落盘目标） |
| Node ≥20 原生 `fetch` | 下载 zip / manifest |

## 扩展点

### 支持新来源类型

在 `installSkill.ts` stage 的三态分发加分支（如 `tar.gz`：fetch 后嗅探 gzip 魔数 → 解 tar）。守卫与 staging 无需改。

### 扩展守卫到其他设置操作

未来「修改 prompt」「改 command」等：新增专用感官（如 `config_manage` 已覆盖配置域）+ 加入 Cherry Nexus senseGroup + 加入 `GUARD_EXEMPT`。守卫按 `.chery` 路径段已覆盖这些目录，无需改正则。
