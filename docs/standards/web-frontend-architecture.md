# Web 前端架构与目录规范 v1.0

> **状态**：强制执行。  
> **适用范围**：`web/src/**`、相关前端测试与前端架构文档。  
> **目标**：目录表达职责，依赖表达边界；不使用文件数量制造伪架构。

## 1. 判定顺序

设计或移动文件时按以下顺序判断，前一项优先于后一项：

1. 谁是这份状态或业务事实的唯一 owner；
2. 该文件允许依赖哪些层；
3. 它是纯模型、用例编排、框架 binding、基础设施还是 UI；
4. 它与哪些文件沿同一变更轴变化；
5. 最后才考虑文件长度、目录文件数和视觉整齐。

“每文件夹不超过 5 个文件”不是规则。一个拥有 16 个高内聚纯图算法的 `graph/`，通常比被机械拆成 4 个无业务意义子目录更合理。

## 2. 顶层目录契约

```text
web/src/
├── application/   # 稳定用例端口、composition root、宿主 adapter
├── domain/        # 无 Vue/Pinia/浏览器 I/O 的领域模型、reducer、projection、算法
├── services/      # WebSocket/HTTP/Electron 等基础设施 adapter 与协议调用
├── stores/        # Pinia 状态 owner 与用例编排
├── features/      # 按用户能力垂直切分的 UI、controller、局部 presenter
├── components/    # 跨 feature、无业务 owner 的共享展示组件
├── composables/   # 跨 feature 的通用 Vue binding；业务 composable 留在所属 feature
├── utils/         # 无框架、无业务语义的通用函数
├── styles/        # 全局 token/reset/theme；组件样式与组件同址
└── assets/        # 构建期静态资源
```

### 2.1 `application/`

- `*/public.ts` 是 feature 可依赖的稳定公开面；按 chat、pets、shell、backend 等能力收窄。
- `runtime/` 是 composition root，可同时接触 store 与 service，负责订阅绑定和依赖注入。
- application port 暴露用例、只读 selector/read model、稳定类型或明确的 host adapter；不得泄漏 reducer helper、store data 目录与协议游标。
- 迁移期可用兼容 port 隔离旧 service/store，但必须在 port 文件与待办台账登记删除条件，不得把兼容 facade 当成最终设计。

### 2.2 `domain/`

- 只放确定性、可独立测试的业务模型和算法；允许依赖同层模块及 `@chery/protocol` 的纯类型/常量。
- 禁止依赖 Vue、Pinia、store、service、application、feature、DOM 和 Electron。
- 目录按领域 owner 分组，例如 `domain/chat/`、`domain/pets/`；算法因被两个上层消费者复用而进入 domain，不因“看起来像工具”进入 `utils/`。

### 2.3 `services/`

- 负责 transport、RPC/HTTP/native adapter 和 DTO 边界，不拥有 UI/业务状态。
- 禁止依赖 store、feature 和 application；运行时凭证等状态通过 composition root 注入只读 port。
- service 返回协议 DTO；DTO 到领域模型的确定性映射放 domain 或 store 的 `model/`，不内联在 I/O adapter。

### 2.4 `stores/`

- 每类 canonical state 只有一个 owner；其他 store 只能调用公开 action/selector，不复制状态。
- store 可依赖 domain 与 service；禁止依赖 feature。兼容 facade 不得成为第二写入者。
- store 根目录保留 `index.ts`（owner/action 编排）和必要的公开类型。内部按真实职责使用：

```text
stores/<owner>/
├── index.ts       # Pinia owner 与 action 编排
├── types.ts       # owner 状态契约
├── model/         # 与该 owner 数据结构紧密耦合的纯 reducer/hydration
├── read-model/    # selector、projection、timing
└── bindings/      # 极少量 Vue/store binding
```

不是每个 owner 都必须创建所有子目录；只有出现第二个独立职责/变更轴时才创建。

### 2.5 `features/`

- 第一层按用户可识别的能力或有界上下文组织，不按技术类型组织整个应用。
- feature 只能依赖 application public port、domain、通用 components/composables/utils 和同 feature 内模块；禁止直连 store/service。
- 跨 feature 使用必须经被依赖 feature 的 `public.ts`；禁止穿透其内部目录。暂未建立 public surface 的存量引用须在触碰时迁移。
- 大 feature 内按子能力切片。推荐的可选角色如下，不要求凑齐：

