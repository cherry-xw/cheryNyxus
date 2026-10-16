# 工作容器与小应用开发设计

> 待实施设计。任务授权、状态和恢复入口见[任务 README](README.md)；本文不代表当前实现或已部署接口。优先保障常驻服务，不以放宽隔离或配额作为兼容办法。

## 1. 已确定的方向与边界分类

### 1.1 用户已明确要求（强制遵守）

- 模型命令在与 Backend 平级的工作容器中执行，不采用 Docker-in-Docker，也不在 Backend 本体执行任意生成代码。
- 一个活跃项目对应一个工作环境，按需创建、停止和销毁；持久项目文件独立保留。不存在“一条命令创建一个容器”的要求。
- 专用命令工具对模型表现为统一执行入口，背后由可信容器管理器完成容器创建、挂载、资源约束与释放；模型不能指定容器 ID、宿主路径、网络、镜像或 Docker 参数。
- 取消固定容器数量上限，统一按总资源预算动态准入；正常启动或构建资源不足时只拒绝或排队，**不关闭其他人的容器**。
- 内存额度采用：常态运行总上限 2 GiB、单容器常态上限 200 MiB、瞬时并发最高总上限 4 GiB。配置内部以精确字节保存，展示统一标注 MiB/GiB，避免与十进制 MB/GB 混用。
- CPU、进程/线程数、磁盘空间、文件数、磁盘读写、日志、网络连接和任务并发一并限制，防止撑满系统；现有 Backend、QQ、NapCat 等常驻服务稳定运行优先。
- 静态分享与动态应用统一用户路径结构：保留 `/qq/{userId}/share/...`，动态应用使用 `https://mini.xcherry.top/qq/{userId}/apps/{appId}/...`。动态路径走代理，不把项目源码或数据目录直接作为静态目录公开。
- 仅维护一套固定完整模板（Vue + Express + SQLite，带默认鉴权、权限、文件、图表、CSV、实时进度与后台任务），依赖固定内置在工作镜像中，日常创建、构建、启动不联网拉包。
- 支持固定每周停止临时服务、长时间无人访问自动停止、用户手动停止/启动/续期、到期前通知。

### 1.2 待用户拍板的 3 项关键决策（实施对应能力前确认）

以下三项此前发起确认时超时未获答复，不可当作已确认事实；不依赖这三项的底座、控制面、资源配额、固定模板与基础网关可先行开发，触及对应开关时保持关闭或按最严格保守模式运行：

| 编号 | 决策点 | 方案 A（推荐默认，最稳妥） | 方案 B（扩展替代） | 未决时的开发处理 |
| --- | --- | --- | --- | --- |
| D1 | 同域名下的网页信任边界 | 首版仅限用户本人及互信内容使用 `mini.xcherry.top/qq/{userId}/apps/{appId}/`；不宣称能防同域名下恶意网页互相读取会话 | 为每个应用分配独立子域名（如 `{appId}.{userId}.apps.xcherry.top`），每个应用自身前端与 API 仍同源不跨域，同时用浏览器同源策略隔离不同应用与 share HTML | 网关路由与 `APP_BASE` 均按路径模式实现，同时将“多租户不互信私密模式”设为配置关闭；未配置独立域名时不向不互信访客开放私密凭据场景 |
| D2 | 主机极端压力时的越界保护动作 | 仅冻结新任务/新启动并取消正在运行的临时构建任务，**绝不主动停止已运行的他人应用容器**；若工作容器组触及 2 GiB/4 GiB 硬上限，由内核在工作组内按 OOM 终止超限进程 | 在满足正常不抢占的前提下，仅当宿主机整体可用内存或磁盘跌破紧急红线时，允许按可解释顺序停止附加应用容器以保护 Backend/NapCat | 资源管理器将紧急回收策略做成显式开关，默认采用方案 A（仅停临时构建，不关已运行他人应用），待你明确授权方案 B 后再开启应用级紧急回收 |
| D3 | 应用模板默认鉴权的首个管理员激活方式 | 每个小应用使用独立账号表与独立 Cookie；创建或发布后生成一次性激活链接，所有者打开后设置首个管理员密码，后续支持邀请码/成员角色，全程不在聊天中传输密码 | 接入现有平台统一浏览器登录会话，需额外完成跨路径单点登录校验与权限映射，避免把平台管理权限带入小应用 | 模板内置方案 A 的独立账户、一次性激活令牌与角色权限表；平台统一登录留作可选认证适配器，不阻塞首版模板开发 |

### 1.3 只读核实的宿主机与代码现状（2026-10-15 实测基线）

以下为只读命令核实的当前环境与代码事实，作为设计落地的真实约束，不代表已修改配置或已完成压力验证：

