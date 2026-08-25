# 工具渲染器架构

> **源码位置**：[web/src/features/agent/renderers/](../../web/src/features/agent/renderers/)
> **相关文档**：[前端总览](./README.md)｜[Sense 核心概念](../core/sense.md)｜[协议规范](../protocol.md)

## 概述

工具渲染器架构为内置工具提供专用 UI 显示能力，采用**注册表 + 动态组件**模式，实现声明式扩展。

### 设计目标

- **声明式注册**：内置工具一行代码声明专用渲染器
- **动态分发**：用 `<component :is>` 替代硬编码 `v-if`
- **类型共享**：集中定义工具参数类型，消除重复
- **降级保护**：渲染失败时自动回退到通用渲染器

### 架构流程

```
MessageBubble.vue
    ↓
SenseCallRenderer（统一分发入口）
    ↓
RendererRegistry（按工具名查找）
    ├─ update_todo → TodoRenderer.vue（按需加载）
    ├─ execute_command → CommandRenderer.vue（未来）
    └─ 未注册工具 → SenseCallBox.vue（通用降级）
```

---

## 核心概念

### 1. 渲染器注册表

**位置**：[web/src/features/agent/renderers/registry.ts](../../web/src/features/agent/renderers/registry.ts)

管理工具名到渲染器组件的映射：

```typescript
// 注册渲染器
registerRenderer("update_todo", () => import("./TodoRenderer.vue"));

// 获取渲染器（异步，失败返回 null）
const renderer = await getRenderer("update_todo");

// 检查是否已注册（同步）
if (hasRenderer("update_todo")) { ... }
```

### 2. 渲染器组件契约

**位置**：[web/src/features/agent/renderers/types.ts](../../web/src/features/agent/renderers/types.ts)

所有渲染器组件必须遵循统一的 Props 契约：

```typescript
interface RendererProps {
  /** 原始调用记录（含 name/args/result/status） */
  call: SenseCallRecord;
  /** 解析后的参数（类型安全，由分发器预处理） */
  parsedArgs?: unknown;
  /** DOM ID（用于可访问性） */
  id?: string;
}
```

### 3. 统一分发入口

**位置**：[web/src/features/agent/renderers/index.ts](../../web/src/features/agent/renderers/index.ts)

`SenseCallRenderer` 组件负责动态分发：

1. 检查 `call.name` 是否注册专用渲染器
2. 有 → 异步加载专用渲染器
3. 无/失败 → 使用通用 `SenseCallBox`

---

## 内置工具渲染器

### 已实现

| 工具名 | 渲染器 | 功能 | 大小 |
|--------|--------|------|------|
| `update_todo` | [TodoRenderer.vue](../../web/src/features/agent/renderers/TodoRenderer.vue) | 清单样式，状态动画（☐/▣/✓） | 1.61 kB |
| `execute_command` | [CommandRenderer.vue](../../web/src/features/agent/renderers/CommandRenderer.vue) | 命令输出美化，错误高亮，超时提示，命令一键复制 | 3.83 kB |
| `read_file` | [FileReadRenderer.vue](../../web/src/features/agent/renderers/FileReadRenderer.vue) | 文件预览，压缩信息，行数统计 | 2.68 kB |
| `write_file` | [FileWriteRenderer.vue](../../web/src/features/agent/renderers/FileWriteRenderer.vue) | 写入模式，内容预览 | 2.65 kB |
| `generate_image` | [MediaRenderer.vue](../../web/src/features/agent/renderers/MediaRenderer.vue) | 图片/视频/音频预览（共享渲染器） | 2.73 kB |
| `generate_video` | [MediaRenderer.vue](../../web/src/features/agent/renderers/MediaRenderer.vue) | 图片/视频/音频预览（共享渲染器） | - |
| `generate_audio` | [MediaRenderer.vue](../../web/src/features/agent/renderers/MediaRenderer.vue) | 图片/视频/音频预览（共享渲染器） | - |
| `search_codebase` | [SearchRenderer.vue](../../web/src/features/agent/renderers/SearchRenderer.vue) | 搜索结果列表，文件路径高亮 | 2.80 kB |
| `spawn_role` | [SpawnRenderer.vue](../../web/src/features/agent/renderers/SpawnRenderer.vue) | 角色信息卡片，会话「详情」下钻抽屉 | 2.32 kB |
| `skill` | [SkillRenderer.vue](../../web/src/features/agent/renderers/SkillRenderer.vue) | 技能激活卡片，指令预览 | 2.35 kB |

