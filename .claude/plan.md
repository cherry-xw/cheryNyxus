# web/test 重组：按功能模块收纳 + 去 CP 命名

## 目标
1. web/test/ 下 31 个 `.test.ts` 从平铺改为按功能模块分文件夹。
2. 文件名中的 `cpN` 前缀去掉，改为与功能点/模块关联的名称。
3. describe/it 文案中的 `CPN` 标签同步去掉。
4. 同步更新所有引用（package.json 脚本路径、docs 路径）。

## 分类方案（对齐 src 模块边界）

```
web/test/
├── nyxus/
│   ├── graph/            # features/pets/nyxus/graph/*（投影/布局/fold/termination/CRT/popover/skin/toolBatch）
│   │   ├── executionGraph.test.ts            （不动）
│   │   ├── executionGraphFixtures.test.ts    （不动）
│   │   ├── graphLayout.test.ts               ← cp4Layout
│   │   ├── inputState.test.ts                ← cp5InputState
│   │   ├── toolBatch.test.ts                 ← cp6ToolBatch
│   │   ├── fold.test.ts                      ← cp7Fold
│   │   ├── termination.test.ts               ← cp8Termination
│   │   ├── anchoredCrt.test.ts               ← cp9AnchoredCrt
│   │   ├── performanceRecovery.test.ts       ← cp10PerformanceRecovery
│   │   ├── knownFailures.test.ts             ← cp0KnownFailures
│   │   └── nodeHoverDetails.test.ts          （不动；测 nodeSkins）
│   └── canvas/           # features/pets/nyxus/composables/*（tree canvas/浮动面板/点击/钢琴键/节点交互）
│       ├── treeCanvas.test.ts                （不动）
│       ├── floatingPanel.test.ts             （不动）
│       ├── clickDisambiguator.test.ts        （不动）
│       ├── pianoNotes.test.ts                （不动）
│       └── nodeInteraction.test.ts           （不动；测 composables/nodeInteraction）
├── agents/               # stores/agents/*（stream/history/approval/question/pet 生命周期/ghost）
│   ├── approvalQueue.test.ts                 （不动）
│   ├── compactHistory.test.ts                （不动）
│   ├── ghostStreamTermination.test.ts        （不动）
│   ├── historyApprovalRegression.test.ts     （不动）
│   ├── historyLoadingAndGhost.test.ts        （不动）
│   ├── historyRendering.test.ts              （不动）
│   ├── streamAccumulator.test.ts             （不动）
│   ├── questionBatch.test.ts                 （不动）
│   └── petLifecycle.test.ts                  （不动；测 stores/agents/data/petLifecycle）
├── chats/                # stores/chats/* + services/ws（root timeline/sessions/按需加载/ws）
│   ├── rootTimeline.test.ts                  （不动）
│   ├── rootTimelineStore.test.ts             （不动）
│   ├── chatRunRecovery.test.ts               （不动）
│   ├── wsRootSubscription.test.ts            （不动）
│   └── nyxusDemandLoading.test.ts            （不动；契约测试，读 chats store 源码）
└── styles/
    └── overlayLayers.test.ts                 （不动；测 styles/overlayLayers）
```

计数：nyxus/graph=11、nyxus/canvas=5、agents=9、chats=5、styles=1，合计 31。

### 为什么这么分
- 对齐 src 真实目录：`nyxus/graph` ↔ `features/pets/nyxus/graph/`，`nyxus/canvas` ↔ `features/pets/nyxus/composables/`，`agents` ↔ `stores/agents/`，`chats` ↔ `stores/chats/` + `services/ws`，`styles` ↔ `src/styles/`。
- `nyxus/graph` 11 个文件偏多但镜像 src `graph/`（13 文件），按子关注点再拆会主观且易错，保持一层。如需可后续拆 projection/layout/interaction。
- 不新建 `pet/`：pianoNotes→canvas、petLifecycle→agents、nyxusDemandLoading→chats，无纯 `features/pets/*` 独占测试。

## 改名映射（去 cpN 前缀，保留描述性后缀）

| 旧名 | 新名 | 文件夹 |
|------|------|--------|
| cp0KnownFailures | knownFailures | nyxus/graph |
| cp4Layout | graphLayout | nyxus/graph |
| cp5InputState | inputState | nyxus/graph |
| cp6ToolBatch | toolBatch | nyxus/graph |
| cp7Fold | fold | nyxus/graph |
| cp8Termination | termination | nyxus/graph |
| cp9AnchoredCrt | anchoredCrt | nyxus/graph |
| cp10PerformanceRecovery | performanceRecovery | nyxus/graph |

其余 23 个文件名本身已与功能关联，仅移动位置、不改名。

## describe/it 文案去 CP 标签

