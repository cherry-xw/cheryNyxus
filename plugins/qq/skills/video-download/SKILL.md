---
name: video-download
description: Use when the user explicitly @mentions the AI with a video URL (or asks the AI in DM) to parse, probe available resolutions/sizes, download MP4/M3U8 videos via the isolated worker container, and deliver to QQ, while distilling reusable site scripts into group/personal space.
---

# 通用视频解析与下载技能 (`video-download`)

## 1. 适用边界与固定方案并存原则
- **执行参数**：qq_container_exec的cwd只能是相对路径，使用`.`，禁止`/workspace`或`/workspace/files`。scope仅允许`auto`、`group`、`personal`；群请求用`group`或`auto`，不得使用`private`。命令示例：`node "$QQ_SKILLS_SCRIPTS_DIR/video.mjs" probe "目标URL"`。
- **不擅自改变目标**：用户要求下载指定链接时，先查可复用脚本并探测媒体、清晰度及大小。搜索只用于站点解析方法、工具用法和实际报错；不得未经要求转去调查正版平台、评价下载是否合适，或凭域名/作品名称推断具体资源授权状态并拒绝。用户明确询问版权时才把版权查询作为任务。不得未经同意用其他平台替代指定链接。实际遇到登录、访问限制或DRM时，准确报告检测结果，不绕过权限、不把推测说成事实、不将尝试失败表述为未验证的绝对不能下载。仍须先取得用户对清晰度和大小的同意，再下载。
- **保留原固定自动方案**：群内未 `@AI` 直接发送的抖音、B 站分享链接，由系统底层固定自动队列无感处理，无需 AI 介入。
- **本技能触发条件**：当用户明确 **`@AI` 并附上视频网页链接 / M3U8 / MP4 链接**（或在私聊中要求 AI 解析/下载视频、指定清晰度）时，使用本技能。

---

## 2. 标准执行流程（先查沉淀脚本 -> 探测询问清晰度 -> 下载转码 -> 发送 -> 沉淀复用脚本）

### 第一步：优先检查群共享空间 / 个人空间的已沉淀脚本（节省 Token 与探测时间）
在从头抓取 HTML 之前，**先检查是否已有针对该网站/域名的沉淀脚本**：
1. **群聊场景**：
   - 调用 `qq_group_memory_search` 搜索目标网站域名或关键词（如 `m3u8`、`下载脚本`、域名）；
   - 或调用 `qq_group_read_file` 读取 `scripts/index.json` 或 `scripts/<domain>.mjs`。
2. **私聊场景**：
   - 调用 `qq_read_file`（现有个人记忆由请求上下文提供） 查看个人 `scripts/` 目录。
3. **直接复用**：如果已有现成解析/探测脚本，直接通过 `qq_container_exec` 调用该脚本，**无需重新抓取网页分析 DOM 结构**！

### 第二步：探测视频流与可用清晰度（Probe 阶段）
优先使用内置通用探测脚本（在隔离执行容器内运行）：
```bash
node "$QQ_SKILLS_SCRIPTS_DIR/video.mjs" probe "<URL>"
```
如果内置探测脚本返回 `NO_MEDIA_FOUND_IN_HTML`（例如特殊加密或动态结构网页）：
1. 在 `qq_container_exec` 中获取网页 HTML 或提取内嵌 JSON / `.m3u8` / `.mp4` 真实地址；
2. 对提取到的真实流地址再次运行 `video.mjs probe "<真实流URL>"` 或 `ffprobe` / `N_m3u8DL-RE`。

### 第三步：向用户展示清晰度清单并等待确认（核心交互规范）
拿到可用清晰度列表后，**除非用户在当前指令中已经明确指定了清晰度（如“直接帮我下 720P”）**，否则必须先向用户回复可选清晰度清单，并严格遵守以下 4 条规范：
1. **标注文件大小与明确单位**：每一档清晰度必须标明分辨率（如 `480P`、`720P`、`1080P`、`2K/4K`）和对应的文件大小，明确带上单位（如 `32.5 MB`、`1.02 GB`）。
2. **强调流量与传输速度限制**：明确提醒用户——**不同大小的文件下载耗时与 QQ 发送速度会受到网络流量的严格限制，体积越大发送越慢**。
3. **给出移动端合理建议（拒绝无脑推荐最高画质）**：明确提示用户在当前手机/QQ 观看环境下播放不受影响的清晰度，不要无脑引导选最高画质。
4. **结合手机实际环境推荐 720P / 480P**：明确说明**在手机环境中，720P 已经非常清晰，480P 也是完全可接受的（且省流、发送最快），不一定非要用 1080P 或 2K、4K**。
5. **硬限制说明**：单次下载硬上限为 `workerMaxDownloadMb`（默认 **1024 MB / 1 GB**），超过 1 GB 的档位直接标注“超出 1 GB 硬限制，不支持下载”。

> **回复模板示例**：
> 已解析到视频《xxx》（时长 03:20），可选清晰度如下：
> - **480P**（854x480）：约 **24.6 MB**（极速省流，手机观看可接受）
> - **720P**（1280x720）：约 **52.8 MB** ⭐ **推荐**（手机环境非常清晰，加载与发送快）
> - **1080P**（1920x1080）：约 **138.4 MB**（文件较大）
> - **4K**（3840x2160）：约 **620.0 MB**（体积很大，将转为群文件发送）
>
> 💡 **提示**：不同大小的文件发送速度会受到流量的严格限制。在手机环境中 **720P 已经非常清晰，480P 也完全可接受**，无需盲目选择 1080P 或 2K/4K。请回复你要下载的清晰度（如“720P”）！