**总计**：10 个内置工具全部实现专用渲染器，平均大小 2.5 kB（gzip 压缩后约 1.2 kB）。

### execute_command 的 result 解析约定

`execute_command` 的 result 是后端 [bash.ts](../../src/agent/sense/bash.ts) `formatBashResult` 生成的**中文 key 自然语言字符串**（非 JSON），供 LLM 阅读工具结果。前端 [CommandRenderer.vue](../../web/src/features/agent/renderers/CommandRenderer.vue) 用正则提取字段——**正则 key 必须与后端中文 key 严格一致**，否则解析失败、status 兜底为 `error`（表现为「永远显示失败」）。

后端输出格式（[bash.ts:27-53](../../src/agent/sense/bash.ts#L27-L53)）：

```text
状态: success | timeout | error
进程ID: <pid>
退出码: <code>          # 可选（无退出码时省略，如 timeout）
执行时长: <ms>ms
日志路径: <path>（详细信息使用 read_file 读取）   # 可选（仅 timeout）
说明: <message>          # 可选（仅 error/timeout）

[输出]
<stdout+stderr 合并>
```

前端正则映射（[CommandRenderer.vue](../../web/src/features/agent/renderers/CommandRenderer.vue)）：

| 字段 | 后端 key | 正则 |
|------|---------|------|
| status | `状态` | `/状态:\s*(\w+)/` |
| pid | `进程ID` | `/进程ID:\s*(\d+)/` |
| exitCode | `退出码` | `/退出码:\s*(\d+)/` |
| duration | `执行时长` | `/执行时长:\s*(\d+)ms/` |
| logPath | `日志路径` | `/日志路径:\s*([^\n]+)/`（剔除尾部「（…）」说明） |
| message | `说明` | `/说明:\s*([^\n]+)/` |
| output | `[输出]` | `/\[输出\]\r?\n([\s\S]*)/` |
| command / description | （后端不输出） | 从 `call.args` 解析 |

> **变更约束**：若调整 `formatBashResult` 的 key 文案或顺序，**必须同步更新本表与 CommandRenderer 正则**。后端 result 面向 LLM，应保持中文自然语言，不应为前端 UI 改为 JSON。

### spawn_role 会话下钻与跨层服务

`spawn_role` 渲染器 [SpawnRenderer.vue](../../web/src/features/agent/renderers/SpawnRenderer.vue) 从 result 提取子 chatId（正则 `/chatId=([a-f0-9-]+)/`），UI **隐藏原始 chatId**、改显「详情」文字链接。点击「详情」→ 打开**新一层抽屉**覆盖当前，展示子 chat 的 direct 历史。

**跨层下发**：渲染器不直接耦合 store，而是经独立管理层 [useHistoryDrawerManager](../../web/src/features/agent/useHistoryDrawerManager.ts)（App 顶层 `provide`、任意后代 `inject`）。`inject(manager).drillChild(chatId)` 即触发下钻——**无需 MessageBubble / SenseCallRenderer 层层 emit 透传**。

**抽屉栈**：管理层维护 `historyDrawerStack`（栈，store uiState 持有，无限层上限 5），每层 z-index 递增（280 + N×10）。[HistoryDrawer.vue](../../web/src/features/agent/HistoryDrawer.vue) 是栈容器（v-for [HistoryDrawerPanel](../../web/src/features/agent/HistoryDrawerPanel.vue) + 单遮罩）；关闭（ESC/遮罩/✕）逐层返回（`closeTop`），下层 panel 已挂载被遮盖、关闭顶层即时显现。

**遮罩实现约束**：单蒙层 `.drawer-overlay.is-top-mask` 只用纯半透明背景 `var(--scrim)`，**禁止加 `backdrop-filter: blur()`**。`backdrop-filter` 要求每帧对遮罩下方整个内容重新采样做模糊；桌面层 pet 运动循环与 Nyxus 粒子持续 rAF 动画，会让抽屉区域每帧强制重绘（DevTools Paint flashing 持续闪烁、元素持续被标记刷新），即使文字内容毫无变化。视觉上纯色遮罩与带 blur 差异很小。

**标题栏会话级联切换**：panel 标题栏原「根会话」+「任务分支」两个下拉已合并为单个 `el-cascader` 两级菜单（仅 pet 直开的 overlay 抽屉显示；`workbench-docked` 模式隐藏全部切换下拉、只显静态标题，分支/会话切换走工作台自身节点树与会话浏览器）。第一级按 `ChatSummary.taskId` 分任务（无 taskId 的会话各自成组，组标签取组内最近会话的时间·预览）；第二级为该任务的分支会话--当前任务用 `getTaskTimeline` 分支摘要（主流程/解释/继续前缀，主流程排前），其他任务退化用 `ChatSummary.branchKind` 前缀（原流程/继续/解释）。`checkStrictly` + `emitPath:false`：点第一级任务节点直接切到其代表会话（当前任务=activeBranch，其他=最近会话），value 恒为 chatId，change 统一 `manager.openRoot(chatId)`。

**工具调用折叠标签**：标题栏操作区提供「折叠工具调用」开关（uiState `senseCallsCollapsed`，内存态，与 `subagentDisplay` 同款）。开启后 MessageBubble 内 `senseCalls` 不再渲染 SenseCallRenderer 列表，改为一行小 tag（工具中文名 + 状态符号）；工具名经 `toSenseNameZh` 映射中文（未收录回退原名）、固定标签默认色，仅状态符号（勾/叉）按执行结果着色（running 琥珀 / done 绿 / error 红）；hover tag 经 `el-popover` 悬浮展示完整渲染器内容（专用渲染器优先、默认展开参数/结果）。展开态 SenseCallBox 的工具名同样走 `toSenseNameZh` 中文。thinking 与正文 content 渲染不受影响；主列表与二层代际列表共用同一开关，虚拟滚动估高感知折叠态。

**消息缓存（预留）**：`loadHistory(chatId)` 当前透传 `store.getHistory`（全量）；`historyCache: Map` 接口已预留，命中逻辑待后续接入——实时对话与缓存的一致性需额外设计（脏标记/版本号），当前不启用，避免陈旧。

---

## 扩展指南

### 为新工具添加专用渲染器

#### 步骤 1：定义参数类型

在 [types.ts](../../web/src/features/agent/renderers/types.ts) 中添加工具参数类型：

```typescript
// 示例：execute_command
export interface ExecuteCommandArgs {
  command: string;
  cwd?: string;
  timeout?: number;
}
```

#### 步骤 2：创建渲染器组件

在 `renderers/` 目录下创建 `.vue` 文件：

```vue
<!-- CommandRenderer.vue -->
<script setup lang="ts">
import { computed } from "vue";
import type { RendererProps, ExecuteCommandArgs } from "./types";

const props = defineProps<RendererProps>();

// 类型安全的参数访问
const args = computed(() => props.parsedArgs as ExecuteCommandArgs);
</script>

<template>
  <div class="command-box">
    <div class="command-head">
      <span class="icon">⚡</span>
      <span class="name">命令执行</span>
    </div>
    <pre class="command-text">{{ args.command }}</pre>
    <!-- 渲染结果、状态等 -->
  </div>
</template>
```

#### 步骤 3：注册渲染器

在 [index.ts](../../web/src/features/agent/renderers/index.ts) 中注册：

```typescript
registerRenderer("execute_command", () => import("./CommandRenderer.vue"));
```

**完成！无需修改 MessageBubble。**

---

## 类型定义

### 工具参数类型

**位置**：[renderers/types.ts](../../web/src/features/agent/renderers/types.ts)

集中定义所有工具的参数类型，供渲染器共享使用：

```typescript
// update_todo
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface UpdateTodoArgs {
  todos: TodoItem[];
}

// execute_command（未来）
export interface ExecuteCommandArgs {
  command: string;
  cwd?: string;
  timeout?: number;
}

// ... 其他工具参数类型
```

### 渲染器 Props 契约

```typescript
export interface RendererProps {
  call: SenseCallRecord;    // 原始调用记录
  parsedArgs?: unknown;     // 解析后的参数（类型安全）
  id?: string;              // DOM ID
}
```

---

## 降级策略

渲染器架构提供三层降级保护：

### 1. 工具未注册

**行为**：`SenseCallRenderer` 检测到工具未注册，直接使用通用 `SenseCallBox`

```typescript
// 快速路径：未注册工具直接用通用渲染器
if (!hasRenderer(props.call.name)) {
  return <SenseCallBox call={props.call} />;
}
```

### 2. 渲染器加载失败

**行为**：异步加载错误时，自动降级到通用渲染器

```typescript
const renderer = await getRenderer(props.call.name);
if (!renderer) {
  // 加载失败，返回 null，由分发器使用通用渲染器
  return <SenseCallBox call={props.call} />;
}
```

### 3. 参数解析失败

**行为**：渲染器内部捕获解析错误，显示原始 JSON

```typescript
try {
  const args = JSON.parse(props.call.args as string);
  // 渲染正常内容
} catch (e) {
  // 降级：显示原始 JSON
  return <pre>{JSON.stringify(props.call.args, null, 2)}</pre>;
}
```

---

## 最佳实践

### 渲染器职责

渲染器**只负责显示**，不处理业务逻辑：

- ✅ 解析参数并渲染 UI
- ✅ 显示工具状态（running/done/error）
- ✅ 提供交互元素（折叠、展开、复制等）
- ✅ 经 `inject` 管理层触发 UI 导航（如 SpawnRenderer「详情」下钻抽屉，见上文「跨层服务」）
- ❌ 不直接修改 store 数据状态（UI 导航经管理层，非数据副作用）
- ❌ 不发送 RPC 请求
- ❌ 不执行业务副作用

### 性能优化

- **按需加载**：渲染器通过动态 `import()` 加载，减少首屏体积
- **快速路径**：未注册工具同步渲染，避免异步开销
- **加载占位**：异步加载期间显示通用渲染器，避免闪烁

### 类型安全

- 使用 `RendererProps` 契约强制类型检查
- 工具参数类型与后端 schema 保持同步（通过文档约定）
- 使用 `computed` 派生类型安全的参数对象

---

## 测试策略

### 单元测试

测试注册表核心逻辑：

```typescript
// renderers/__tests__/registry.test.ts
describe("RendererRegistry", () => {
  it("should register and retrieve renderer", async () => {
    registerRenderer("test_tool", () => import("./TestRenderer.vue"));
    expect(hasRenderer("test_tool")).toBe(true);
    const renderer = await getRenderer("test_tool");
    expect(renderer).toBeDefined();
  });

  it("should handle loader error gracefully", async () => {
    registerRenderer("broken_tool", () => Promise.reject(new Error()));
    const renderer = await getRenderer("broken_tool");
    expect(renderer).toBeNull(); // 降级返回 null
  });
});
```

### 集成测试

验证渲染器在实际消息流中的表现：

```typescript
// renderers/__tests__/integration.test.ts
describe("SenseCallRenderer", () => {
  it("should render todo renderer for update_todo", () => {
    const call = { name: "update_todo", args: '{"todos":[]}' };
    const wrapper = mount(SenseCallRenderer, { props: { call } });
    expect(wrapper.findComponent(TodoRenderer).exists()).toBe(true);
  });

  it("should fallback to SenseCallBox for unregistered tool", () => {
    const call = { name: "unknown_tool", args: "{}" };
    const wrapper = mount(SenseCallRenderer, { props: { call } });
    expect(wrapper.findComponent(SenseCallBox).exists()).toBe(true);
  });
});
```

---

## 常见问题

### Q: MCP 工具可以使用专用渲染器吗？

**A**: 不建议。MCP 工具由第三方提供，命名动态（`mcp__<server>__<tool>`），不适合硬编码渲染器。建议继续使用通用 `SenseCallBox`。

### Q: 自定义工具如何添加专用 UI？

**A**: 自定义工具（`.chery/senses/*.ts`）属于用户扩展，建议通过通用渲染器的参数美化显示，或等待未来提供的自定义渲染器注册机制。

### Q: 如何调试渲染器加载问题？

**A**: 检查浏览器控制台：
- `[RendererRegistry] 渲染器加载失败` - 动态 import 错误
- `[TodoRenderer] args 解析失败` - 参数格式不匹配

---

## 参考文档

- [前端总览](./README.md) - 技术栈与架构
- [Sense 核心概念](../core/sense.md) - 工具定义与监管
- [协议规范](../protocol.md) - 工具调用数据结构
- [交互序列](../interaction.md) - 工具调用完整流程