- **Docker 与 cgroup**：宿主机运行 Docker `29.7.2`，`CgroupVersion=2`，`CgroupDriver=systemd`，存储驱动 `overlayfs`，根目录 `/var/lib/docker`。`docker.service` 已启用 `Delegate=yes`，根 cgroup 控制器包含 `cpuset cpu io memory hugetlb pids rdma misc dmem`。
- **常驻容器现状**：实际 Backend 容器名为 `cherynyxus-backend-1`（镜像 `cherynyxus-backend:qq-information-20261015`），Manager 容器名为 `cherynyxus-manager-1`，NapCat 容器名为 `napcat`（镜像 `napcat-cherynyxus:region-fork`）。另有 `jellyfin`、`homeassistant`、`qbittorrent`、`bitwarden`、`mihomo` 等常驻容器。
- **文件系统与配额现状**：`/home/chery/docker/cherynyxus/user-files` 与 `/var/lib/docker` 位于同一块根分区 `/dev/nvme0n1p2`（`ext4`，挂载参数 `rw,relatime`，总计约 468 GiB，当前可用约 297 GiB，可用 inode 约 2791 万）。**当前根分区未启用 `prjquota`/`usrquota` 挂载参数**，且 `overlayfs` 在无底层 `xfs pquota` 或 `ext4 prjquota` 时不支持直接对普通容器设置 `--storage-opt size`。宿主已安装 `/usr/sbin/tune2fs`、`/usr/sbin/tc`、`/usr/sbin/nft`，但尚未配置专用配额卷或网络规则。
- **现有命令与文件工具代码定位**：
  - [`apps/backend/src/agent/sense/bash.ts`](../../../apps/backend/src/agent/sense/bash.ts) 与 [`apps/backend/src/core/security/executionMode.ts`](../../../apps/backend/src/core/security/executionMode.ts)：生产 compose 设置了 `CHERY_COMMAND_DIRECT=1`；在 [`apps/backend/src/core/security/rolePolicy.ts`](../../../apps/backend/src/core/security/rolePolicy.ts) 中，当 `directContainerExecution()` 为真时，`execute_command` 会直接返回 `allow` 与 `danger-full-access`，并在 Backend 容器内部启动子进程；且超时后仅将日志落盘并留在 [`processRegistry.ts`](../../../apps/backend/src/agent/sense/processRegistry.ts) 后台运行，不终止子进程，输出缓冲在内存中无限累加。
  - [`apps/backend/src/agent/sense/read.ts`](../../../apps/backend/src/agent/sense/read.ts)、[`write.ts`](../../../apps/backend/src/agent/sense/write.ts)、[`search.ts`](../../../apps/backend/src/agent/sense/search.ts)：直接接受绝对路径并在 Backend 容器文件系统读写；[`apps/backend/src/agent/middleware/tool.ts`](../../../apps/backend/src/agent/middleware/tool.ts) 的 `checkCheryGuard` 仅拦截 `.chery/` 目录。
  - [`apps/backend/src/agent/runtimeResolver.ts`](../../../apps/backend/src/agent/runtimeResolver.ts)：已连接 MCP 服务器的 `mcp__<server>__*` 工具会直接并入可用工具表，绕过普通 `sense_groups` 列表；子 Agent 生成工具 `spawn_role` 也可派生执行上下文。
  - [`apps/backend/src/service/ingress/identity.ts`](../../../apps/backend/src/service/ingress/identity.ts)：`IngressRequestIdentity` 中的 `ownerId` 实际是**接入插件包 ID**（例如 `cherynyxus-qq-module`），真实终端用户身份存放在 `identity.subject`（如 `{ selfId, userId, conversationType, groupId }`）。
  - [`plugins/qq/src/files.ts`](../../../plugins/qq/src/files.ts) 与 [`plugins/qq/src/tools.ts`](../../../plugins/qq/src/tools.ts)：QQ 专用文件工具通过 `subjectOf(ctx)` 获取真实 QQ 号，并在 `/app/qq-user-files/{userId}/` 下读写不超过 1 MiB 的纯文本文件。
  - [`apps/backend/src/service/http/index.ts`](../../../apps/backend/src/service/http/index.ts)：`createHttpServer` 目前只处理 `/api/machine/*`、`/api/browser-session*`、`/api/auth*`、`/api/media/*`、`/api/skills/import`、`/api/config` 与前端静态目录，尚未挂载 `/qq/{userId}/apps/{appId}/` 动态反向代理与 WebSocket `upgrade` 转发。

## 2. 总体架构、控制面隔离与防绕过

### 2.1 组件职责划分

```text
可信请求身份 (Ingress subject / Web principal)
  ↓
模型专用应用与命令工具 (Backend Sense 层)
  ↓
应用运行协调服务 (Backend 内部模块：身份校验、租期、状态机、通知、网关路由表)
  ↓ 仅限结构化 RPC (Unix Socket / 受保护内部接口，非原始 Docker API)
工作容器控制守护进程 (cheryNyxus-app-controller：预算账本、cgroup 调节、存储卷、Docker 生命周期)
  ↓
项目工作容器 (与 Backend 平级：/workspace + /data，固定镜像，监听 0.0.0.0:3000)

外部访问链路：
浏览器 HTTPS (mini.xcherry.top)
  → 外部反向代理
  → Backend HTTP/WS 应用网关 (/qq/{userId}/apps/{appId}/*)
  → 专用应用容器网络 (app_net)
  → 对应工作容器 3000 端口
```

### 2.2 为什么不把 `/var/run/docker.sock` 直接挂进 Backend

Backend 容器承担模型对话、外部插件、网页请求与文件操作。如果把宿主机 `/var/run/docker.sock` 直接挂给 Backend，一旦任何旧工具或插件存在未封堵的命令执行，就等同于拿到宿主机 root 权限。因此采用**受限控制服务 `cheryNyxus-app-controller`**：

- `cheryNyxus-app-controller` 作为独立受控服务运行（宿主机 systemd 服务或仅挂 Docker socket 的最小控制容器），只向 Backend 暴露单一 Unix Domain Socket（例如 `/run/cherynyxus-app-controller/controller.sock`）。
- 控制接口仅接受固定 JSON Schema 的操作：`ensureAppWorkspace`、`runAppCommand`、`cancelAppCommand`、`startAppService`、`stopAppService`、`destroyAppContainer`、`inspectAppStatus`、`reconcileAll`。
- 控制器自己在内部根据固定配置拼装宿主机路径、固定镜像摘要、网络名、安全参数和 `cgroup-parent`；**绝不接受调用方传入任意挂载路径、特权开关、任意镜像名、任意环境变量或原始 Docker 请求路径**。
- 工作容器内部不挂载 `controller.sock`、不挂载 `/var/run/docker.sock`、不挂载 Backend 的 `.chery` 目录或任何模型/平台密钥文件。

### 2.3 受管请求的全路径防绕过清单（堵死回到 Backend 本体的通道）

当请求处于受管用户开发场景（如 QQ 用户请求或受限开发角色）时，不能只新增一个工具而保留原有的宿主机/Backend 通道。实施时必须在 [`runtimeResolver.ts`](../../../apps/backend/src/agent/runtimeResolver.ts)、[`rolePolicy.ts`](../../../apps/backend/src/core/security/rolePolicy.ts) 和 [`tool.ts`](../../../apps/backend/src/agent/middleware/tool.ts) 同时收口：

| 潜在绕过通道 | 当前代码风险点 | 强制封堵措施 |
| --- | --- | --- |
| `execute_command` 直通 Backend | `CHERY_COMMAND_DIRECT=1` 时在 `rolePolicy.ts:207` 直接放行并在 Backend 容器内 `spawn` | 受管用户请求与受管开发角色禁止调用宿主机/Backend 本体的 `execute_command`；或由运行时根据请求主体的受管标记强制将命令路由到工作容器工具，绝不在 Backend 进程内 `spawn` |
| `read_file` / `write_file` / `search_codebase` 读写 Backend 任意路径 | 直接读写 Backend 容器内绝对路径，可读取 `/app` 或 `/proc/self/environ` | 受管请求下将文件读写与代码搜索限定在当前绑定的项目目录（`/app/qq-user-files/{userId}/apps/{appId}/project`）及用户个人目录内，拒绝其他绝对路径 |
| `bash.list` / `bash.kill` 与后台残留 | 超时命令留在 Backend 后台进程表 | 工作容器命令统一走容器任务表，不在 Backend 本机进程表残留 |
| MCP 工具注入 | `runtimeResolver.ts` 自动合并全部已启用 `mcp__*` 工具 | 受管请求默认 `mcp.default = 'deny'`，只允许显式列入安全白名单的无宿主机写权限工具 |
| `spawn_role` 派生高权限子角色 | 子 Agent 若切换为 `trusted` 角色可能重获 Backend 命令权限 | 子请求强制继承父请求的受管主体与最高权限上限（求交集），不可通过 `spawn_role` 提权 |
| `config_manage` / `install_skill` | 可修改 `.chery` 配置或安装执行代码 | 受管终端用户请求固定禁止调用系统级配置与技能安装工具 |

