# 插件系统（Plugins）

> 源码 [src/service/plugin/](../../src/service/plugin/) ｜ [src/service/skill/gitClone.ts](../../src/service/skill/gitClone.ts) ｜ [src/service/skill/importShared.ts](../../src/service/skill/importShared.ts) ｜ [src/utils/secretStore.ts](../../src/utils/secretStore.ts) ｜ [src/agent/prompt/loadSkill.ts](../../src/agent/prompt/loadSkill.ts)

## 职责

插件 = **superpowers 风格的整仓关联技能包**：从一个 GitHub 仓库 `git clone` 全仓到 `.chery/plugins/<name>/`，附 `.chery-plugin.json` manifest 记录来源、版本与检查更新状态。loader 实时扫描 `plugins_dir`，每个 skill 以 `<plugin>__<skill>` 命名空间注入（与独立 skill 共用 [loadSkill.discoverSkillRoots](../../src/agent/prompt/loadSkill.ts)，区别仅在 `plugin` 字段）。

> **manifest 即真相**：检查更新结果（`lastCheckedAt` / `latestSha` / `latestDate` / `updateAvailable`）直接写入各插件 `.chery-plugin.json`，不进数据库。删除插件文件夹即连同状态一并消失，手工编辑 manifest 即时生效，无 DB 与文件不同步风险。

与独立 skill（[skills.importUrl](../protocol.md)）对比：

| 维度 | 独立 skill | 插件 |
|------|-----------|------|
| 来源 | GitHub 仓库内**多个** SKILL.md 候选，逐项选择 | GitHub 仓库**整仓**关联安装 |
| 目录 | `skills_dir/<name>/` | `plugins_dir/<name>/` + `.chery-plugin.json` manifest |
| 命名 | 原 skill 名 | `<plugin>__<skill>` 命名空间 |
| 分支选择 | 是（preImport 拉分支列表让用户选） | 是（preImport 拉分支列表让用户选） |
| 鉴权 | 是（凭据池，同插件） | 是（凭据池 + 加密存储，详见 [../utils/secretStore.md](../utils/secretStore.md)） |
| 来源追踪 | 中央索引 `.chery/.skill-sources.json`（按 {cloneUrl,branch} 分组，skill 文件夹不携源） | per-folder manifest（`.chery-plugin.json`） |
| 同步/更新 | 手动 re-sync（重 clone + 重弹候选） | checkUpdate + 拉取最新（commit SHA 徽标） |
| 版本检查 | 否 | 是（commit SHA + 日期 pill） |

> **关键约束**：`/tree/<branch>/<subpath>` 中的 **subpath 被忽略**（整仓安装，仅取 branch）。这是与 skills 单文件挑选的本质差异——插件是「整仓关联包」语义。

## 前置条件（硬性）

系统须装 `git` CLI。`gitClone.ts` 在每个 RPC 入口前做 `git --version` 预检：

- 缺失 → 返回 `gitNotInstalled: true` 信号（**不兜底、不降级、不静默回退 zipball**）。
- 前端据该信号**禁用插件导入入口**（导入栏灰显）+ 顶部显式提示「Git 导入需系统安装 git CLI」。
- 技能 `skills.importUrl`（共享 gitClone）同理不可用；其余 tab / RPC 不受影响。
- Electron 终端用户机无 git 时，作为**硬性前提**处理，不做自动安装或静默降级。

## URL 解析

支持三种输入，统一规范化为 https clone URL：

| 输入格式 | 解析 | 规范化结果 |
|---------|------|-----------|
| `https://github.com/<owner>/<repo>[.git][/tree/<branch>[/<subpath>]]` | `new URL()` 解析（自动剥 query/fragment） | `https://github.com/<owner>/<repo>.git` |
| `git@github.com:<owner>/<repo>.git` | 手动正则解 SSH 形式 | `https://github.com/<owner>/<repo>.git` |
| `ssh://git@github.com/<owner>/<repo>.git` | 手动正则解 SSH 形式 | `https://github.com/<owner>/<repo>.git` |

pathname 正则（贪婪锚定，修原惰性量词截断 bug）：

```
^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+))?)?\/?$
        │        │                │       │
        owner    repo             branch   subpath (忽略)
```

- 输入 `https://github.com/obra/superpowers/tree/main/hooks` → branch=`main`、subpath=`hooks` **被丢弃**，整仓安装 branch=main。
- 输入 `git@github.com:obra/superpowers.git` → 转 https clone，branch 取远端默认分支。
- subpath 跨段（如 `/tree/main/hooks/abc`）整体丢弃，不参与目录映射。

