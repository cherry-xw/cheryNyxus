# 工作台文件工作区与 Terminal

**状态：** 实施中

本文维护 `web/` 中三种工作台模式共用的输入、文件工作区和 Terminal 展示事实。跨端字段见[共享协议](../shared/protocol/workspace-files-terminal.md)，后端路径和会话安全见[服务层专题](../backend/service/workspace-files-terminal.md)。

## 入口与布局

入口由 `WorkbenchDialog` 的工具栏提供，树、对话和精简三种模式共用同一个 per-window 文件工作区状态。打开文件功能后使用一列文件树加右侧查看区，原模式状态保留，关闭后恢复原视图。

文件树懒加载目录；目录加载超过 1.5 秒才显示状态提示；点击文件打开只读 tab；查看区顶部显示工作区相对路径，支持多 tab 和关闭。文件树行在 hover 或键盘聚焦时显示 `and 这个文件`/`and 这个文件夹` 操作，操作只向当前输入框插入 `[[file:...]]`。

## 输入与发送

节点树使用 `AgentComposer` 和 `useAgentDialogOptions`；对话与精简输入使用共享的 `useInstructionSuggestions` 和 `InstructionSuggestions`。三者共用 `commands.ts` 的 token 格式（`serializeCommandToken` 等），支持候选过滤、键盘选择和文件回填，保留各自草稿和附件功能。输入提示说明 `/` 是指令、`@` 是角色、`&` 是文件引用，以及正文由 Agent 按需读取。`/` 指令候选在三种视图都带 tab 栏（指令/技能/组合技，左右键切换），对话/精简的 tab 分组与 token 与树页面完全一致（2026-09-20 起）。

节点树在一轮响应结束且当前根没有审批/提问时按 `useWorkbenchDialogController` 的终态规则打开输入区；用户主动关闭同一轮不被自动打扰。首次适配视图和切根使用偏上相机定位，保留 hover 面板的下方空间，用户手动平移后暂停自动跟随。

## 查看器和图标

查看器只提供查看和关闭，不提供编辑。文本/代码使用现有 highlight.js 按扩展名显示语法，长单行默认保持原样并可切换行内折行；图片直接预览，二进制文件显示有限的十六进制和 ASCII 预览，无法提供数据时显示图标、说明和大小。`WorkbenchFileIcon` 使用 SVG 文件夹、Git、环境配置和带类型缩写的文件图标，覆盖 `.git`、`.env`、`.ts`、`.js`、`.json`、`.txt`、`.md`、`.cshtml` 等。文件区占满工作台内容区，Terminal 作为独立 tab 打开；切换会话或关闭工作台时释放。

## Terminal 展示

Terminal 通过 xterm 渲染后端 session 事件。本机和 SSH 目标在标题区明确显示；输入、输出、resize、连接状态、退出码、关闭和错误都由会话 controller 管理。连接页只显示已保存的预设下拉、连接/断开按钮和设置入口，连接成功后 tab 名称同步为服务信息。设置页的 Terminal 标签创建预设，密码通过后端凭据接口加密保存，预设摘要在本地 AES-GCM 加密保存，连接时后端只在当前会话中解密使用。浏览器端密钥也暂存在本地存储，因此这是防止明文落盘的方案，不等同于操作系统密钥链。设置页保存或删除预设后，通过同页事件刷新已经打开的 Terminal 下拉列表。Terminal 与文件树目标分开显示，避免把当前后端工作区和 SSH 目标混成同一目录。