### 第四步：实操下载与 QQ 兼容性规范化（Download 阶段）
用户确认清晰度后，在 `qq_container_exec` 中执行下载：
```bash
node "$QQ_SKILLS_SCRIPTS_DIR/video.mjs" download "<URL>" --format "<formatId>"
```
脚本会自动完成：
- MP4 直链、`yt-dlp` 或 FFmpeg 下载；M3U8默认FFmpeg，显式设置QQ_HLS_DOWNLOADER=nm3u8时可调用N_m3u8DL-RE，失败回退FFmpeg（当前二进制非交互运行尚有上游异常）；
- 实时监控下载体积，超过硬上限（默认 1 GB）立即中止并清理；
- **强制 QQ 视频兼容性检查与转码**：确保输出为标准 `.mp4` 容器、**第 0 轨为 H.264 视频流**（非 H.264 自动转码）、**第 1 轨为 `AAC-LC`（`aac_low`）音频流**（自动将导致 QQ 发送报 `SUCCESS_NOSEQ` 的 `HE-AACv2` 音轨转码为 `AAC-LC`），并写入 `-movflags +faststart`。
- 下载成功后返回 `mediaFile`（例如 `1792200000000123456.mp4`，已位于共享目录 `/workspace/media/`）。

### 第五步：发送视频给用户（Deliver 阶段）
拿到 `mediaFile` 后，立即调用 **`qq_deliver_media`** 工具：
- 参数：`{ "mediaFile": "<返回的mediaFile>", "fileName": "<视频标题>.mp4" }`
- 工具会根据体积自动判断：小于气泡上限（默认 200 MB）发为聊天内嵌视频气泡；大于气泡上限（200 MB ~ 1 GB）自动切换为上传 QQ 群文件 / 私聊文件！

### 第六步：自动总结与沉淀脚本（供后续零调研复用）

只沉淀已经成功执行的方案。脚本参数化页面URL、清晰度、输出目录，记录适用域名、依赖版本、输入输出及最近验证方法；不得保存Cookie、Token、签名直链。创建或更新scripts/index.json作为索引；复用失败如实说明并重新验证，不把旧成功当作永久有效。容器中仅挂载当前身份文件到/workspace/files，不能访问其他群或其他用户。
如果你在本次任务中针对某个特定网站编写了自定义 HTML 解析逻辑或下载命令：
1. **将解析+下载流程封装成独立可复用脚本**：
   - 群聊中调用 `qq_group_write_file` 写入 `scripts/<site-name>.mjs`（容器内路径自动映射为 `/workspace/files/scripts/<site-name>.mjs`）；
   - 私聊中调用 `qq_write_file` 写入 `scripts/<site-name>.mjs`。
2. **写入记忆索引**：
   - 群聊中调用 `qq_group_memory_manage` 记录一条群共享经验（指明站点域名、脚本路径 `scripts/<site-name>.mjs` 及调用参数）；
   - 下次群内再遇到同类链接，直接用 `qq_container_exec` 执行该脚本即可一步到位！

---

## 3. 常用工具高频指令速查表（无需查文档）

### A. `N_m3u8DL-RE`（GitHub Star `nilaoda/N_m3u8DL-RE` v0.6.0-beta CLI）
容器内已预装 `N_m3u8DL-RE`，最常用标准命令：
```bash
# 1. 标准 M3U8 自动选流并发下载到临时目录
N_m3u8DL-RE "<M3U8_URL>" \
  --tmp-dir /tmp/nm3u8 \
  --save-dir "$CHERY_MEDIA_DIR" \
  --save-name "video_raw" \
  --thread-count "${QQ_WORKER_THREADS:-4}" \
  --concurrent-download \
  --auto-select \
  --no-log \
  --header "User-Agent: Mozilla/5.0" \
  --header "Referer: <PAGE_URL>"

# 2. 指定分辨率（如优先选 720P 视频流 + 最佳音轨）
N_m3u8DL-RE "<M3U8_URL>" \
  -sv res="720*":for=best \
  -sa for=best \
  --tmp-dir /tmp/nm3u8 \
  --save-dir "$CHERY_MEDIA_DIR" \
  --save-name "video_720p" \
  --thread-count "${QQ_WORKER_THREADS:-4}" \
  --no-log
```

### B. `ffmpeg` & `ffprobe`（QQ 视频兼容性转码与流探测）
**铁律**：NTQQ Linux 原生发送气泡视频时，如果**音轨是 `HE-AACv2`** 或者**音频流排在第 0 轨（视频流在第 1 轨）**，会导致 `Native message unconfirmed: SUCCESS_NOSEQ`（群内完全看不到视频）。所有自定义生成的 MP4 必须执行以下规范化命令：
```bash
# 1. 查看视频流顺序、编码与 profile（检查 codec_name、profile 是否为 LC）
ffprobe -v error -show_entries format=duration,size -show_entries stream=index,codec_type,codec_name,profile,width,height -of json "<INPUT_MP4>"

# 2. 将任意 MP4 / TS / M3U8 规范化为 QQ 兼容规范的 MP4（实际送达仍需回执确认）（视频首轨 + AAC-LC + faststart）
ffmpeg -nostdin -v error -threads 2 -y \
  -i "<INPUT_FILE_OR_M3U8>" \
  -map 0:v:0 -map 0:a:0? \
  -c:v copy \
  -c:a aac -profile:a aac_low -b:a 128k -ar 48000 -ac 2 \
  -movflags +faststart \
  "$CHERY_MEDIA_DIR/<TIMESTAMP_DIGITS>.mp4"
```
> 注意：交付给 `qq_deliver_media` 的文件名必须为纯数字加 `.mp4`（如 `1792200000123.mp4`），存放在 `$CHERY_MEDIA_DIR`（即 `/workspace/media`）下。