> SSH 形式即使输入也**转 https**，统一走 basic auth（凭据池只持有 https 用户名/密令，不解析 SSH key）。

## 两阶段 + 导入流程（三步）

```
① plugins.preImportUrl(url[, credentialId?])
     ├─ gitClone 预检 git --version（缺失→gitNotInstalled）
     ├─ listRemoteBranches(url, auth?)   // git ls-remote --heads + --symref HEAD
     ├─ suggestedName = sanitizeName(repo)，nameConflict = pluginDirExists(suggestedName)
     └─ 返 {branches, defaultBranch, needsAuth, suggestedName, nameConflict}
          │
          ├─ needsAuth=true → 前端弹 cred-row（用户名/密码 + 记住 checkbox）
          ├─ nameConflict=true → 前端弹「文件夹名」输入框（默认 suggestedName，可改）
          └─ 用户选 branch（默认分支标「(默认)」）

② plugins.importUrl({url, branch, credentialId? | username,password,remember,label?, pluginName?})
     ├─ pluginName：省略→sanitizeName(repo)；提供→再次 sanitize（nameConflict 时前端改名）
     ├─ cloneRepo(url, dest, {branch, auth})   // git clone --depth 1 --branch B
     │    ├─ 鉴权失败（exit 128 + stderr 匹配）→ 返 needsAuth=true（不抛错）
     │    ├─ 成功 → 抓 commitSha/commitDate（git log -1，rm .git 前取样）
     │    └─ rm -rf <dest>/.git
     ├─ 写 staging manifest（含 cloneUrl/branch/commitSha/commitDate）
     └─ 返 {stagingId, pluginName, existing, sourceUrl, branch, commitSha, commitDate,
           savedCredentialId?, skills:[{name,description,trigger?}]}
          │
          └─ existing=true → 前端确认覆盖/取消（含 pluginName 仍冲突时）

③ plugins.commit({stagingId, overwrite})
     ├─ installPlugin：staging → plugins_dir/<name>/（overwrite=true 覆盖同名）
     ├─ 写 .chery-plugin.json manifest（cloneUrl/branch/commitSha/commitDate/installedAt
     │    + lastCheckedAt=now/latestSha=commitSha/updateAvailable=false，刚装视为已检查最新）
     └─ 返 {plugin: PluginInfo}
```

- **单按钮拉取流程**：URL 输入后只有一个「确认」按钮（调 preImport 拉分支）；拿到分支后才显示分支列表 + 「导入」按钮。「文件夹名」输入框仅在 `nameConflict=true` 时出现，避免默认名冲突时静默覆盖。
- **去重只看文件夹冲突**：不检查 URL（不同分支/不同远端可能是完全不同的库）；仅 `pluginDirExists(suggestedName)` 判定目标目录是否冲突，冲突则提供改名输入框（传 `pluginName` 覆盖）。

- **三步分离的理由**：preImport 仅拉分支（轻、可重试、决定鉴权需求）；importUrl 才真正 clone 到 staging（重、需网络/鉴权）；commit 是纯本地落盘（用户预览后决定）。避免把分支拉取与整仓下载捆在一次 RPC。
- **staging 预览**：clone 完成后 staging 目录可被 `plugins.list`/扫描器读取，让用户在 commit 前看到 pluginName、skills、existing 冲突。
- **互斥鉴权入参**：`credentialId`（从凭据池复用）与 inline `{username, password, remember, label}`（本次新建）二者**只能选一**，schema `.refine` 强制。

## 鉴权与凭据池

私有仓 git 鉴权失败时（`exit 128` + stderr 匹配 `Authentication failed|could not read Username|terminal prompts disabled|Permission denied`），preImport/importUrl 不抛错，而是返 `needsAuth: true` 让前端弹凭据输入。

**鉴权注入方式**：

| 路径 | 安全性 | 选择 |
|------|--------|------|
| URL 嵌 token（`https://user:token@host/repo`） | ❌ argv 经 `ps auxe` 可见 | 不用 |
| `http.extraheader=Authorization: Basic <b64>` 经 env `GIT_CONFIG_PARAMETERS` | ✅ 仅 env 可见 | **采用** |

- 配 `GIT_TERMINAL_PROMPT=0` 防交互挂起。
- stderr **不原文回显**前端（可能含 URL/token），仅返回分类后友好文案（`Authentication failed` / `Permission denied`）。
- 日志层字段名匹配 `/(key|token|secret|password|authorization|credential|env)/i` 自动 `[REDACTED]`（[utils/logger](./logger.md)），凭据字段命名为 `password` / `token` 以复用脱敏。

