# Drain 日志模板挖掘

> 源码 [src/utils/drain/](../../src/utils/drain/) ｜ 上级 [./README.md](./README.md) ｜ 相关 [./logger.md](./logger.md) ｜ [../README.md](../../src/agent/sense/read.ts)（消费方）

## 职责

实现 **Drain 算法**（经典日志模板挖掘算法，[Drain: An Online Log Parsing Approach with Fixed Depth Tree](https://jiemingzhu.github.io/pub/drain_IWSC2017.pdf)）：

- 输入：一坨原始日志行。
- 输出：每行归类到一个「**模板**」（token 序列，可变部分用通配 `<*>` 表示），如 `"User <*> logged in from <*>:<*>"`。

在 cheryClaw 中的**唯一消费场景**：[`agent/sense/read.ts`](../../src/agent/sense/read.ts) 读取大日志文件时，若 `compression: "drain"`（或 `auto` 且判定为日志），调用本模块导出的 `compressLog()` 把海量重复日志行归纳成「模板摘要 + 前若干实例」，大幅缩减喂给 LLM 的 token 数。

> 这是一个自包含、零业务依赖的纯算法模块（除 drainBase.ts 内部用 logger 打印调试树）。可独立测试、独立复用。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [types.ts](../../src/utils/drain/types.ts) | 全部 interface/type 定义：`LogClusterInterface` / `NodeInterface` / `Serialized*` / `DrainState` / `ChangeType` / `TemplateMinerResult` / `DrainResult` |
| [node.ts](../../src/utils/drain/node.ts) | `LogCluster`（日志簇）+ `Node`（前缀树节点）两个实现 class |
| [drainBase.ts](../../src/utils/drain/drainBase.ts) | `DrainBase` 抽象基类：前缀树管理、token 化、`addLogMessage` 主流程、`fastMatch`、LRU 簇缓存、`NullProfiler`；定义 `DrainUpdateType` 枚举与 `Profiler` 接口 |
| [drain.ts](../../src/utils/drain/drain.ts) | `Drain extends DrainBase`：实现 `treeSearch` / `addSeqToPrefixTree` / `getSeqDistance` / `createTemplate` / `match` 五个抽象方法（核心算法） |
| [templateMinerConfig.ts](../../src/utils/drain/templateMinerConfig.ts) | `TemplateMinerConfig` + `TemplateMinerOptions`：Drain 超参 + 快照配置；含 `fromObject()` 静态工厂 |
| [templateMiner.ts](../../src/utils/drain/templateMiner.ts) | `TemplateMiner`：封装 `Drain` 的高层门面，含预处理、快照持久化（gzip）、`initialize/addLogMessage/getTemplate/saveSnapshot/close` |
| [persistenceHandler.ts](../../src/utils/drain/persistenceHandler.ts) | `PersistenceHandler` 抽象类：`save/load/close/delete` 四方法 |
| [inMemoryPersistence.ts](../../src/utils/drain/inMemoryPersistence.ts) | `InMemoryPersistenceHandler extends PersistenceHandler`：内存 + `structuredClone` 深拷贝的实现 |
| [index.ts](../../src/utils/drain/index.ts) | 导出 + 对外简化入口 `compressLog(content, previewCount)` |

## 核心概念 / 导出

### 数据结构

```ts
// types.ts
interface LogClusterInterface { id: number; template: string[]; size: number; }
interface NodeInterface { children: Map<string, NodeInterface>; clusterIds: number[]; }

// 序列化形态（快照用）
interface SerializedCluster { id: number; template: string[]; size: number; }
interface SerializedNode   { keyToChildNode: Record<string, SerializedNode>; clusterIds: number[]; }
interface DrainState       { clusters: SerializedCluster[]; idToCluster: Record<number, SerializedCluster>; rootNode: SerializedNode; clusterId: number; }

type  ChangeType = "none" | "created" | "updated";
interface TemplateMinerResult { logCluster: LogClusterInterface; isNewTemplate: boolean; changeType: ChangeType; processingTime: number; }
interface DrainResult { compressedContent: string; templateCount: number; lineCount: number; compressionRatio: string; }
```

### 实现类

```ts
// node.ts
class LogCluster implements LogClusterInterface { id; size; template; constructor(templateTokens, id) }
class Node       implements NodeInterface       { children = new Map(); clusterIds = [] }

// drainBase.ts
enum DrainUpdateType { CLUSTER_CREATED, CLUSTER_TEMPLATE_CHANGED, NONE }
abstract class DrainBase {
  // 构造参数（默认值见下表）
  constructor(depth=4, simTh=0.4, maxChildren=100, maxClusters=null, extraDelimiters=[], profiler=NullProfiler, paramStr="<*>", parametrizeNumericTokens=true)
  // 公开
  addLogMessage(content): [LogClusterInterface, DrainUpdateType]  // 主入口
  get clusters(): LogClusterInterface[]
  fastMatch(clusterIds, tokens, simTh, includeParams): LogClusterInterface | null
  getTotalClusterSize(): number
  getClustersIdsForSeqLen(seqFirst): number[]
  printTree(file?, maxClusters=5): void
  static hasNumbers(value: Iterable<string>): boolean
  // 抽象（由 Drain 实现）
  abstract treeSearch(...); abstract addSeqToPrefixTree(...); abstract getSeqDistance(...); abstract createTemplate(...); abstract match(...)
}
class NullProfiler implements Profiler { startSection(){}; endSection(){} }  // no-op 计时器

// drain.ts
class Drain extends DrainBase { /* 实现 5 个抽象方法 */ }

// templateMinerConfig.ts
class TemplateMinerConfig {
  drainSimTh: number;              // 相似度阈值，默认 0.4
  drainDepth: number;              // 树深度，默认 4（最少 3）
  drainMaxChildren: number;        // 内部节点最大子节点数，默认 100
  drainMaxClusters: number | null; // 簇上限，null=无限，默认 null
  drainExtraDelimiters: string[];  // 额外分词符，默认 []
  parametrizeNumericTokens: boolean; // 含数字 token 是否当参数，默认 true
  snapshotIntervalMinutes: number; // 快照间隔（分钟），默认 1
  snapshotCompressState: boolean;  // 快照 gzip+base64，默认 true
  static fromObject(obj): TemplateMinerConfig;
}

// templateMiner.ts
class TemplateMiner {
  constructor(config?: TemplateMinerConfig, persistence?: PersistenceHandler)
  initialize(): Promise<void>                  // 从持久化加载快照
  addLogMessage(logMessage): Promise<TemplateMinerResult>
  getTemplate(logMessage): string | null       // 仅匹配不创建
  getClusters(): LogClusterInterface[]
  getClusterById(id): LogClusterInterface | null
  clusterCount(): number
  saveSnapshot(): Promise<void>                // 强制立即快照
  close(): Promise<void>                       // 保存 + 关闭持久化
  deleteState(): Promise<void>
}

// 持久化
abstract class PersistenceHandler { abstract save(state:string); abstract load(): Promise<string|null>; abstract close(); abstract delete() }
class    InMemoryPersistenceHandler extends PersistenceHandler { /* structuredClone 深拷贝 */ }
```

### 对外简化入口（唯一被 read.ts 调用的 API）

```ts
// index.ts
export async function compressLog(content: string, previewCount?: number): Promise<DrainResult>;
// 默认 previewCount=3；内部 new TemplateMiner → 逐行 addLogMessage → 模板分组 → 渲染摘要文本
```

## 关键流程 / 数据流

### Drain 算法核心思路

Drain 用一棵**固定深度前缀树**加速日志分组：

```
root (depth 0)
└─ <L=N>           (depth 1, 按 token 数分桶)
   └─ <token>      (depth 2..maxNodeDepth, 按前几段 token 路由；含数字 token 归并到 <*>)
      └─ clusterIds: [7, 12, ...]   (叶子节点挂簇 ID 列表)
```

参数关系：`logClusterDepth = depth`（构造入参），`maxNodeDepth = depth - 2`。depth 至少 3（root / token 数桶 / 至少一层 token 节点）。

**新增一条日志 `addLogMessage(content)` 主流程**（[drainBase.ts](../../src/utils/drain/drainBase.ts#L265-L317)）：

1. **token 化** `getContentAsTokens(content)`：先 trim，再按 `extraDelimiters` 拆分替换为空格，最后按 `\s+` 切分过滤空串。
2. **树搜** `treeSearch(rootNode, tokens, simTh, includeParams=false)`（[drain.ts](../../src/utils/drain/drain.ts#L9-L52)）：
   - 按 `tokens.length` 进入第一层桶 `<L=N>`；不存在则返回 null。
   - 逐 token 向下走：先尝试精确 token 子节点，回落到通配 `<*>` 子节点；到 `maxNodeDepth` 或 token 用尽停止。
   - 在到达节点的 `clusterIds` 上调 `fastMatch`，选 `getSeqDistance` 相似度最高（并列时参数多的优先）且 `≥ simTh` 的簇；否则 null。
3. **创建或合并**：
   - **未匹配**：`clustersCounter++`，`new LogCluster(tokens, id)`，存入 `idToCluster`，调 `addSeqToPrefixTree` 把模板路径插入树（含数字 token 时自动归并到 `<*>` 节点，控制 `maxChildren` 上限），返回 `CLUSTER_CREATED`。
   - **已匹配**：用 `createTemplate` 逐 token 比较，相同保留、不同替换为 `<*>`，得新模板。
     - 与旧模板全等 → `NONE`。
     - 不同 → 覆盖 `cluster.template`，返回 `CLUSTER_TEMPLATE_CHANGED`。
   - `cluster.size += 1`；若启用 `maxClusters`，通过 `idToCluster.get(id)` 触发 LRU touch（依赖 `LogClusterCache.get()` 的 delete+set 副作用更新访问顺序）。
4. 返回 `[cluster, updateType]`。

**相似度 `getSeqDistance(seq1, seq2, includeParams)`**（[drain.ts](../../src/utils/drain/drain.ts#L127-L162)）：两序列长度必须相等。逐位比较，`<*>` 计入 `paramCount` 不算相似；`includeParams=true` 时把 `<*>` 也算相似分母。返回 `[similarTokens/len, paramCount]`。

**仅匹配不创建 `match(content, fullSearchStrategy="never")`**（[drain.ts](../../src/utils/drain/drain.ts#L180-L212)）：用 `simTh=1.0`（要求严格全等模板）。先走 treeSearch；`fullSearchStrategy="always"` 或 treeSearch 失败且策略非 `"never"` 时，对同 token 数的所有簇做全量 `fastMatch`。

### TemplateMiner 门面数据流

```
TemplateMiner.addLogMessage(logMessage)
  ├─ preprocessMessage(message)            // trim + extraDelimiters 归一 + 纯数字 token→<*>
  ├─ drain.addLogMessage(preprocessed)     → [cluster, updateType]
  ├─ snapshotIfNeeded()                    // 距上次保存 ≥ snapshotIntervalMinutes 则 saveState()
  └─ return { logCluster, isNewTemplate, changeType, processingTime }
```

`preprocessMessage` 与 Drain 内部 `getContentAsTokens` 的差异：preprocess 在分词后会把**整段为纯数字**（`/^\d+$/`）的 token 替换为 `<*>`（若 `parametrizeNumericTokens=true`），再重新用空格拼接喂给 Drain。注意 Drain 树内部对「含数字」token 也会归并（`hasNumbers`），两层处理互补。

### 快照持久化数据流

```
saveState()
  ├─ getDrainState()                       // 序列化 clusters[] + idToCluster{} + rootNode + clusterId
  ├─ JSON.stringify(state)
  ├─ if snapshotCompressState: gzip → base64
  └─ persistence.save(data)

loadState()  (initialize 时调)
  ├─ raw = persistence.load()              // null 则跳过
  ├─ if snapshotCompressState: base64 → gunzip → utf-8
  └─ restoreDrainFromState(JSON.parse)     // new Drain() + 逐簇 LogCluster + 递归 deserializeNode
```

`serializeNode` / `deserializeNode`（[templateMiner.ts](../../src/utils/drain/templateMiner.ts#L297-L324)）递归把 `Node.children: Map` 与 `SerializedNode.keyToChildNode: Record` 互转。

### compressLog（对外简化入口）数据流

[源码 index.ts](../../src/utils/drain/index.ts#L38-L111)：

```
compressLog(content, previewCount=3)
  ├─ new TemplateMinerConfig({ drainSimTh:0.5, drainDepth:4, parametrizeNumericTokens:true })
  ├─ new TemplateMiner(config, new InMemoryPersistenceHandler()) + initialize()
  ├─ lines = content.split("\n").filter(trim)
  ├─ for line: miner.addLogMessage(line) → 按 result.logCluster.template.join(" ") 分组到 templateMap
  ├─ 渲染：
  │     === 日志模板摘要 (共 N 个模板) ===
  │     [模板: <tokens>] (M次)
  │       显示前 K 个实例:
  │       1. <原行>
  │       ... 省略 X 个相似日志
  │     ---
  │     [压缩统计] 原始行数 / 模板数量 / 压缩率%
  └─ miner.close() → return DrainResult
```

注意：compressLog 用的是 **`drainSimTh: 0.5`**（高于 TemplateMinerConfig 默认的 0.4），稍微严格一些，避免日志被过度合并。

## 依赖与关联 ⭐

### 内部依赖链

```
index.ts
  ├─ templateMiner.ts ─┬─ drain.ts (Drain)
  │                    ├─ drainBase.ts (DrainBase, DrainUpdateType)
  │                    ├─ node.ts (LogCluster, Node)
  │                    ├─ persistenceHandler.ts (PersistenceHandler)
  │                    ├─ templateMinerConfig.ts (TemplateMinerConfig)
  │                    └─ types.ts
  ├─ templateMinerConfig.ts
  ├─ inMemoryPersistence.ts ── persistenceHandler.ts
  └─ drain.ts ── drainBase.ts ── node.ts / types.ts / @/utils/logger
```

### 外部依赖

| 源 | 目标 | 性质 |
|----|------|------|
| [drainBase.ts](../../src/utils/drain/drainBase.ts) | `@/utils/logger/index.js` | runtime：`writeLine()` 默认走 `logger.info`（打印 prefix tree 时） |
| [templateMiner.ts](../../src/utils/drain/templateMiner.ts) | `node:perf_hooks`、`node:util`、`node:zlib` | runtime：性能计时、`promisify(gzip/gunzip)` |
| 整个 drain 模块 | **无任何业务层依赖** | 纯算法 + Node 标准库 + logger |

### 被依赖

| 模块 | 用途 |
|------|------|
| [agent/sense/read.ts](../../src/agent/sense/read.ts) | `import { compressLog }` —— `read_file` 感官读大日志文件时，`compression: "drain"`（或 `auto` 判定为日志扩展名）触发，失败回退截断策略 |

drain 的输出 `compressionRatio` 还会写进 `read_file` 返回给 LLM 的压缩说明（[read.ts 第 114 行附近](../../src/agent/sense/read.ts)）。

### 横切参考

- `read_file` 感官的压缩决策（auto/truncate/drain/none）与 `config.global.file_compression`：[./README.md#config](./README.md)、[../../src/agent/sense/read.ts](../../src/agent/sense/read.ts)
- drain 打印调试树时用到的 logger：[./logger.md](./logger.md)
- config.yaml 的 `file_compression.log_file_extensions`（决定 auto 模式何时判定为日志）：[.chery/config.yaml](../../.chery/config.yaml)

## 扩展点

### 调参（`TemplateMinerConfig`）

| 参数 | 默认 | 调参影响 |
|------|------|----------|
| `drainSimTh` | 0.4（compressLog 用 0.5） | 提高 → 更严格，模板更细（更多小簇）；降低 → 更宽松，过度合并风险 |
| `drainDepth` | 4 | 更深 → 前缀路由更精细、更快但内存大；必须 ≥ 3 |
| `drainMaxChildren` | 100 | 单个内部节点子节点上限，超限归并到 `<*>`；影响路由精度 |
| `drainMaxClusters` | null（无限） | 设数字后启用 LRU 簇缓存（`LogClusterCache`），防止簇无限增长 |
| `drainExtraDelimiters` | [] | 额外分词符（如 `["/", "=", ":"]`），默认仅按空白分词 |
| `parametrizeNumericTokens` | true | 含数字 token 是否当参数归并到 `<*>` |
| `snapshotIntervalMinutes` | 1 | 配置 persistence 时，每隔几分钟自动快照 |
| `snapshotCompressState` | true | 快照是否 gzip+base64（true 节省空间，false 调试易读） |

### 换持久化后端

`compressLog` 内部固定用 `InMemoryPersistenceHandler`（进程内、随进程消失）。若要落盘或跨进程共享（如 Redis / SQLite / 文件），新建 class `extends PersistenceHandler`，实现 `save/load/close/delete` 四个 `async` 方法（约定 `save` 接收/`load` 返回字符串；若 `snapshotCompressState=true` 则该字符串是 gzip 的 base64），传入 `new TemplateMiner(config, yourHandler)`。

### 复用 Drain 不走 TemplateMiner

`Drain` 类（[drain.ts](../../src/utils/drain/drain.ts)）可独立实例化，直接 `addLogMessage(content)` 同步获取簇；`TemplateMiner` 仅多加了预处理、持久化、性能计时。若要做实时日志流聚类（非 read_file 的批处理压缩），可直接用 `Drain` + `match()` 仅匹配模式。

### 已知局限（待确认）

- `getSeqDistance` 要求两序列**长度相等**，不等则 `throw`。长度差异由第一层 `<L=N>` 桶保证不会发生，但若绕过 `addSeqToPrefixTree` 直接构造异常状态可能触发。
- `match()` 的 `fullSearchStrategy` 当前只支持 `"never" | "always"`，无 `"fallback"`（treeSearch 失败才全量）这种中间策略（代码里有该分支但类型未导出，**待确认**是否计划开放）。