```text
features/<context>/<capability>/
├── public.ts          # 确有外部消费者时才建
├── XxxView.vue        # 视图/布局
├── useXxxController.ts
├── model/             # feature 私有纯 presenter/read model
├── components/        # 该能力的展示部件
└── *.styles.less      # 与唯一消费组件同址并同名
```

`components/`、`composables/`、`graph/` 可以有较多文件，只要它们同属一个语义、依赖一致、共同变化。禁止仅为降低 direct-file count 创建 `part1/`、`misc/`、`common2/`。

### 2.6 共享目录

- `components/` 中的组件不得知道 Agent、Chat、Pet 等业务 owner，也不得访问 store/service。
- `composables/` 只放跨 feature 的 Vue 技术 binding；业务 controller 留在 feature。
- `utils/` 必须无 Vue、Pinia、I/O 和领域 owner 语义。
- 全局样式只放 token、主题、reset、跨应用 overlay layer；单组件样式同址。

## 3. 依赖矩阵

`✓` 表示允许，`port` 表示只能经公开面，空白表示禁止。

| from \ to | application | domain | services | stores | features | shared UI/utils |
| --- | --- | --- | --- | --- | --- | --- |
| application public/runtime | — | ✓ | runtime | ✓ | host adapter | ✓ |
| domain |  | ✓ |  |  |  | 仅纯 utils |
| services |  | ✓ | ✓ |  |  | 仅纯 utils |
| stores |  | ✓ | ✓ | 同层公开 action |  | ✓ |
| features | port | ✓ |  |  | `public.ts` | ✓ |
| shared UI/utils |  |  |  |  |  | ✓ |

当前强制方向：

```text
features -> application ports -> stores -> services -> transport
     \-----------> domain <---------/
application runtime = 组装上述依赖的唯一例外
```

## 4. 公开面与导入

- 跨边界使用绝对别名；同一内聚目录内部使用相对导入。
- `public.ts` 只列经过承诺的出口；`index.ts` 默认是内部聚合，不自动等于公共 API。
- 禁止 `export *` 把完整 store/service 暴露给 feature。迁移 facade 只能显式列出成员。
- 类型应从其语义 owner 导出，不从偶然定义它的 transport 文件导出。
- 发生循环依赖时先检查 owner 是否错误，不用动态 import 或 barrel 绕过。

## 5. 拆分与合并信号

以下是 review 信号，不是机械阈值：

- 文件同时包含 I/O、状态写入、DTO 映射和展示计算；
- 一个目录混入两种不同依赖权限；
- 修改一个能力经常需要打开另一个无关能力目录；
- controller/composable 难以脱离 Vue 测试，且其中存在可确定计算；
- 同一文件被两个状态 owner 写入或映射；
- 名称只能使用 `misc`、`helpers2`、`common` 才能容纳内容。

处理顺序：先抽纯 model/presenter，再收窄公开面，再移动目录，最后才按可读性拆函数。样式拆出不等于职责拆分。

## 6. 测试目录

- `web/test/architecture/` 验证依赖与结构门禁；不得以源码字符串快照替代全部行为测试。
- 领域算法测试按领域/能力分组；UI 测试按用户能力分组。测试目录无需逐文件镜像源码路径。
- 移动文件必须同步测试导入；纯移动不得借机修改行为断言。

## 7. 机器门禁

可静态判断的规则必须同时落在 `web/eslint.config.js` 与 `web/test/architecture/dependencyBoundaries.test.ts`。至少覆盖：

- domain 不依赖框架和上层；
- services 不依赖 stores/features/application；
- stores 不依赖 features；
- features 不依赖 stores/services；
- Nyxus 仅 host adapter 可组装 application/store；
- canonical chat owner 不依赖 agents 兼容 facade。

验证命令见 [前端架构交接](../web/frontend-refactor-handoff.md#变更门禁)。

## 8. 存量迁移规则

- 新文件立即遵守；存量文件在本次任务触碰其职责或导入边界时一并整改。
- 无法在同一低风险重构中完成的事项，必须同时满足：代码最近边界有 `TODO(architecture)`、`docs/architecture-issues.md` 有 owner/完成条件、lint 不能因此放宽到整个目录。
- TODO 不允许只写“以后优化”；必须说明当前风险与删除条件。