## 3. 身份映射、目录结构与并发文件安全

### 3.1 区分插件 `ownerId` 与业务终端用户 `principal`

现有 [`IngressRequestIdentity`](../../../packages/plugin-api/src/index.ts) 中，`identity.ownerId` 是插件包标识（如 `cherynyxus-qq-module`），不能直接当作用户目录名。本设计统一定义两级归属标识：

- **业务主体 `principalKey`**：
  - 当 `identity.source === 'plugin'` 且 `identity.channel === 'qq'` 时，必须通过 [`IngressIdentityAuthority`](../../../apps/backend/src/service/ingress/identity.ts) 校验，取 `identity.subject.userId`（严格匹配 `/^[1-9]\d{4,19}$/` 的真实个人 QQ 号），生成 `principalKey = "qq:" + userId`，磁盘用户目录段为 `{userId}`。
  - 若来自 QQ 开放平台映射且无法确认真实个人 QQ 号（如十六进制 OpenID `74B88543...`），**直接拒绝创建或访问 `/qq/{QQ号}/apps/`**，返回明确错误提示需要真实个人 QQ 号身份，严禁猜测或把 OpenID 拼进 `/qq/` 路径。
  - 当未来来自已认证 Web 用户时，使用可信会话中的稳定用户 ID，磁盘与路由命名空间独立，不混入 `/qq/`。
- **应用标识 `appId`**：格式固定为 `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`（3–32 位小写字母、数字与连字符，禁止以连字符开头或结尾，禁止保留词 `share`、`api`、`assets`、`static`、`admin`、`login`）。

### 3.2 统一磁盘目录与容器挂载映射

在用户文件根（生产环境宿主机为 `/home/chery/docker/cherynyxus/user-files`，Backend 容器内为 `/app/qq-user-files`）下，目录结构固定如下：

```text
{userFilesRoot}/{userId}/
  share/                              # 仅此目录对外公开静态文件 (/qq/{userId}/share/*)
  apps/
    {appId}/
      project/                        # 挂载到工作容器 /workspace (rw,nosuid,nodev)
      data/                           # 挂载到工作容器 /data (rw,nosuid,nodev,noexec)
      backups/                        # 仅控制器与 Backend 可访问，不挂入工作容器
```

**关键卡点与防护细节**：

1. **宿主机与 Backend 路径翻译**：Docker 守护进程在宿主机解析挂载路径。控制器配置固定 `HOST_USER_FILES_ROOT=/home/chery/docker/cherynyxus/user-files`，仅根据校验通过的 `{userId}` 和 `{appId}` 拼接宿主机挂载源路径，并在挂载前逐级 `lstat` 确认无符号链接（`O_NOFOLLOW`），防止用户或容器内部把 `project/sub` 软链到宿主机 `/etc` 或其他用户目录。
2. **容器 UID/GID 与权限一致**：宿主机 `user-files` 当前属主为 `1000:1000`（`chery:chery`）。工作容器固定以 `--user 1000:1000` 运行，且 `--security-opt no-new-privileges:true`、`--cap-drop ALL`；这样容器内构建产物与 Backend 文件工具读写拥有相同 UID，不会出现 root 写死文件导致 Backend 无法清理或备份的问题。
3. **QQ 文本文件工具与项目二进制文件的边界**：现有 `qq_read_file` / `qq_write_file` 限制 1 MiB 纯文本且不支持列目录；在受管小应用开发中，代码与二进制资源（SQLite 数据库、图片、压缩包、编译产物）主要通过工作容器工具在 `/workspace` 与 `/data` 内操作，同时提供按项目锁保护的文件读写接口。当工作容器正在运行构建或命令时，文件工具对同一项目的直接写入先检查项目写锁，避免边编译边改文件造成撕裂。

## 4. 磁盘硬限制的落地方案（解决 ext4 无默认配额的卡点）

### 4.1 现状堵点分析

当前 `/home/chery/docker/cherynyxus/user-files` 和 `/var/lib/docker` 都在 `/dev/nvme0n1p2`（`ext4 rw,relatime`）上：

1. 直接对 bind mount 目录做 `du -sh` 轮询**不是硬限制**——恶意或失控命令可在几秒内写出数十 GiB 文件或创建百万小文件耗尽 inode。
2. 当前根分区未挂载 `prjquota`，Docker `overlay2` 也无法直接对容器可写层启用 `--storage-opt size`。

### 4.2 两种可执行硬限制方案（实施阶段先核实选一，未生效前禁止开放）

| 方案 | 具体做法 | 优点 | 实施前提与注意点 |
| --- | --- | --- | --- |
| 方案 S1（推荐，无需改动根分区挂载项）：**受管稀疏镜像 + XFS Loopback 配额卷** | 在宿主机分配一个固定大小（如 12 GiB）的稀疏文件 `/home/chery/docker/cherynyxus/app-storage.img`，格式化为 `XFS` 并以 `loop,rw,nosuid,nodev,pquota` 挂载到专用目录（如 `/home/chery/docker/cherynyxus/app-workspaces`）。通过 `xfs_quota` 为每个 `{userId}/{appId}` 设置精确的目录级容量硬限（`bhard=512m`）和 inode 硬限（`ihard=20000`），容器只 bind-mount 该配额目录。 | 1. 总容量天然被镜像文件大小封死（绝不可能撑爆 297 GiB 的主盘）；2. 支持原生的每项目字节数与 inode 实时内核级硬拦截（超出立即返回 `EDQUOT`/`ENOSPC`）；3. 不必改 `/etc/fstab` 根分区或重启宿主机。 | 需要一次宿主机 root 权限创建与挂载 loop 设备，并配置 systemd mount 单元确保开机自动挂载；在挂载未就绪时控制器直接拒绝启动任何工作容器。 |
| 方案 S2（替代）：**启用 ext4 `prjquota`** | 对现有分区启用 `tune2fs -O project,quota` 并以 `prjquota` 重新挂载，使用 `chattr +P -p <projId>` 和 `setquota -P` 设置每项目硬配额。 | 无需单独镜像文件，直接在原目录生效。 | 需要改动根分区挂载选项并维护全局 project ID 分配表；容器可写层仍需额外限制。 |