**凭据池**：

- 凭据池 RPC（`credentials.list/save/delete`，详见 [../protocol.md](../protocol.md)）独立于插件，可被 skills/未来 commands 复用。
- 勾选「记住（加密存储）」→ inline `{username, password, label?}` 经 `credentials.save` 写入加密文件，返 `savedCredentialId`；importUrl response 一并回前端，下次同 host 直接复用。
- 不勾 → 仅本次注入 env，不落盘，日志 REDACTED。
- 加密方案与威胁模型见 [../utils/secretStore.md](../utils/secretStore.md)。

## 更新检查（批量 + manifest 持久化）

更新检查信息**持久化进各插件 manifest**（`lastCheckedAt` / `latestSha` / `latestDate` / `updateAvailable`），`plugins.list` 透传后前端默认展示版本信息——无需用户手动逐个检查即可看到「当前 SHA / 提交日期 / 最新与否」。

### plugins.checkAllUpdates（批量，全局入口）

`plugins.checkAllUpdates({})` 遍历全部已安装插件，逐个 `checkRemoteVersion` + 写 manifest，返：

| 字段 | 含义 |
|------|------|
| `checked` | 本次实际检查的插件数（含失败） |
| `updatesAvailable` | 检测到有更新的插件数 |
| `failed` | `[{name, reason}]` 检查失败的插件（私有仓 needsAuth / 网络错误等），**不中断整体** |

- 前端顶部「检查更新」按钮触发，完成后 `refresh()` 重拉 list 读持久化字段。
- **全局「上次检查时间」** = 各插件 `lastCheckedAt` 的最大值（批量检查时全部置 now），顶部展示。

### plugins.checkUpdate（单个，保留）

`plugins.checkUpdate({name})` 对比 manifest 当前 HEAD 与远端分支 HEAD，同样把结果写回该插件 manifest，返 `{currentSha, currentDate, latestSha, latestDate, lastUpgrade, updateAvailable, needsAuth, gitNotInstalled}`。

### 字段语义

| 字段 | 来源 | 含义 |
|------|------|------|
| `commitSha` / `currentSha` | manifest（安装/更新时快照） | 当前安装版本（7 位短 SHA） |
| `latestSha` | `git ls-remote <url> <branch>`（实时不下载） | 远端分支最新 SHA |
| `lastUpgrade` | manifest.updatedAt（上次 plugins.update 时间） | 上次升级时间戳 |
| `latestDate` | GitHub REST `GET /repos/{o}/{r}/commits/{sha}` | 远端 SHA 提交时间（私有仓 401 留空） |
| `updateAvailable` | `commitSha !== latestSha` | 是否有更新 |

- **版本号 = commit 短 SHA（7 位）**，不依赖仓库 tag/release。
- **旧 manifest 容错**：缺 `cloneUrl/branch` 的老插件，从 `sourceUrl` 派生 cloneUrl、`commitSha` 缺失视为「有更新」。
- **UI**：版本信息默认展示（`branch` / HEAD SHA / 提交日期 / 「最新」or「有更新」徽标 / 检查于何时）。`updateAvailable=true` 的卡片出现「拉取最新」按钮（`Refresh` icon `.spinning`），点击结果（成功 → 新 SHA / 失败 → 原因）挂在该按钮的 hover tooltip 上。

## plugins.update

`plugins.update({name})`：

1. 读 manifest 的 `cloneUrl` + `branch`（**不**读 sourceUrl，因为已规范化为 clone URL）。
2. `cloneRepo(cloneUrl, staging, {branch, auth?})` 重新 clone 覆盖（auth 复用凭据池；无凭据则尝试匿名，私有仓 needsAuth 时返错让用户重选）。
3. 抓新 commitSha/commitDate，覆盖 `plugins_dir/<name>/`，更新 manifest.updatedAt，并置 `updateAvailable=false`、`latestSha=新commitSha`、`lastCheckedAt=now`（已拉到分支 HEAD = 最新）。
4. 返 `{plugin: PluginInfo}`（含新版本字段）。前端「拉取最新」按钮的成功日志（新 SHA）挂 tooltip。

> update 与 importUrl 共用 cloneRepo；差异：update 不经 staging 预览，直接覆盖（已装插件的用户已表达过信任）。

## 协议

### 后端 RPC（plugins.* — 8 行）

