# 裁决记录（Decisions）

> 记录规范间的冲突仲裁与边界判定。新增条目：日期 + 背景 + 裁决 + 依据。

## 2025-08 · 容器组件与 composables 职责边界

- **背景**：v1.0 中 containers 与 composables 均可能触碰数据逻辑，存在"同一数据两处入口"风险。
- **裁决**：composable 是数据与逻辑的唯一提供者；container 仅为接线员；简单页面可省略 container 层（详见 [vue3-page-building-standard.md](./vue3-page-building-standard.md) §2.3）。
- **依据**：唯一调用链原则（核心哲学"关注点分离"派生）。

## 2026-08 · 目录数量规则与依赖边界

- **背景**：旧讨论曾使用“每文件夹不超过 5 个文件”，实际会把高内聚 graph/model 机械拆散，也不能阻止 store/feature 反向依赖。
- **裁决**：取消目录文件数上限；目录以 owner、依赖权限、变更轴和公共/内部边界形成。文件数与行数仅作为 review 信号。
- **依据**：结构必须降低修改扩散和非法依赖，而非只改善 tree 的视觉密度。

## 2026-08 · 项目级架构规范与 Vue 规范分工

- **背景**：Vue v1.1 同时规定项目目录、数据框架和组件写法，其中 `views/containers`、TanStack Query、i18n、ErrorBoundary 与当前仓库不符，并和 feature/application 架构冲突。
- **裁决**：项目层级与依赖由 `web-frontend-architecture.md` 唯一规定；Vue 规范只规定 view/controller/presenter 与组件质量。未落地的基础设施只能进入待办，不得写成当前强制门禁。
- **依据**：强制规范必须可执行、可验证，并准确描述当前系统。

## 2026-08 · Feature 的基础设施访问

- **背景**：已有门禁禁止 feature import store，却允许 feature 直连 service，导致 UI 仍绑定 transport DTO 和 client 细节。
- **裁决**：feature 同时禁止 import store 与 service，只能经 application public port。迁移期 backend/transport facade 允许存在，但必须显式导出、登记删除条件并持续收窄。
- **依据**：稳定入口必须覆盖状态与 I/O 两侧，否则只解决一半穿透问题。

## 2026-09 · 主题色调弃用暖金，改「深空电光」双极强调色

- **背景**：用户决策前端全面科技感重构（GSAP 动效体系 + 深浅色适配 + ≥30fps 硬约束），在「暖金+科技形态 / 霓虹 CRT 升格 / 深空电光全新色系」三案中选定后者；v1.2-v1.3 确立的「暖金 `#f6b73c` 唯一高亮、hljs 不含蓝」条款与该方向冲突。
- **裁决**：主题色调改为深空电光双极——深色模式电光青 `#22d3ee`（基底深空蓝紫 `#0b1020`）、浅色模式靛蓝 `#4f46e5`（基底冷白 `#f5f7fc`），经 `--accent` token 随 `data-theme` 翻转；hljs 解除「不含蓝」限制改冷色系。PaperGameCard 纸牌、Import 霓虹弹窗、nyxus CRT（`--nx-*`）等独立调色板子系统保持不动，阶段2+ 再议融合。详见 [ui-visual-and-interaction.md](./ui-visual-and-interaction.md) §4 与 [docs/plan/ui-deep-space-electro-stage1.md](../plan/ui-deep-space-electro-stage1.md)。
- **依据**：用户明确选定全新色系方向；双极强调色解决电光青在浅色底对比度不足（~2:1）问题（靛蓝 ~6:1）；独立子系统保留以控制单次重构风险（渐进式分期）。

## 2026-09 · GSAP 为唯一 JS 动画引擎（motion-v 退役）

- **背景**：动效栈并存 motion-v（10 文件）与 pixi.js/CSS；引入 GSAP 后双 JS 动画栈双 ticker 并存，帧预算无法统一管理，且 vendor 多一个 chunk。
- **裁决**：GSAP 为唯一 DOM 动画引擎，motion-v 全部用法迁移后删除依赖；pixi.js（执行图 canvas）与 CSS @keyframes 不属 DOM 动画栈，维持现状。动效规范见 [docs/web/motion-standard.md](../web/motion-standard.md)。
- **依据**：单一 ticker 才能接入 `renderQuality` 调速器形成统一帧采样；「降复杂度不降帧率」的降级策略需要统一入口；仓库已有动效恒开约定（settings.md），GSAP 默认不跟随 reduced-motion 与之一致。