### 4.3 容器可写层、tmpfs、日志与已删除打开文件的封堵

无论选用 S1 还是 S2，工作容器自身除 `/workspace` 和 `/data` 外的所有写入点必须全部封死：

1. **根文件系统只读**：工作容器强制 `--read-only`，容器可写层不承受业务写入。
2. **受限 tmpfs（计入内存 cgroup）**：仅挂载 `/tmp:rw,noexec,nosuid,nodev,size=64m,nr_inodes=4096` 与 `/run:rw,noexec,nosuid,nodev,size=16m,nr_inodes=1024`（构建阶段最多将 `/tmp` 设为 `128m`，且直接计入该容器的内存限额中，绝不会写满磁盘）。
3. **防止“删除文件但保持文件描述符打开”占满空间**：在配额文件系统（S1/S2）中，未关闭的已删除文件仍然计入该项目的磁盘 block 与 inode 配额，一旦达到 512 MiB 立即触发 `EDQUOT`；同时命令任务结束或服务停止时，若容器被销毁或重启，所有打开句柄立即由内核释放。
4. **Docker 标准输出日志硬上限**：每个工作容器强制设置 `--log-driver json-file --log-opt max-size=5m --log-opt max-file=2`（单容器最多 10 MiB 日志），应用内部文件日志写入 `/data/logs` 并启用最大 10 MiB 轮转（同样计入 `/data` 的 512 MiB 硬配额）。

## 5. 全量资源限制、动态内存账本与状态机

### 5.1 完整资源限制总表

| 维度 | 用户已确认 / 建议初值 | 内核/系统强制手段 | 超限时的精确现象 |
| --- | --- | --- | --- |
| 工作组总内存（常态） | **2 GiB (`2,147,483,648` B，用户已确认)** | systemd slice `cherynyxus-apps.slice` 设置 `MemoryMax=2147483648`、`MemorySwapMax=0` | 组内总内存触顶时内核回收组内缓存，仍不足则仅在 `cherynyxus-apps.slice` 内触发 OOM，绝不影响 `cherynyxus-backend-1` 或 `napcat` |
| 工作组总内存（瞬时） | **最高 4 GiB (`4,294,967,296` B，用户已确认)** | 仅在获批瞬时票据期间由控制器将父级 slice `MemoryMax` 临时调至 `min(2 GiB + 活跃瞬时增量, 4 GiB)` | 瞬时任务结束后按回落状态机恢复至 2 GiB |
| 单容器常态内存 | **200 MiB (`209,715,200` B，用户已确认)** | 容器 `--memory 209715200 --memory-swap 209715200` | 单应用内存泄漏超过 200 MiB 时该容器进程被 OOM 终止，状态记为 `crashed_oom`，其他应用不受影响 |
| 单容器瞬时内存 | **1.5 GiB (`1,610,612,736` B，建议初值)** | 获批构建/启动票据期间 `docker update --memory 1610612736 --memory-swap 1610612736` | 构建超出 1.5 GiB 时构建进程退出码 `137`（OOM），立即释放瞬时票据并把容器限额降回 200 MiB |
| CPU 配额 | 单容器常态 `0.5` 核（构建 `1.0` 核），工作组总计 `2.0` 核（建议初值） | 父级 slice `CPUQuota=200%`、`CPUWeight=50`；单容器 `--cpus 0.5` | CPU 跑满时仅被内核限流变慢，不会抢占宿主机 16 核上常驻服务的调度响应 |
| 进程与线程数 (PIDs) | 单容器 `128`，工作组总计 `512`（建议初值） | 父级 slice `TasksMax=512`；单容器 `--pids-limit 128` | fork 炸弹或线程暴涨立即收到 `EAGAIN`，无法耗尽宿主机全局 PID 表 |
| 文件描述符 (FD) | 单容器 `nofile` soft/hard `1024:1024`（建议初值） | 容器 `--ulimit nofile=1024:1024` | 句柄泄漏时仅该容器内报错 `EMFILE`，不耗尽宿主机文件表 |
| 项目磁盘与 inode | 每项目 `512 MiB` / `20,000` inodes；全部项目总池 `12 GiB` / `240,000` inodes（建议初值） | XFS loop 配额卷或 ext4 project quota | 写入超限立即返回 `ENOSPC`/`EDQUOT` |
| 磁盘 I/O | 工作组总读 `20 MiB/s`、总写 `10 MiB/s`、读写 IOPS 各 `500`（建议初值） | 父级 slice 对 `/dev/nvme0n1` 设置 `IOReadBandwidthMax`、`IOWriteBandwidthMax`、`IOReadIOPSMax`、`IOWriteIOPSMax` | 大量刷盘被限速，防止拖慢 Backend SQLite 与系统盘 |
| 网络带宽与连接 | 单容器上下行 `2 MiB/s`、总计 `5 MiB/s`；单应用并发连接 `32`、网关总并发 `128`（建议初值） | 宿主机 `tc` 限速 + 网关连接计数器与超时控制 | 慢速攻击或大流量下载被限速或返回 `429 Too Many Requests` |
| 命令执行与队列 | 普通命令默认 `60s`（最大 `180s`），构建命令最大 `300s`；重型任务全局并发 `1`，排队上限 `10`（每用户最多 `2`） | 控制器单互斥锁队列 + 超时强制回收 | 队列满时立即返回明确提示，不堆积无限等待任务 |

### 5.2 动态内存准入公式（无需固定容器数，但有诚实的数学边界）

设工作组常态总上限 $M_{\text{norm}} = 2\text{ GiB}$，瞬时最高总上限 $M_{\text{peak}} = 4\text{ GiB}$，单容器常态上限 $M_{\text{app}} = 200\text{ MiB}$，单容器瞬时上限 $M_{\text{burst}} = 1536\text{ MiB}$，安全余量 $M_{\text{reserve}} = 256\text{ MiB}$，每个运行中容器固定管理开销记为 $M_{\text{meta}} = 24\text{ MiB}$。

在任意时刻，控制器从父级 cgroup 读取实际内存占用 $U_{\text{actual}}$（`memory.current`），并维护内存中原子账本：

1. **已分配但尚未体现到实际占用的启动预留**：每个处于 `starting` 状态的容器预留 $R_{\text{start}} = \max(0, 128\text{ MiB} - u_i)$。
2. **有效常态承诺占用**：
   $$E_{\text{norm}} = U_{\text{actual}} + \sum_{i \in \text{starting}} R_{\text{start}, i} + N_{\text{running}} \times M_{\text{meta}} + M_{\text{reserve}}$$
