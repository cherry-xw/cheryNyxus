# 架构问题（待办台账）

> 这里只记录当前仍存在、且本轮明确保留的问题。每项必须有位置、风险与完成条件；完成后删除条目，不保留历史墓碑。

## Web 前端

### TODO-A01 · Application 兼容端口仍过宽

- **位置**：`web/src/application/public.ts`、`application/backend/public.ts`、`application/transport/public.ts`。
- **现状/风险**：为先切断 feature 对 store/service 的穿透，迁移端口仍显式转发较宽的 store/client/DTO 表面；边界已可门禁，但用例契约尚不够窄。
- **完成条件**：feature 只消费按用例命名的 command/query port；`application/public.ts` 不再导出完整 Pinia store，backend/transport 兼容端口删除。

### TODO-A02 · `agents` 兼容 facade 尚未删除

- **位置**：`web/src/stores/agents/**`。
- **现状/风险**：canonical 会话事实已经由 ChatSession owner 持有，但 Pet/tool 展示仍经 legacy facade 投影，增加概念入口。
- **完成条件**：所有 feature 改用 chat/workspace/pets 用例端口；PetPresentation 直接由 runtime 投影；`agents` 无生产引用后删除。

### TODO-A03 · 巨型协议 client 与 controller 仍需按纯模型/用例拆分

- **位置**：`web/src/services/agentApi.ts`、`features/pets/nyxus/components/useMessageBranchTreeController.ts`、Workbench/Lite/History 等大 controller。
- **现状/风险**：它们已被依赖门禁包住，但单文件仍混合多个变更轴，review 与单测定位成本高。机械按函数或文件数拆分会掩盖问题。
- **完成条件**：协议 DTO 迁到 `@chery/protocol` 或语义 owner；client 按后端能力形成 adapter；controller 中确定性计算先迁到 `model/` 并有单测，Vue binding 保持薄层。

### TODO-A04 · 会话目标路由 UI 行为与旧测试基线不一致

- **位置**：`web/src/features/agent/composer/conversationTargetRouting.ts`、`web/test/agents/conversationTargetRouting.test.ts`。
- **现状/风险**：当前实现采用 `idle → full → half → idle` 且默认可见会话数为 6；旧测试仍期待 `idle → half → full → idle` 与更小列表。本轮目录重构不替用户决定交互行为。
- **完成条件**：产品确认交互后，只选择一侧调整（实现或测试），删除对应代码 TODO，并让该测试通过。

### TODO-A05 · i18n 与统一异步缓存基础设施尚未建立

- **位置**：Web 全局能力，当前无对应 package/资源目录。
- **现状/风险**：旧 Vue 规范曾把不存在的 i18n/Query 方案写成强制项，无法执行；目前用户文案与请求缓存仍按各能力处理。
- **完成条件**：先形成选型/迁移决策并建立公共 adapter、资源与 CI，再把要求升级为强制规范；此前不得在 feature 私自引入第二套方案。

### TODO-A06 · 视频/音频输入能力尚未由运行时配置启用

- **位置**：media/brain capability 配置。
- **现状/风险**：当前 `media` 配置为空，且未声明 `capabilities.input.video/audio`；界面可处理媒体资产，但运行时不能保证接收视频或音频输入。
- **完成条件**：配置并启用对应 media 网关与支持该协议的 brain；若采用文本转写降级，明确其输入/错误契约并补覆盖测试。

### TODO-A07 · 端到端协议验收尚未自动化

- **位置**：跨前后端协议与 Electron/Web 运行链路。
- **现状/风险**：当前重构由类型检查、架构/单元测试和构建兜底，仍缺真实连接、重连与桌面多窗口的自动验收。
- **完成条件**：建立可重复的端到端环境，覆盖登录、`chat.open` 重连、输入提交、审批/问题、工作台窗口与媒体路径。

## 验证基线

- 完整 Web lint 仍可能报告工作树中既有 UI 格式/未使用符号；架构核心目录必须独立保持 lint 通过。
- `conversationTargetRouting` 的两项旧断言按 TODO-A04 保留，不在无产品结论时修改行为或断言。