| 方法 | 入参 | 出参 |
|------|------|------|
| `plugins.preImportUrl` | `{url, credentialId?}` | `{branches, defaultBranch, needsAuth, suggestedName, nameConflict}` 或 `{gitNotInstalled: true}` |
| `plugins.importUrl` | `{url, branch, credentialId?} \| {url, branch, username, password, remember?, label?, pluginName?}` | `{stagingId, pluginName, existing, sourceUrl, branch, commitSha, commitDate, savedCredentialId?, skills: [{name, description, trigger?}]}` 或 `{needsAuth: true}` |
| `plugins.commit` | `{stagingId, overwrite}` | `{plugin: PluginInfo}` |
| `plugins.checkUpdate` | `{name}` | `{currentSha, currentDate, latestSha, latestDate, lastUpgrade, updateAvailable}`（同步写 manifest） |
| `plugins.checkAllUpdates` | `{}` | `{checked, updatesAvailable, failed: [{name, reason}]}`（批量写各 manifest；成功条写空 `lastCheckError`，失败条写 `lastCheckError=reason`，manifest 缺失/git 未安装不写 manifest） |
| `plugins.update` | `{name}` | `{plugin: PluginInfo}` |
| `plugins.uninstall` | `{name}` | `{ok: true}` |
| `plugins.list` | `{}` | `{plugins: PluginInfo[]}`（含透传的检查字段） |

`PluginInfo` = `{name, sourceUrl, cloneUrl, branch, commitSha, commitDate, installedAt, updatedAt, lastCheckedAt?, latestSha?, latestDate?, updateAvailable?, lastCheckError?, skills: [{name, description, trigger?}]}`（`cloneUrl/branch/commitSha/commitDate` 在旧 manifest 上为空串；`lastCheckedAt/latestSha/latestDate/updateAvailable` 从未检查的旧插件为 undefined，`lastCheckError` 从未检查或检查成功的为 undefined；前端容错）。

> 凭据池 RPC（`credentials.list/save/delete`）独立于 plugins.*，详见 [../protocol.md](../protocol.md) credentials 块。

错误码：

- `INTERNAL`：磁盘 IO 失败、git exec 异常。
- `NOT_FOUND`：`plugins.commit/update/uninstall/checkUpdate` 目标 plugin 或 staging 不存在。
- `INVALID_PARAMS`：URL 无法解析、`credentialId` 与 inline password 同时给、branch 不在远端列表。
- 鉴权失败**不**走 RpcError，走 response 的 `needsAuth: true` 字段（让前端弹凭据输入，不视为错误终态）。

## 与 loader 关系

插件 skill 的发现完全复用 [loadSkill.discoverSkillRoots](../../src/agent/prompt/loadSkill.ts)：

- `discoverSkillRoots` 扫描 `skills_dir`（独立）+ `plugins_dir/*`（插件），插件 skill 的 `name` 自动加 `<plugin>__` 前缀避免命名冲突。
- 插件 manifest `.chery-plugin.json` 仅记录来源/版本，**不影响 skill 发现**——发现完全依据文件系统布局。
- `skills.list`（[skill/list.ts](../../src/service/skill/list.ts)）实时读两个根，故插件 commit 后无需重启即可见。
- 插件 skill 删除走 `plugins.uninstall`（整仓删除），**不走** `skills.delete`（仅独立 skill）。

## 文件清单