3. **新启动一个普通应用容器的准入条件**：
   - 宿主机当前 `MemAvailable >= 2 GiB`，且相关磁盘剩余空间满足保护线；
   - $E_{\text{norm}} + 128\text{ MiB} \le M_{\text{norm}}$（即 `2 GiB`）；
   - 父级 cgroup 当前 `pids.current + 32 <= 512`。
   - **不满足时**：直接拒绝本次启动，返回结构化错误 `RESOURCE_BUDGET_EXCEEDED`（文案：“当前可用运行内存额度已满（常态总上限 2 GiB），无法再启动新的应用容器；现有运行中的服务不受影响”），**绝不关闭他人容器**。
4. **申请瞬时重型任务（构建 / 依赖校验 / 数据库迁移）的准入条件**：
   - 全局同时只允许 `1` 个瞬时重型任务处于 `burst_active`（其余进入最多 10 个槽位的有界 FIFO 队列，等待超过 `60s` 未排到则返回 `BURST_QUEUE_TIMEOUT`）；
   - 宿主机当前 `MemAvailable >= 2.5 GiB`；
   - $E_{\text{norm}} + (M_{\text{burst}} - M_{\text{app}}) \le M_{\text{peak}}$（即加上 `1336 MiB` 瞬时增量后不超过 `4 GiB`）。

**关于动态额度超订的坦诚说明**：
由于你选择了“不按 `200 MiB × 容器数` 死锁容器数量，而是按总内存动态准入”，当 15 个轻载容器（每个占 80 MiB，合计约 1.2 GiB）都已启动后，若这 15 个容器随后同时上涨到各自的 200 MiB 上限（合计 3.0 GiB），必然会撞上 2 GiB 的常态父级硬上限。任何系统在“父级硬上限 2 GiB、不预先锁死每容器 200 MiB 份额、又不主动停止已运行容器”这三个条件下，当所有已运行容器同时涨满时，内核 cgroup 一定会触发组内 OOM。为了尽量避免意外 OOM，我们在配置中提供两种可选准入模式：
- `dynamic`（按你要求默认启用）：按实际占用 + 启动预留 + 余量准入，支持更多轻量服务同时在线，但多个服务同时暴涨时可能由组内 OOM 兜底；
- `conservative`（保守模式，可一键切换）：按每运行容器固定计入 `200 MiB` 承诺值准入（最多同时约 9 个运行容器），可从数学上保证已启动容器涨到 200 MiB 时绝不触及 2 GiB 父级上限。

### 5.3 瞬时 4 GiB 扩容与回落状态机（解决构建结束后内存未降回的卡点）

不能在构建命令一结束就盲目把容器内存从 `1.5 GiB` 压回 `200 MiB`、把父级 cgroup 从 `4 GiB` 压回 `2 GiB`——如果此时构建子进程尚未完全退出或页缓存未回收，直接下调会立刻把正在运行的小应用 OOM 杀死。状态机固定为以下 6 步：

```text
normal (父级 2 GiB, 单体 200 MiB)
  ↓ 拿到唯一瞬时锁 + 持久化 burstDeadline (now + max 300s)
burst_granted (先调父级 MemoryMax -> 3.5~4 GiB，再调目标容器 memory -> 1.5 GiB)
  ↓ 启动构建/迁移命令 (独立进程组)
burst_running
  ↓ 命令退出 / 超时 / 取消
burst_cleaning
  ├─ 1. 强杀该次命令进程组的所有残留进程（保留应用主服务 PID 1 / 监管进程）
  ├─ 2. 清理 /tmp 构建临时文件
  └─ 3. 每 500ms 读取一次该容器 memory.current，最多等待 5s
       ├─ 若容器 memory.current <= 170 MiB：
       │    先调目标容器 memory -> 200 MiB，再调父级 MemoryMax -> 2 GiB → 回到 normal
       └─ 若 5s 后容器 memory.current 仍 > 170 MiB（说明构建把常驻进程撑大或存在泄漏）：
            绝不直接硬压限额导致不明 OOM，而是将容器重启为干净的运行态（仅启动构建产物服务），
            验证 memory.current <= 170 MiB 后，将容器限额降回 200 MiB、父级降回 2 GiB → 回到 normal
```

**控制器崩溃恢复**：`burstDeadline` 在授予前写入持久化状态表。若控制器或 Backend 在 `burst_running` 期间崩溃重启，启动时的 `reconcileAll()` 会首先检查所有未关闭的瞬时票据，回收超时构建并将父级 `cherynyxus-apps.slice` 强制恢复为 `2 GiB`，然后再开放新的请求。

## 6. 模型侧专用工具契约（单一工具 + 结构化动作）

为避免给模型增加过多工具导致上下文膨胀，模型侧仅新增一个专用工具 `managed_app`，通过 `action` 区分动作。所有调用自动从 `senseCtx.requestView.identity` 提取真实身份，模型参数中**不包含 `userId`、宿主机路径、Docker 参数或内部 IP**。

### 6.1 输入输出与动作定义

