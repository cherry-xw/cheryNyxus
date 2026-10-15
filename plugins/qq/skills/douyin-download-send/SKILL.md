---
name: douyin-download-send
description: 消息包含抖音分享链接时，下载该作品的视频并发送到原 QQ 会话。
trigger: 消息包含 https://v.douyin.com/ 或抖音作品链接
---

# 抖音与B站下载发送

B站支持公开投稿短链及视频链接，通过bilibili-download-script使用yt-dlp提取格式，HEAD核实音视频合计大小后，选最高不超过1080P且小于150 MiB的版本并用ffmpeg合并。大小未知拒绝；执行中硬限制，失败清残留。抖音视频同样150 MiB，存在多版本时优先最高不超过1080P且已核实大小的版本。实际阈值150×1024×1024字节。原生JSON卡片仅提取允许域名的视频链接，只有标题封面不猜。两站共用media目录、下载锁、24小时每日清理及投递保护。

## 用途
处理单条消息里的一个抖音作品链接。多个消息交由现有 QQ 队列顺序执行。不建立额外服务、管理页面或限制配置。

## 正式 QQ 自动流程
QQ 入站模块识别链接并保留原消息的会话身份，在现有任务队列中调用本技能的 scripts/download.mjs。脚本返回 JSON 结果；模块仅在 ok=true 且生成有效媒体后交给 NapCat：MP4 使用 qq.reply.video，图片列表使用 qq.reply.images；发送到该消息的原会话，并等待真实发送回执。单张实况图使用其动态视频，静态图片转换为 PNG，动画图片转换为保留帧的 GIF；最多 30 张图片，混合实况相册暂不支持。
不要再次用文字答复重复视频，也不要绕过白名单、绑定、认证、队列或未知发送结果保护。

## 下载入口
脚本随 QQ 插件包安装，由清单资源 `douyin-download-script` 定位。正式模块通过 `context.resources.resolve('douyin-download-script')` 获取安装绝对路径，用 execFile 参数数组传入消息中的 HTTPS 分享链接；不依赖全局 `.chery/skills`，不把链接拼接成 shell 指令。最长执行 240 秒。

默认视频目录为 $HOME/media。输出仅为 JSON，视频包含 ok、id、file、bytes，图片包含 ok、id、kind=images、files；失败退出非零并返回错误。调用者必须检查 JSON 与文件，不能只看退出码。

## 实现与依赖
复用 Playwright/Chromium 无头浏览器路径，读取精选页 RENDER_DATA 并严格匹配目标作品编号，避免下载推荐视频。Node Playwright 安装在持久目录 $HOME/browser-tools，Chromium 位于 $PLAYWRIGHT_BROWSERS_PATH（默认 $HOME/browsers）。保留通用 Python 工具，不安装 Python Playwright。无须手动提供 Cookie；网站仍可能要求登录或验证，此时明确失败，不自动绕过。

## 发送与清理边界
图片转换依赖现有 ImageMagick identify/convert；本脚本只下载；QQ 模块负责按原会话生成媒体事件，NapCat 负责原生上传与回执。普通命令调用不能声称视频已经发送。
所有视频及失败残留放在专用 media 目录。每日清理超过 24 小时的文件；下载通过 flock CLI 持有 media 父目录 .downloads.lock 的共享锁，与宿主清理的 fcntl.flock 排他锁协调。未确认发送的文件受正式 outbox 保护。工具、技能、浏览器、凭据和业务数据不参与清理。