| 文件 | 职责 |
|------|------|
| [src/service/plugin/import.ts](../../src/service/plugin/import.ts) | `handlePluginsPreImportUrl`/`handlePluginsImportUrl`/`handlePluginsCommit`/`handlePluginsUpdate`/`handlePluginsUninstall` + `installPlugin`（staging→plugins_dir 落盘 + manifest 写入） |
| [src/service/plugin/list.ts](../../src/service/plugin/list.ts) | `handlePluginsList` + `buildPluginInfo`（manifest + skills 扫描，loader 共用） |
| [src/service/plugin/registry.ts](../../src/service/plugin/registry.ts) | `PluginManifest` 类型（含 `cloneUrl/branch/commitSha/commitDate` + 检查字段 `lastCheckedAt/latestSha/latestDate/updateAvailable`）+ `readManifest`（容忍缺字段） |
| [src/service/plugin/index.ts](../../src/service/plugin/index.ts) | barrel：`registerPluginHandlers`（8 个方法） |
| [src/service/skill/importShared.ts](../../src/service/skill/importShared.ts) | `parseGithubUrl`（URL 规范化）+ `createStaging`/`removeStaging`/`sanitizeName`/`pluginDirExists`/`extractZipBuffer` |
| [src/service/skill/gitClone.ts](../../src/service/skill/gitClone.ts) | git 预检 + `listRemoteBranches`/`cloneRepo`/`checkRemoteVersion` + `authEnv`（构造 `GIT_CONFIG_PARAMETERS`+`GIT_TERMINAL_PROMPT=0`），被 plugin & skill 共享 |
| [src/service/credentials/handler.ts](../../src/service/credentials/handler.ts) | `handleCredentialsList/Save/Delete` + `registerCredentialsHandlers`（包 secretStore） |
| [src/utils/secretStore.ts](../../src/utils/secretStore.ts) | AES-256-GCM 加密 + 凭据 CRUD，详见 [../utils/secretStore.md](../utils/secretStore.md) |
| [src/service/skill/import.ts](../../src/service/skill/import.ts) | `handleSkillsImportUrl` 走 parseGithubUrl→cloneRepo（默认分支，无鉴权 UI） |
| [web/src/features/agent/settings/tabs/PluginsTab.vue](../../web/src/features/agent/settings/tabs/PluginsTab.vue) | settings「插件」tab 单文件视图：顶部「检查更新」工具栏 + 卡片（版本元信息默认展示 + 彩色技能 tag + 条件「拉取最新」按钮）+ 导入栏（URL → 确认拉分支 → 分支 + 文件夹名 + 导入）+ 预览 dialog |

## 依赖与关联

| 依赖 | 用途 |
|------|------|
| [utils/secretStore](../../src/utils/secretStore.ts) | 凭据加密存储（AES-256-GCM） |
| [utils/config](../../src/utils/config.ts) | `config.global.plugins_dir` / `skills_dir` 路径 |
| [utils/logger](../../src/utils/logger/index.ts) | 字段名自动脱敏（`password`/`token`/`credential` → `[REDACTED]`） |
| [agent/prompt/loadSkill](../../src/agent/prompt/loadSkill.ts) | `discoverSkillRoots` 插件 skill 发现（共用） |
| [service/skill/importShared](../../src/service/skill/importShared.ts) | staging/sanitize/extract 共享 |
| [service/skill/gitClone](../../src/service/skill/gitClone.ts) | git CLI 包装（clone/ls-remote/log） |
| [service/utils/handler](../../src/service/utils/handler.ts) | `execFile`+`promisify` 模式参考 |
| [utils/vcs](../../src/utils/vcs.ts) | `windowsHide`/`stdio`/`timeout` 参考 |
| 第三方 `node:crypto` | AES-256-GCM + scrypt（凭据加密） |
| 第三方 `node:child_process` | git CLI 执行 |

## 扩展点

### 新增插件来源（用户视角）

1. settings「插件」tab 输入 GitHub URL（https / git@ / ssh://）。
2. 点「确认」→ preImportUrl 返 branches + needsAuth + suggestedName + nameConflict。
3. 私有仓 needsAuth → 输入用户名/密码（可选「记住」存凭据池）。
4. nameConflict=true（默认文件夹名已存在）→ 「文件夹名」输入框改名（避开冲突）。
5. 选 branch → 「导入」按钮（拿到分支后才出现）clone 到 staging 预览。
6. existing 冲突 → 确认覆盖；commit 落盘到 `plugins_dir/<name>/`。
7. 版本跟踪：顶部「检查更新」批量检查；有更新的卡片点「拉取最新」更新，结果挂 tooltip。

### 复用 gitClone 的模块

- **skills.importUrl**：已对标插件三步流程（`skills.preImportUrl` 拉分支 + `skills.importUrl` 选分支 clone + `skills.commit` 落盘）。鉴权同插件（credentialId / inline + remember）。来源记录中央索引 `.chery/.skill-sources.json`（按 {cloneUrl,branch} 分组，非 per-skill manifest），支持手动 re-sync（`skills.resyncSource` 重 clone + 重弹候选）。与插件差异：多候选逐项选择（非整仓）、无版本检查徽标、preImport 不返 `suggestedName/nameConflict`（冲突在 stage 时逐候选检测）。
- **commands**（未来）：指令模块当前只读（详见 [./command.md](./command.md)），未来若支持导入可复用 gitClone.ts，本次不接线。

### 升级路径到 OS keychain

当前凭据存储为 obfuscation 级（AES-256-GCM + 派生密钥），非 OS keychain。Electron `safeStorage` 是预期升级路径，但后端是独立 Node 子进程无法直连 Electron 主进程 API；当前未接，详见 [../utils/secretStore.md#威胁模型](../utils/secretStore.md)。