| `action` | 必填/可选输入字段 | 服务端动作 | 返回给模型的结构化字段 |
| --- | --- | --- | --- |
| `delete` | `appId` | 仅用户明确要求时删除可信本人指定应用；拒绝活动任务；停止并移除容器，校验无软链目录后删除代码/数据/备份，清配额、登记和未发送通知；失败不返回成功，不触碰公共镜像和其他用户 | `appId`, `deleted: true` |
| `create` | `appId`, `title`, `description?`, `visibility?: 'private' \| 'public_read'` | 校验配额与 `appId`；初始化 `{project,data}` 目录；从固定模板复制骨架与锁文件；写入应用元数据 | `appId`, `state: 'stopped'`, `appUrl`, `workspaceRoot: '/workspace'`, `dataRoot: '/data'`, `templateVersion`, `leaseExpiresAt` |
| `exec` | `appId`, `command`, `cwd?`（仅限 `/workspace` 内相对路径）, `profile?: 'standard' \| 'build'`, `timeoutSec?`（默认 60，普通上限 180，build 上限 300） | 确保工作容器处于运行态；`profile='build'` 时走瞬时内存队列；在容器内 `/workspace/{cwd}` 执行命令，实时限制输出字节（最多 256 KiB） | `taskId`, `status: 'completed' \| 'failed' \| 'timed_out' \| 'cancelled' \| 'oom_killed'`, `exitCode`, `durationMs`, `stdout`, `stderr`, `truncated` |
| `task_status` | `appId`, `taskId` | 查询正在执行或已结束的命令任务 | 同 `exec` 返回字段 |
| `task_cancel` | `appId`, `taskId` | 终止对应命令进程组；若为 `build` 任务则触发瞬时内存回落与残留清理 | `taskId`, `status: 'cancelled'` |
| `publish` | `appId`, `buildFirst?: boolean`（默认 `true`） | 如 `buildFirst` 则先跑 `npm run build`（离线）；启动/重启容器内 `0.0.0.0:3000` Express 服务；轮询 `GET /__app_health` 通过后原子注册网关路由；若首次启用鉴权且未激活则生成一次性激活链接 | `appId`, `state: 'running'`, `appUrl`, `health: 'ok'`, `activationUrl?`（仅首次未激活时返回）, `leaseExpiresAt`, `idleTimeoutHours` |
| `stop` | `appId` | 先从网关摘除路由并排空连接，再向容器发送 `SIGTERM`（10s 后 `SIGKILL`），保留 `/workspace` 与 `/data` | `appId`, `state: 'stopped'`, `dataPreserved: true` |
| `renew` | `appId`, `days?: number`（默认 7，上限 7） | 更新 `leaseExpiresAt = max(now, current) + days`，作废旧租期版本的待发通知；**不自动启动已停止容器，也不豁免每周固定清理** | `appId`, `state`, `leaseExpiresAt`, `weeklyCleanupExempt: false` |
| `status` | `appId?`（省略时列出当前用户全部应用） | 汇总容器运行态、实时内存/磁盘配额使用量、最近错误、访问地址与租期 | 应用状态列表（含 `memoryCurrentBytes`, `memoryLimitBytes`, `diskUsedBytes`, `diskLimitBytes`, `lastActiveAt`） |
| `backup` | `appId`, `note?` | 对 `/workspace` 与 `/data`（SQLite 使用在线 `VACUUM INTO` 一致性快照）生成压缩包存入受控 `backups/`（每应用最多保留最近 3 份，总大小计入用户配额） | `backupId`, `createdAt`, `sizeBytes` |

### 6.2 统一错误码（供模型与前端精确分支处理）

- `IDENTITY_REQUIRED`：当前通道无已验证的真实个人用户身份（如未绑定真实 QQ 号）。
- `APP_ACCESS_DENIED`：当前用户不是该 `appId` 的所有者。
- `RESOURCE_BUDGET_EXCEEDED`：常态 2 GiB 内存、PID 或磁盘预算不足，拒绝启动新容器。
- `BURST_QUEUE_TIMEOUT`：瞬时构建队列繁忙超时，建议稍后重试。
- `DEPENDENCY_NOT_IN_TEMPLATE`：`package.json` 引用了固定模板镜像之外的 npm 包，拒绝联网安装并列出可用内置包清单。
- `HEALTHCHECK_FAILED`：服务启动后未在 15 秒内通过 `0.0.0.0:3000/__app_health`，路由未发布，附最后 50 行启动日志。
- `STORAGE_QUOTA_EXCEEDED`：项目写入超出 512 MiB 或 20,000 inodes。

## 7. 固定应用模板与离线依赖落地细节

### 7.1 为什么用一套模板覆盖全部场景

只维护一套 **Vue 3 + Vue Router 4 + Vite + Express + SQLite + Zod** 固定模板，通过目录模块组合覆盖 6 类高频场景（表单收集、数据 CRUD、图表看板、实时任务进度、Markdown 资料库、CSV 导入导出小工具），不维护多套框架。

### 7.2 解决 `node_modules` 共享、Vite 构建与只读安全的卡点

如果每个应用都复制一份完整 `node_modules`，单项目就会占掉数百 MiB 磁盘与数万个 inode；如果把公共 `node_modules` 直接软链到 `/workspace/node_modules` 且允许写，又会被容器内脚本篡改或被 `npm ci` 破坏。固定布局设计如下：

1. **镜像内置只读依赖树**：在工作容器镜像构建阶段，于 `/opt/chery-app-template/` 下通过固定 `package-lock.json` 完成安装与原生模块编译，整个 `/opt/chery-app-template` 位于只读根文件系统（`--read-only`）上，容器内 UID `1000` 没有任何写权限。
2. **标准 Node/Vite 模块解析**：
   - 创建项目时，在 `/workspace/node_modules` 创建指向 `/opt/chery-app-template/node_modules` 的符号链接，同时在容器环境变量设置 `NODE_PATH=/opt/chery-app-template/node_modules`。
   - 模板内置的 `vite.config.ts` 显式配置 `resolve.preserveSymlinks = false`、固定 `cacheDir: '/tmp/vite-cache'`（写入受限 tmpfs，不占项目持久配额），并将 `base` 动态读取为 `process.env.APP_BASE || './'`。
   - 严禁模型对 `/workspace` 执行 `npm install` 或 `npm ci`；容器内的 `/usr/local/bin/npm`、`npx`、`pnpm`、`yarn` 包装为受控校验器：执行 `npm run build` / `npm run start` / `npm run db:migrate` 直接放行，执行 `install` / `add` / `dlx` 时立即对比 `/opt/chery-app-template/package.json`，若请求安装未内置包则直接报错 `DEPENDENCY_NOT_IN_TEMPLATE` 并打印内置能力列表。

### 7.3 内置依赖与默认底座模块清单

| 类别 | 内置固定包（在目标镜像实测锁定版本） | 模板默认已写好的开箱模块 |
| --- | --- | --- |
| 后端与 API | `express`, `zod`, `cookie-parser`, `helmet`, `express-rate-limit` | 统一错误中间件、请求体限制（JSON 1 MiB）、健康检查 `/__app_health`、`SIGTERM` 优雅停机 |
| 数据库 | Node 24 内置 `node:sqlite` 或与镜像 ABI 锁定的 `better-sqlite3`（构建镜像时二选一实测锁定） | `/data/app.sqlite` 自动初始化、`WAL` 模式、`busy_timeout=5000`、按版本号顺序执行 `/workspace/migrations/*.sql`（带事务与失败回滚）、分页查询辅助函数 |
| 鉴权与权限 | Node `crypto.scrypt`（密码哈希）、HMAC/随机会话表 | 独立 `users` / `sessions` / `invites` 表；`owner` / `admin` / `member` / `viewer` 四级角色；`HttpOnly; Secure; SameSite=Lax; Path=/qq/{userId}/apps/{appId}/` 会话 Cookie；`X-CSRF-Token` 双重校验 |
| 前端与可视化 | `vue`, `vue-router`, `echarts`, `dayjs`, `markdown-it`, `dompurify`, `papaparse` | 响应式导航壳、登录/激活弹窗、通用表格+筛选+分页、图表卡片组件、安全 Markdown 渲染组件（强制经过 DOMPurify）、CSV 导入导出（导出自动转义 `=,+,-,@` 开头防公式注入） |
| UI 与图标 | `element-plus`, `@element-plus/icons-vue`, `@lucide/vue` | 按需引入组件、中文语言包和离线 SVG 图标，不依赖 CDN |
| 状态与交互 | `pinia`, `@vue/devtools-api`, `@vueuse/core`, `sortablejs` | 状态管理、组合式工具和拖拽排序，不默认全部加载 |
| 样式与构建 | `tailwindcss`, `@tailwindcss/vite`, `sass`, `typescript`, `clsx`, `tailwind-merge` | Tailwind 4、SCSS 与类型工具由项目按需配置 |
| 内容与数据工具 | `lodash-es`, `fuse.js`, `qrcode`, `jszip`, `file-saver`, `highlight.js`, `katex` | 数据处理、搜索、二维码、ZIP/下载、代码高亮与公式，按需使用避免首屏膨胀 |
| 文件与实时任务 | `busboy`（流式受限上传）、原生 `EventSource` (SSE)、`ws` | `/data/uploads/` 附件管理（校验扩展名、大小上限 10 MiB、随机存储文件名、下载强制 `Content-Disposition: attachment` 防 XSS）；内置有限并发（最多 2 个）后台任务队列与 `/events` SSE 进度推送 |

