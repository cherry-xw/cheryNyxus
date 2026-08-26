# 前端架构边界与重构交接

本文描述当前前端已经落地的 owner、迁移状态和后续工作。强制目录与依赖规则以 [Web 前端架构与目录规范](../standards/web-frontend-architecture.md) 为唯一来源；本文不重复定义另一套规范。

## 1. 架构目标

前端采用“有边界的渐进重构”，核心不是控制单文件或单目录数量，而是确保：

- 每类业务事实只有一个 canonical owner；
- 依赖只能沿规定方向流动；
- UI 只依赖稳定的 application public port；
- DTO、领域变换和 Vue binding 分离；
- 纯模块可以脱离 Vue、Pinia 和 WebSocket 单测；
- 协议变更在 `@chery/protocol` 统一定义，Web 与服务端不各自复制契约。

## 2. 依赖方向

```text
features (Vue UI / controller)
        |
        v
application public ports  <----  composition root / runtime adapters
        |
        v
stores (state ownership + orchestration) ----> domain (pure reducer / projection)
        |
        v
services (RPC / HTTP adapters) ----> @chery/protocol ----> WebSocket transport
```

硬约束：

- `domain/**` 不得依赖 Vue、Pinia、store、service 或 feature；
- `services/**` 不得依赖 store、feature 或 application，认证等运行时状态由 composition root 注入；
- `stores/**` 不得依赖 feature；
- `stores/chats/**` 不得依赖 `stores/agents/**`；
- 普通 feature 不得直接 import `@/stores` 或 `@/services`；
- Nyxus 内部不得访问 store，只能通过它的 host adapter；
- service 负责协议调用，不负责 UI 状态和领域归并；
- store 负责状态所有权与用例编排，不内联协议 DTO 映射算法。

这些规则同时由 ESLint 和 `web/test/architecture/dependencyBoundaries.test.ts` 强制，不能只靠评审约定。

## 3. 状态所有权

| Owner | 唯一拥有的状态 | 不得拥有 |
| --- | --- | --- |
| `ChatSession` | catalog、消息、run、interaction、direct/root subscription、timeline projection cache | Pet 坐标动画、窗口/抽屉状态 |
| `Workspace` | dialog、drawer、workbench window、active root、overlay 与窗口布局 | 会话消息、run、Pet 动画 |
| `PetPresentation` | Pet 实例、位置、动作、表情、ghost/动画状态 | 会话事实、审批、问题、runtime |
| `agents` facade | 工具展示元数据与迁移期兼容方法 | canonical catalog、消息、run、interaction、subscription |

`agents` 是兼容 facade，不是第二个领域 store。新代码不得向它增加会话状态；现有兼容调用应逐步迁往 chat、workspace、pets application ports，最终删除 facade。

## 4. 会话协议与生命周期

canonical 命令面：

- `chat.input.submit`：幂等提交输入并立即确认；run 输出与 RPC 生命周期分离；
- `chat.run.resume`：使用稳定 `commandId` 恢复暂停 run；
- `chat.abort` / tree control：显式控制运行状态。

canonical 查询与订阅面：

- `chat.list`：轻量 catalog；
- `chat.open`：原子建立 direct/root subscription，并返回同一水位的运行快照；
- `chat.timeline.get`：按 revision 获取权威 timeline；
- `chat.close`：释放观察者，不改变 Agent 生命周期。

`chat.send`、`chat.resume`、`chat.get`、`chat.sync`、`chat.attach`、`chat.startSpawn` 和 `chat.sendToChild` 不再作为外部 WebSocket RPC 注册。前端也不得重新引入这些 client wrapper。

启动与重连由 `application/runtime/startApplicationRuntime.ts` 统一编排：

1. ChatSession 绑定唯一 transport consumer；
2. 加载轻量 catalog；
3. 对需要恢复实时展示的运行中会话执行原子 `chat.open`；
4. PetPresentation 从 ChatSession 投影视觉实例；
5. 断线后以最后确认的 revision/event sequence 重新 `chat.open`，不走 attach + sync replay。

## 5. 公开端口

Feature 只能从 `web/src/application/public.ts` 或更窄的子端口导入应用能力。公开端口可以暴露用例 action、稳定 selector/read model、只读类型以及明确的 host/controller adapter。

公开端口不得暴露 `data/**`、reducer 内部 helper 或协议游标。端口的存在不代表可以无限制暴露整个 store；迁移期 backend/transport facade 的删除条件记录在 `docs/architecture-issues.md`，后续应持续收窄为面向用例的接口。

## 6. Nyxus 边界

Nyxus 是独立有界上下文。它的唯一外部入口是：

- `features/pets/nyxus/public.ts`：对宿主暴露组件与公共类型；
- `features/pets/nyxus/application/host.ts`：把 application ports 适配成 NyxusHostPort。

Nyxus component、graph、composable 和 presenter 不能 import store。测试、Story 或其他宿主应注入 host port，而不是 mock store 内部结构。

## 7. 拆分判据

不再使用“每文件夹不超过 5 个文件”作为架构规则。目录与文件按状态 owner、依赖方向、纯 presenter 与 Vue binding、public API 与 internal implementation、独立变化和测试单元来拆分。

大 composable 的首选拆法是先抽取纯 presenter/read model，再保留薄 Vue binding。按函数数量或页面区域机械切分只能作为最后的可读性整理。

当前目录角色、feature 子切片、store 内部 `model/read-model/bindings` 结构及依赖矩阵不在本文重复维护，统一见 [目录规范](../standards/web-frontend-architecture.md)。

## 8. 变更门禁

架构改动至少验证：

```powershell
pnpm type-check
pnpm --filter web type-check
pnpm test -- --root web test/architecture test/chats
pnpm --filter web build
```

涉及纯 domain/read model 时增加对应单测；涉及状态 owner 时必须覆盖重连、快照替换、乱序/重复事件与 active-root 投影。格式化只处理本次改动文件，避免覆盖工作树中无关的 UI 修改。

## 9. 完成定义

一次架构迁移只有在以下条件同时满足时才完成：旧入口不再被生产代码调用且不再对外注册；canonical owner 是唯一写入者；feature 通过公开端口消费能力；纯逻辑已从框架与 transport 解耦；lint、架构测试和类型检查能阻止边界回潮；文档描述当前实现而不是过渡期双轨方案。
