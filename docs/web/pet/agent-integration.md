# Pet、会话与 Nyxus 集成边界

Pet 系统是会话事实的视觉投影，不是会话状态的第二份缓存。本文件定义 ChatSession、Workspace、PetPresentation 与 Nyxus 的协作方式。

## 数据流

```text
chat.open / timeline / live events
              |
              v
       ChatSessionStore
        |            |
        | selectors  | runtime projection
        v            v
   UI read models  PetPresentationStore
        |            |
        +------> Pet / Workbench / Nyxus

WorkspaceStore ------> active root / dialogs / drawers / windows
```

ChatSession 是主从会话树与 catalog、message、active turn、run、interaction、direct/root subscription cursor、timeline 与 execution read model 的唯一来源。

PetPresentation 只拥有无法从会话推导的视觉状态，例如坐标、速度、拖拽、hover、动作、表情和 ghost 动画。Workspace 只拥有窗口、抽屉、dialog、overlay 和每个 preset 当前选中的 root。

## Active root 投影

同一 preset 可以有多个 root 会话，但桌面上只有一个可见 master Pet。后台 root 的 run 状态不得覆盖当前可见 root 的气泡或动作。

投影规则：

1. 先由 Workspace 的 `activeRootByPreset` 确定可见 root；
2. 再从对应 ChatSession 读取 working、canResume、message 与 interaction；
3. 只有目标 chat 属于当前 active root 时，才更新 master Pet；
4. 子 Pet 使用自身 chat identity，不借用 master root 状态。

切换 active root 不修改 Pet 的稳定 `instanceId` 或初始 `chatId` 身份，只改变当前读取的会话投影。

## 生命周期与恢复

- 启动时先加载 ChatSession catalog，再协调 Pet 实例；
- 运行中恢复使用 `chat.open` 的原子状态和 event fence，不使用 attach/sync replay；
- role 创建/销毁通知只触发 catalog 对账，不作为 Pet 唯一创建/删除命令；
- 删除会话时，先由 ChatSession 驱逐 canonical entity，再由应用 effect 清理视觉实例和 workspace 引用；
- `chat.close` 只释放订阅，不让 Pet 推断 run 已停止。

## Agents facade

`stores/agents` 目前仅用于迁移期兼容：将 ChatSession selector 投影为旧 `streams/historyList` 读模型；提供工具 icon、sense group 等展示元数据；委托 Workspace 和 PetPresentation 执行兼容 action。

它不得绑定 WebSocket，不得保存 canonical message/run/interaction/catalog，也不得成为 feature 新依赖。新增用例应进入 chat、workspace 或 pets application port。

## Nyxus host port

Nyxus 内部只依赖 `NyxusHostPort`。`features/pets/nyxus/application/host.ts` 是唯一允许把应用 store/ports 适配给 Nyxus 的文件。

禁止在 Nyxus 的 component、composable、graph 或 presenter 内 import `@/stores`、调用 `agentApi`、创建私有 WebSocket、猜测 subscription cursor，或修改 ChatSession reducer 数据。

Nyxus 对宿主只暴露组件、props/events 与公共 controller 类型。图布局、节点详情、execution projection 保持纯函数，以便使用 fixture 单测。

## UI 消费规则

- Feature 从 `@/application/public` 或更窄端口获取 store/use case；
- 消息与执行展示优先消费 selector/read model，不在组件内合并会话树；
- controller 只保留交互编排和 Vue binding；复杂布局、分组、上下文拆解下沉为纯 presenter；
- 不从 Pet 字段反向写回会话事实；
- 不根据 UI 是否可见决定 transport ownership，订阅由 application runtime 和 ChatSession 管理。

架构边界由 ESLint 与 `web/test/architecture/dependencyBoundaries.test.ts` 锁定；active-root Pet 投影由 `web/test/agents/presetWorkspaceFocus.test.ts` 覆盖。
