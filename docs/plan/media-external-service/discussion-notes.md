# 媒体外部服务化——讨论备忘（查询用）

**文档创建时间：** 2026-09-22T01:06:05+08:00

> 本文档记录 2026-09-22 会话中围绕「多媒体服务配置 / 图生图 / 媒体进上下文」的全部架构讨论结论、注意点与待决问题，供后续查询，避免重复询问。需求基线见 [requirements.md](./requirements.md)，实施跟踪见 [README.md](./README.md)。

## 1. 语音输入纠正（本项目全局约定）

- 「绘画」=「会话」；「节点数」=「节点树」；「nexus」=「nyxus」。

## 2. 讨论脉络（一句话时间线）

1. 图生图设置步骤与图片进上下文 4 条途径（上传/多轮重发/历史带回/参考图引用）→ 确认 MiniMax 理解走 `/chat/completions`、生成走 `/image_generation`，两个独立端点。
2. 用户提出架构质疑：**能力开关应放工具（感官组）而非大脑**；`input.image`/`generate.image` 应仅作多模态模型能力声明，不是工具双重校验门。
3. 用户提议：多媒体改为「类似用户自定义工具」的外部服务方案（解耦配置 / 代理注入 / 统一入口 / 工具与多媒体融合改名「外部服务」）。
4. 核心问题：外部出参五花八门 → 设计内部规范化出参（适配器翻译 + 落盘统一 + 渲染层只认规范）。
5. 适配器落位：**直接放 `.chery/senses/`，适配器 = 自定义工具**，不新建 `.chery/adapters/`。
6. 多媒体 Tab 可去掉，逻辑内置自定义工具；CherryNexus 一键生成工具；key 走现有 `.env` 入口。
7. 为什么看图不是工具调用（手 vs 眼）→ 理解类不工具化，双轨（多模态直传 / 前置工具兜底）。
8. 前置执行设计：`accepts`（接收类型）+ `preprocess`（是否前置）两个正交字段；多图用 `batchSize`（工具内部分批，前端永远全量传入）。

## 3. 已确认的关键事实（代码依据）

| 事实 | 位置 |
|---|---|
| 内置生成 sense：`generate_image/video/audio`，schema 固定 `{prompt, reference?}` | `src/agent/sense/index.ts` 第 168-199 行 |
| 生成执行固定调媒体网关 `callMediaService`，与大脑模型无关 | `src/agent/sense/media.ts` |
| 双重门注入：`resolveSense` 中 `generateCapabilities` 拦截（第 305-307 行） | `src/agent/runtimeResolver.ts` |
| 输入双轨：多模态旁路（近 3 轮重发，总数≤10/单轮≤5/字节≤16MB）vs 旧路径（网关 understand 转文字） | `src/agent/middleware/chat.ts` |
| 媒体网关协议：JSON POST `{operation, model, prompt, assets}`，返回 `{text}` 或 `{text, assets}` | `src/service/media/index.ts` |
| 媒体配置粗粒度：`MediaServiceConfig` 六字段，一个服务=一个媒体类型；无 TTS/STT/音色细分 | `src/utils/config.ts` 第 142-151 行 |
| 发送门控：媒体服务 OR 大脑 input，**不认工具** | `web/src/features/agent/composer/useAgentDialogOptions.ts` `mediaServicesByType`（第 1394-1408 行） |
| 自定义工具机制：`.chery/senses/*.ts` → `compile-senses` → `new Function` 加载 | `src/agent/sense/index.ts` `loadCustomSenses`、`src/core/sense/compiler/core.ts` `compileSenses` |
| Sense 定义：`definition / executor / supervisionLevel`，**无能力声明字段** | `src/core/sense/senseCreator.ts` `Sense<T>` / `sense()` |
| 大脑 Tab 有「打开 .env」按钮（`openEnvFile`）+ 密钥下拉 + 刷新；**MediaTab 没有** | `web/src/features/agent/settings/tabs/brain/BrainCard.vue` |
| CherryNexus = cheryNyxus 角色（`cherry_nexus` 感官组），系统锁定预设 | `.chery.template/config.yaml`、`cheryNyxus.md` |

## 4. 核心设计决策（已确认）

