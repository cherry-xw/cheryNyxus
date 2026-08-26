# Vue 3 视图与 Controller 规范 v2.0

> **状态**：强制执行。  
> **适用范围**：`web/src/**/*.vue` 及 feature 内 Vue controller/composable。  
> **配套规范**：目录归属与依赖方向以 [Web 前端架构与目录规范](./web-frontend-architecture.md) 为准。

## 0. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| v1.1 | 2025-08 | 将硬行数改为 review 信号，明确 container/composable 唯一调用链 |
| v2.0 | 2026-08 | 适配本仓库的 feature/application 架构；移除仓库未采用的 `views/containers`、强制 Query/i18n/ErrorBoundary 等虚假门禁；明确 presenter/controller/view 与现有 CI 规则 |

## 1. 核心原则

1. **一个事实只有一个入口**：视图不复制 store/application state，子组件不直接改父级或全局状态。
2. **纯计算先于框架 binding**：排序、布局、projection、状态迁移先抽成纯 presenter/model；controller 只连接 Vue 生命周期与 application port。
3. **按变更轴拆分**：一起变化的模板、controller 与专属样式允许同址；无关能力不因属于同一个大弹窗而混在同目录。
4. **组合优于间接层**：slot、scoped slot、`defineModel` 和小型展示组件优先；不为“层数完整”创建只透传全部 props 的 container。

## 2. 三种角色

### 2.1 View / Component

- 负责模板、样式、可访问性与事件声明。
- 可以编排一个语义完整的 controller；不得直接调用 service/store。
- 纯展示组件只接收 props/slots 并 emit，不读取 application state。
- 页面/窗口壳可以组合多个 feature 公共入口，但不实现子能力算法。

### 2.2 Controller / composable

- 负责 Vue refs/computed/watch/lifecycle、用例触发和错误呈现状态。
- 通过 application public port 读写应用状态；不得直连 transport/service。
- 一个 controller 可组合多个小 binding，但对 view 暴露按语义分组的模型与命令，避免平铺数十个无归属 ref。
- 若大部分代码是确定性计算，应先抽到 `model/`，而不是继续拆成更多 `useXxx`。

### 2.3 Presenter / model

- 不依赖 Vue、DOM、store、service；输入普通数据，输出展示模型或状态迁移结果。
- feature 私有 presenter 放 feature 的 `model/`；跨 feature 且属于明确领域的放 `domain/<owner>/`。
- 关键分支必须单测。

## 3. SFC 拆分信号

现有 CI 对普通 `.vue` 使用 800 行回归预算，并冻结少量更大的 legacy 例外。预算只防止继续增长，不代表 799 行就是良好设计。

出现以下任一信号必须在 review 中给出保留理由或拆分：

- `<script setup>` 超过 150 行且包含两类以上用例；
- template 超过 200 行或出现 3 层以上交互分支；
- 同时负责 RPC、全局状态写入、DTO 转换和展示布局；
- 一段 UI 在两个位置复用；
- controller 超过约 400 行且仍混有可纯化计算；
- 样式修改与另一子能力完全独立，却共享一个巨型样式块。

优先顺序：抽 presenter/model → 抽稳定子组件 → 收敛 controller 出口 → 最后处理样式。只把 `<style>` 搬到 `.less` 不算职责拆分。

## 4. Props、Emits 与组合

- `defineProps` / `defineEmits` 使用 TypeScript 泛型；复杂契约写简短 JSDoc。
- 默认值使用 `withDefaults`；双向受控值优先 `defineModel`。
- 数据向下、事件向上；禁止 `$parent` / `$root`。
- 跨多层、确属上下文的能力可用带类型 `provide/inject`；不可借此隐藏业务全局状态。
- 多态渲染在分支稳定且可扩展时使用类型化 registry；少量状态/权限条件正常使用 `v-if`，不为消灭条件而制造抽象。
- composable 返回 refs，或返回整体 reactive 对象并要求整体消费/`toRefs`；禁止丢失响应性的解构。

## 5. 状态与异步

- 组件私有瞬时状态用 `ref/reactive`；跨组件的业务状态由所属 owner/application port 提供。
- loading/error/empty 等互斥状态优先判别联合；简单、确实独立的布尔无需强制引入状态机库。
- 仓库当前没有统一 Query 库，不虚构“必须使用 TanStack Query”的门禁。新增缓存策略应先形成项目级基础设施决策，再统一迁移。
- 接口错误是数据/用例错误；渲染生命周期异常是组件异常，两者分别呈现。

## 6. 样式与资源

- 全局 token、主题、reset 放 `src/styles/`；feature/组件专属样式与组件同址。
- 拆出的样式文件使用 `<Component>.styles.less|css` 或 `<Component>.scoped.less`，名称能反查唯一消费者。
- 禁止将局部样式放入全局文件仅为减少 SFC 行数。
- overlay/z-index 使用项目统一 layer token，不在组件内随意竞争常量。

## 7. 可访问性与文案

- 交互元素可键盘操作并有可读名称；表单控件绑定 label；状态不能只靠颜色表达。
- 用户可见文案沿用当前产品语言和术语。仓库尚未建立 i18n 基础设施，在引入资源系统前不以“必须 i18n”制造不可执行门禁；该架构债统一记录在待办台账。
- 错误信息遵守 [错误约定](../error-conventions.md)。

## 8. 性能

- 大列表使用现有虚拟滚动能力；key 必须稳定。
- `defineAsyncComponent`、`v-memo`、缓存和分包只在边界明确或已有测量证据时使用。
- 不在多个组件中重复订阅同一 transport；订阅由 application runtime/canonical owner 统一管理。

## 9. 测试与工具链

- presenter/model：关键状态与边界单测。
- controller：测试用例触发、错误与清理；不依赖真实 store 内部形状。
- component：对关键交互、props/emits 和可访问名称做测试。
- `web/test/architecture/vueSfcSizeBudget.test.ts` 是回归预算；依赖边界由 ESLint 与 `dependencyBoundaries.test.ts` 强制。
- 修改后运行与风险相称的 lint、type-check、Vitest 和 build；不能把“由用户手测”当成跳过静态验证的理由。

## 10. Review 清单

- [ ] 视图是否只组合 controller/presenter，而未直连 store/service？
- [ ] 确定性计算是否已与 Vue 生命周期分开？
- [ ] 状态是否只有一个 owner/入口？
- [ ] 子目录是否代表真实子能力，而非文件数配额？
- [ ] 专属样式是否与唯一消费者同址？
- [ ] 拆分信号是否已处理或有具体理由？
- [ ] 新增交互是否覆盖错误、清理、键盘与可读名称？