## 8. 统一路径网关、前后端同源与网络隔离

### 8.1 外部 URL 与网关前缀剥离规则

- 静态分享保持不变：`https://mini.xcherry.top/qq/{userId}/share/{filePath}`。
- 动态应用固定入口：`https://mini.xcherry.top/qq/{userId}/apps/{appId}/...`。
- **尾部斜杠强制规范化**：访问 `/qq/{userId}/apps/{appId}`（无尾斜杠）时，网关直接返回 `308 Permanent Redirect` 到 `/qq/{userId}/apps/{appId}/`，保证前端相对路径 `./assets/...` 与 `./api/...` 永远解析在 `/qq/{userId}/apps/{appId}/` 下，不会错误跳到 `/qq/{userId}/apps/api`。
- **前缀剥离与透传头**：
  - 外部请求 `GET /qq/649207438/apps/stock-board/api/items?page=1` 到达 Backend 网关后，网关校验 `{userId, appId}` 在路由表中处于 `running` 状态，将请求转发到对应工作容器 `http://{containerIp}:3000/api/items?page=1`。
  - 网关在转发前**无条件删除客户端传入的所有内部头**（`X-Chery-*`、`X-Forwarded-*`、`Forwarded`），再由网关写入可信头：`X-Forwarded-Proto: https`、`X-Forwarded-Host: mini.xcherry.top`、`X-Forwarded-Prefix: /qq/649207438/apps/stock-board`、`X-Chery-App-Id: stock-board`、`X-Chery-Owner-Id: 649207438`。
- **模型免操心路径规则**：模板前端封装统一的 `apiFetch(path)` 与 `openAppEvents(path)`，内部自动基于 `import.meta.env.BASE_URL` 拼接请求地址；构建检查器在 `publish` 时扫描前端源码，若发现硬编码 `fetch('/api/...')` 直接给出修复提示，避免 AI 生成代码上线后 404。

### 8.2 SSE、WebSocket 与已停止应用的友好降级

1. **SSE (`/events`)**：网关对 `Accept: text/event-stream` 响应自动加上 `X-Accel-Buffering: no`、`Cache-Control: no-cache, no-transform` 并禁用压缩，防止 Nginx 缓冲导致前端收不到实时进度；单连接最长保持 30 分钟后平滑重连。
2. **WebSocket (`/ws`)**：在 [`apps/backend/src/service/http/index.ts`](../../../apps/backend/src/service/http/index.ts) 的 `server.on('upgrade')` 中拦截 `/qq/{userId}/apps/{appId}/ws*`，严格校验 `Origin === 'https://mini.xcherry.top'`，通过后代理到容器 `3000` 端口；容器停止时主动关闭所有关联 socket。
3. **应用已停止或不存在时的响应**：
   - 若浏览器请求的是页面（`Accept` 含 `text/html`）：返回 `503 Service Unavailable` 及清晰的中文状态页（显示“该应用当前已停止运行（原因：空闲超时 / 租期到期 / 每周例行清理 / 手动停止），你的历史数据已安全保留；请在 QQ 对话中发送‘启动应用 {appId}’恢复运行”）。**访问停止页不会自动唤醒容器，防爬虫/恶意刷新刷爆资源。**
   - 若请求的是 `/api/*`：返回 `503` JSON `{ error: { code: 'APP_STOPPED', reason, message } }`，绝不返回 200 HTML 导致前端解析 JSON 报错。

### 8.3 容器网络硬隔离

创建专用 Docker bridge 网络 `cherynyxus_apps_net`：

- `cherynyxus-backend-1` 同时连接原有的 `cherynyxus_backend` 网络（用于与 NapCat 等内部通信）和 `cherynyxus_apps_net`（仅用于网关连接工作容器 `3000` 端口）。
- 所有工作容器**只连接 `cherynyxus_apps_net`**，不连接 `cherynyxus_backend` 或 `host` 网络，因此工作容器根本无法路由到 `napcat:6099` 或其他内部容器。
- 在宿主机对 `cherynyxus_apps_net` 网桥启用容器间通信隔离（`com.docker.network.bridge.enable_icc=false`）及 `nftables` 规则：
  - 允许 `cherynyxus-backend-1` → 工作容器 `tcp:3000`；
  - 禁止工作容器主动发起到 `cherynyxus-backend-1`（包括 `8282`、`8283`）、宿主机本机、局域网 `192.168.0.0/16`、EasyTier `10.2.3.0/24`、Docker 网桥网关及链路本地 `169.254.0.0/16` 的任何连接。

## 9. 生命周期、自动回收与到期通知

### 9.1 四类停止机制与优先级

| 机制 | 默认策略（可配置） | 详细规则 |
| --- | --- | --- |
| 长时间无人访问停止 | 空闲 `24 小时` | 仅当网关收到真实用户的业务请求（页面首次打开、`/api/*` 读写交互）时更新 `lastActiveAt`（节流为每 60 秒最多落盘一次）。`/__app_health`、静态 `.js/.css/.png`、SSE 保活心跳和定时轮询请求（带 `X-App-Poll: 1`）**不刷新活跃时间**。若有正在运行的后台任务，最多延长空闲宽限 30 分钟。 |
| 租期到期停止 | 初始租期 `7 天` | 到期后立即停止容器并保留数据；用户手动调用续期每次延长 `7 天`，只改 `leaseExpiresAt`，不自动开机。 |
| 固定每周清理 | 每周一 `04:00` (`Asia/Shanghai`) | 扫描所有在本次清理时间点之前已启动且未标记管理员长期豁免的工作容器，统一优雅停止。控制器持久化 `lastWeeklyCleanupSlot`（如 `2026-W42`）；若周一凌晨宿主机关机或重启，恢复后只补停启动时间早于该周一 `04:00` 的容器，**绝不误杀恢复后新启动的容器**。 |
| 手动停止 / 启动 | 用户随时触发 | 用户在对话或管理界面可随时停止、重新启动、续期或备份。 |