| 文件 | 旧 | 新 |
|------|----|----|
| knownFailures | `CP0 known failures` | `known failures` |
| graphLayout | `CP4 execution layout and edge geometry` | `execution layout and edge geometry` |
| graphLayout (it) | `...redacted real CP0 capture...` | `...redacted real baseline capture...` |
| inputState | `CP5 main input state machine` / `CP5 real recovery fixture` | `main input state machine` / `real recovery fixture` |
| toolBatch | `CP6 tool batch detail projection` / `CP6 topology and real fixture` | `tool batch detail projection` / `tool batch topology and real fixture` |
| fold | `CP7 Agent-local Fold projection` | `agent-local fold projection` |
| termination | `CP8 termination presentation` | `termination presentation` |
| anchoredCrt | `CP9 anchored CRT model` / `CP9 CRT collision layout` | `anchored CRT model` / `CRT collision layout` |
| performanceRecovery | `CP10 performance and recovery boundaries` | `performance and recovery boundaries` |
| executionGraph | `CP3 execution graph projector` | `execution graph projector` |
| executionGraphFixtures | `CP3 topology fixtures` / it `...real legacy CP0 capture` | `execution graph topology fixtures` / `...real legacy baseline capture` |
| treeCanvas | `CP3 tree canvas long-content behavior` | `tree canvas long-content behavior` |
| floatingPanel | `CP4 floating piano bounds` | `floating piano bounds` |
| overlayLayers | `CP1 overlay layer contract` | `overlay layer contract` |
| rootTimeline | `RootTimelineStore CP1` | `RootTimelineStore` |

## import 路径深度修正（关键）

所有测试当前用 `'../src/...'`（= web/src）。移动后按新深度改：

- `nyxus/graph/` 与 `nyxus/canvas/`（离 web/ 三层）：`'../src/` → `'../../../src/`
- `agents/`、`chats/`、`styles/`（离 web/ 两层）：`'../src/` → `'../../src/`

实现：`git mv` 后对每个文件按目标深度跑 sed：
- 深度 2：`s|'\.\./src/|'../../src/|g`
- 深度 3：`s|'\.\./src/|'../../../src/|g`

该模式同时命中 `from '../src/...'` 与 `historyApprovalRegression` 里的 `new URL('../src/...')`（移到 agents/，深度 2，正确）。

### 不受影响
- `resolve('test/fixtures/...')`：cwd 相对（非文件相对），移动文件不改 cwd，路径不变。
- 无跨测试文件 import；无 `@/` 别名 import；无双引号 `../src` import。

## package.json 脚本路径更新

**保留 `test:cp0`…`test:cp10` 脚本 key**（checkpoint 验证工作流，docs/plan/cpN.md + maintenance.md 引用），仅更新其中 web/test 文件路径：

| 旧路径 | 新路径 |
|--------|--------|
| web/test/cp0KnownFailures.test.ts | web/test/nyxus/graph/knownFailures.test.ts |
| web/test/cp4Layout.test.ts | web/test/nyxus/graph/graphLayout.test.ts |
| web/test/cp5InputState.test.ts | web/test/nyxus/graph/inputState.test.ts |
| web/test/cp6ToolBatch.test.ts | web/test/nyxus/graph/toolBatch.test.ts |
| web/test/cp7Fold.test.ts | web/test/nyxus/graph/fold.test.ts |
| web/test/cp8Termination.test.ts | web/test/nyxus/graph/termination.test.ts |
| web/test/cp9AnchoredCrt.test.ts | web/test/nyxus/graph/anchoredCrt.test.ts |
| web/test/cp10PerformanceRecovery.test.ts | web/test/nyxus/graph/performanceRecovery.test.ts |
| web/test/executionGraph.test.ts | web/test/nyxus/graph/executionGraph.test.ts |
| web/test/executionGraphFixtures.test.ts | web/test/nyxus/graph/executionGraphFixtures.test.ts |
| web/test/treeCanvas.test.ts | web/test/nyxus/canvas/treeCanvas.test.ts |
| web/test/floatingPanel.test.ts | web/test/nyxus/canvas/floatingPanel.test.ts |
| web/test/overlayLayers.test.ts | web/test/styles/overlayLayers.test.ts |
| web/test/rootTimeline.test.ts | web/test/chats/rootTimeline.test.ts |
| web/test/rootTimelineStore.test.ts | web/test/chats/rootTimelineStore.test.ts |
| web/test/chatRunRecovery.test.ts | web/test/chats/chatRunRecovery.test.ts |

未被脚本引用的 15 个文件仍照常移动+改 import。

## docs 更新
- `docs/web/pet/nexus-node-tree-maintenance.md:13`：`web/test/cp10PerformanceRecovery.test.ts` → `web/test/nyxus/graph/performanceRecovery.test.ts`。
- `docs/web/frontend-protocol-binding.md:401`：`web/test/ 已有 streamAccumulator/approvalQueue/historyRendering` → `web/test/agents/ 已有 ...`。
- maintenance.md:29 的 `pnpm test:cp2/cp3/cp10` 是脚本 key，保留不动。
- `.claude/plan.md`（上一任务历史记录）：不改，留作记录。

## 执行步骤
1. `mkdir -p web/test/{nyxus/graph,nyxus/canvas,agents,chats,styles}`
2. 对 31 个文件逐一 `git mv` 到目标位置（含改名）。
3. 按深度跑 sed 修 `'../src/` import。
4. sed 改 describe/it 文案去 CP 标签。
5. Edit `package.json` 16 处路径。
6. Edit 2 个 docs 路径。
7. 验证：grep 确认无残留 `cpN` 文件名、无错误 `'../src/`（深度 2/3 文件夹内不应再有 `'../src/`）、无残留 `CP[0-9]` describe 文案。

## 验证（交用户）
按 memory「前端验证交给用户」，不跑 vitest/vue-tsc。改完码即止，用户自验 `pnpm test:cpN` 仍可定位文件。