1. **能力开关放工具**：生成类注入由「感官组配置 produces 声明的工具即注入」决定，大脑 `generate.*` 双门退役（兼容期保留字段不拦截）。
2. **工具能力声明四个字段**：`accepts`（接收：媒体类型 image/video/audio 或文件后缀 doc/docx/pdf…）、`produces`（产出）、`preprocess`（是否前置，缺省 false）、`batchSize`（每批容量，缺省不限）。
3. **适配器落位**：`.chery/senses/`，不新建目录；服务与工具是 **1:N**（一个音频服务 = tts/stt/clone 多个 sense），命名空间归组（复用 MCP `mcp__<server>__<tool>` 模式）。
4. **前置执行**：非多模态模型下扫描媒体引用 → 匹配 accepts+preprocess 工具 → 执行 → 结果替换进消息；**不持久化、失败跳过+提示、前置默认自动执行**（用户已明确上传文件，不进 smart 审批）。
5. **内部规范出参四层**：适配器翻译 → 内部规范 `{text?, items:[{mimeType, data|url, batchIndex}]}` → 落盘 `/api/media/` → 渲染层只认规范。
6. **多图处理（最终方案 B）**：前端永远全量传入，工具内部按 `batchSize` 分批、自己合并、自己管并发；结果带 `batchIndex`。调度层不拆图、不猜语义。
7. **密钥存储**：外部服务密钥写 `.env`（密文/变量），sense 执行从 `$ENV` 占位读取；设置页「打开 .env」入口复用 BrainCard 现成模式（`utils.openFile` RPC）。
8. **理解类不工具化**：工具=手（主动做事），理解=眼（接收输入）；理解是输入通道，多模态直传优先，非多模态前置工具兜底 + 可选理解工具二次细看。
9. **CherryNexus 生成**：生成符合规范的自定义 sense，**用户确认后编译加载**；`new Function` 信任边界 = `.chery/senses/*.ts`，AI 生成代码不得静默生效。
10. **hooks 不采用**：`UserPromptSubmit` 等 hooks 是全局事件、无类型匹配，只能解决部分问题，不做主方案。

## 5. 注意点与踩坑记录

- **自定义 sense 编译产物格式**：`export default sense(...)` → 编译后 `return sense(...)`；`new Function('z','sense','SupervisionLevel','registerSenses', code)` 执行，能力声明字段走第 6 参数透传，编译链路本身无需改。
- **SenseEntry 需透传 capabilities**：前置调度在 chat middleware 用 `ctx.runtime.senseTable`，`SenseEntry`（`src/core/middleware/types.ts`）必须带 `capabilities` 才能找到 preprocess 工具。
- **前置工具 schema 契约**：`preprocess:true` 的工具 schema 必须是 `z.object({ text, media: [...] })`（`{text, media[]}` 数组输入），调度层按此构造输入；不满足的 parse 失败 → 跳过+提示。
- **旧路径与前置调度的关系**：`enrichMediaInputs` 现有「多模态旁路 → 旧路径」；前置调度插在两者之间（非多模态且找到匹配工具时走前置，否则回退旧路径网关 understand）。
- **不持久化原则**：`attachments`/前置结果只在本轮内存 history 生效，不进 `LLMResponse`/DB；原始 `[[media:]]` 标记保留在 content，跨模型回放可重 enrich。
- **兼容**：`generate.*` 不再拦截后，旧配置中「大脑声明 generate 但感官组未配工具」→ 无工具注入（自然）；「感官组配了 generate_* 但大脑未声明」→ 现在注入（行为变化，目标）。
- **发送门控局限**：前端 `senseTools` 只返回内置工具；自定义工具的能力前端无法直接获取 → 发送门控对自定义工具不可见（已知局限，见待决问题）。
- **MiniMax 图片协议**：官方无「图片理解」file_id，图片进上下文只能是 URL 或 base64；项目媒体存本地无公网 URL → base64 唯一正确。视频理解（>50MB）才需 Files API + `mm_file://`。

## 6. 待决问题（实施中采用的默认值）

| 问题 | 采用默认 |
|---|---|
| 大脑 `generate.*` 退役时机 | 兼容期：保留字段解析与 config 校验，`resolveSense` 不再拦截 |
| 内置生成 sense 处置 | 保留为默认实现（带 produces 声明），用户可用自定义 sense 替换/扩展 |
| `accepts` 文件后缀初始白名单 | 媒体类型 image/video/audio + 常见文档后缀 doc/docx/pdf/xlsx/xls/pptx/txt/md/csv/json |
| CherryNexus 生成是否需要独立提示词 | 复用现有 cheryNyxus 角色 + 在提示词中补「外部服务工具生成」指引 |
| 多媒体 Tab 最终形态 | 保留为薄壳（密钥 + 挂载工具），加「打开 .env」入口；理解类配置并入 |

## 7. 关键文件索引

见 [requirements.md](./requirements.md) 第 4 节「现状盘点」表格（16 个文件全部验证存在）。