### 9.2 到期前通知与防骚扰状态机

- **通知阶段**：在租期到期前 `24 小时`（阶段 `T_24H`）和到期前 `1 小时`（阶段 `T_1H`），以及因租期/空闲/周清理实际停止时（阶段 `STOPPED`）生成通知记录。
- **可信通知目标**：创建应用时记录已校验的创建来源（如 QQ 私聊 `{ channel: 'qq', selfId, userId }`）。若应用是在群聊中触发创建的，为保护隐私（尤其是含激活链接或个人应用状态），优先通知已开通私聊白名单的本人私聊；若本人私聊未在允许名单中，则在群内只发送不含任何敏感令牌的简短到期提醒，将激活链接留给个人私聊或受保护管理页。
- **持久 Outbox 与去重**：通知表以 `(appId, leaseVersion, stage)` 为唯一键。当用户执行 `renew` 续期时，`leaseVersion + 1`，旧版本的待发通知立即标记为 `superseded`。若发送时 NapCat 离线，最多退避重试 3 次；若投递结果处于 `unknown`（不确定是否已发出），状态记为 `delivery_uncertain` 并停止自动重发，严禁重复刷屏。**通知是否发送成功绝不阻塞到期停止容器。**

## 10. 完整用户与管理员交互流程

1. **首次创建并发布**：用户说“帮我做一个记账/统计看板应用” → 模型调用 `managed_app(action='create')` → 在 `/workspace` 修改前后端代码 → 调用 `managed_app(action='publish')` → 离线构建通过并完成健康检查 → 返回可点击的 `https://mini.xcherry.top/qq/{QQ号}/apps/{appId}/`（若启用了独立鉴权且未初始化，同时给出一次性管理员激活链接，30 分钟内有效，用后即焚）。
2. **日常修改迭代**：用户要求增加字段或图表 → 模型修改 `/workspace` 代码并执行数据库迁移 → 再次调用 `publish` → 网关平滑切换到新进程，`/data/app.sqlite` 中的既有数据完整保留。
3. **停止后恢复**：应用因 24 小时无人访问或周一凌晨清理停止后，用户打开网页会看到清晰的“已停止、数据已保留”说明；用户在 QQ 对话中说“启动我的 `{appId}` 应用” → 模型调用 `managed_app(action='publish', buildFirst=false)` → 检查 2 GiB 常态预算通过后 3 秒内恢复在线，URL 不变。
4. **管理员可见性（Manager 面板）**：Manager 通过受保护 RPC 查看所有工作容器的实时内存、父级 cgroup 占用、磁盘配额、租期和停止原因，支持一键冻结新应用创建、调整配额参数或手动停止异常容器，无需进命令行查 Docker。

## 11. 分阶段开发与交接顺序（准备进入开发的执行蓝图）

获得开发授权后，按以下 5 个工作包顺序完成源码与自动化验证。当前执行方式为主 Agent 单独顺序实施，不派发子 Agent；开发期间不逐包构建或替换业务镜像。各包的真实部署检查统一留在 WP5，在本任务与共享工作区另一任务的代码均完成、最终集成状态通过集中验证后统一构建、部署并实测。源码完成与部署验收分别记录，前者不得冒充后者。

| 阶段 | 工作包 | 关键落地内容 | 完成判据 |
| --- | --- | --- | --- |
| WP1 | 宿主机底座与受限控制器 | 1. 建立 `cherynyxus-apps.slice`（2 GiB 常态 / 4 GiB 瞬时）；2. 落地 XFS loop 硬配额卷或 ext4 project quota；3. 建立 `cherynyxus_apps_net` 网络与防火墙规则；4. 实现 `cheryNyxus-app-controller` 及持久化账本/恢复状态机 | 单元测试 + 受控容器实测读回 `memory.max`、`pids.max`、磁盘 `EDQUOT`、瞬时回落状态机 |
| WP2 | 固定模板与工作容器镜像 | 1. 构建固定工作镜像（Node 24 + Vue + Express + SQLite + ECharts + Papa Parse + DOMPurify）；2. 固化只读 `/opt/chery-app-template` 与受控 `npm` 拦截器；3. 实现默认独立鉴权、一次性激活、CSRF、附件与 SSE 任务底座 | 在 `--network none` 断网容器中完成模板创建、`npm run build`、迁移、启动与 `/__app_health` 200 验证 |
| WP3 | 模型工具与防绕过收口 | 1. 实现 `managed_app` 工具（8 个动作）；2. 将 `IngressRequestIdentity` 的 `subject.userId` 贯通到应用归属；3. 收口受管请求下的 `execute_command`、`read_file`、`write_file`、`search_codebase`、`mcp`、`spawn_role`，堵死回到 Backend 本体的通道 | `A01`–`A04` 越权、路径逃逸、超时/取消与绕过拦截测试全部通过 |
| WP4 | 动态网关、生命周期与通知 | 1. 在 `apps/backend/src/service/http/index.ts` 接入 `/qq/{userId}/apps/{appId}/*` HTTP/SSE/WS 代理与停止友好页；2. 实现租期、有效活跃度统计、周一 `04:00` 补清理与 Outbox 去重通知；3. 接入 Manager 状态查询与控制 RPC | `A13`–`A20` 同域路径、SSE/WS、停止重启、周清理补做与通知去重测试全部通过 |
| WP5 | 综合验证、部署与用户验收 | 1. 跑全量类型检查、构建与自动化验证矩阵；2. 按部署规范构建镜像并在 `10.2.3.6` 与 `mini.xcherry.top` 验证真实链路；3. 确认 Backend/NapCat 常驻服务无异常后交用户实机体验 | 满足[验收要求](acceptance.md)全部自动与人工关口 |

## 12. 外部参考

- [Docker 安全边界](https://docs.docker.com/engine/security/)、[容器资源约束](https://docs.docker.com/engine/containers/resource_constraints/)、[docker container update](https://docs.docker.com/reference/cli/docker/container/update/)。
- [Linux Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)：父级 slice 内存、CPU、PID、I/O 控制器与继承语义。
- [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci)、[Express Behind Proxies](https://expressjs.com/en/guide/behind-proxies.html)、[Vite Static Deploy](https://vite.dev/guide/static-deploy.html)。
