# cheryClaw 测试覆盖率提升计划

## 一、现状分析

### 当前覆盖率概况
| 模块 | 当前覆盖率 | 主要未覆盖行 |
|------|-----------|-------------|
| src/agent/middleware/tool.ts | 0% | 32-211（全部） |
| src/core/middleware/index.ts | 0% | 26-212（全部） |
| src/agent/provider/openai.ts | 23.37% | 39-74, 78-200, 209-252 |
| src/agent/provider/ollama.ts | 36.36% | 30-58, 67-88, 103-130 |
| src/agent/tool/bash.ts | 4.68% | 37-152 |
| src/agent/tool/read.ts | 3.07% | 27-177 |
| src/agent/tool/write.ts | 3.22% | 27-97 |
| src/agent/tool/skill.ts | 0% | 23-35 |
| src/agent/builder.ts | 52.17% | 54, 86-94, 106-138 |
| src/utils/bashLogger.ts | 61.9% | 24, 83-105（cleanOldLogs） |
| src/utils/drain/drainBase.ts | 76.42% | 多处边界分支 |

### 测试技术栈确认
- Vitest 4.1.7 + coverage-v8
- vi.mock/vi.fn 模式已成熟使用
- ESM + TypeScript 路径别名 `@/` 已配置
- 测试 helpers: `test/helpers/tempDir.ts`（临时目录工具）

---

## 二、配置路径别名

### tsconfig.json 修改
添加 `@test` 别名：
```json
"paths": {
  "@/*": ["src/*"],
  "@test/*": ["test/*"]
}
```

### vitest.config.ts 修改
当前已有 `test` 别名，需规范化为 `@test`：
```typescript
resolve: {
  alias: {
    "@": resolve(__dirname, "./src"),
    "@test": resolve(__dirname, "./test"),
  },
},
```

---

## 三、分阶段实施计划

### Phase 1: 基础设施层（优先级：高）

#### 1.1 test/utils/bashLogger.test.ts（当前 62% → 90%）
**未覆盖功能**: `cleanOldLogs` 函数（83-105行）

**测试策略**:
```typescript
// 需要测试的场景：
// 1. 清理超过保留时间的日志文件
// 2. 保留最近日志文件
// 3. 处理非 .log 文件（跳过）
// 4. 处理文件删除异常
// 5. 空目录处理
```

**Mock 方案**: 无需 Mock，使用 `test/helpers/tempDir.ts` 创建真实临时文件

**关键测试用例**:
| 用例 | 描述 | 复杂度 |
|------|------|--------|
| cleanOldLogs-basic | 清理24小时前日志 | 低 |
| cleanOldLogs-recent | 保留最近日志 | 低 |
| cleanOldLogs-nonLog | 跳过非.log文件 | 低 |
| cleanOldLogs-empty | 空目录处理 | 低 |
| cleanOldLogs-error | 处理删除异常 | 中 |

**预估工作量**: 0.5 天

---

#### 1.2 test/utils/drain/drainBase.test.ts（当前 76% → 90%）
**未覆盖分支**: `printTree`、`printNode`、`writeLine` 方法

**测试策略**:
```typescript
// 需要测试的场景：
// 1. printTree 输出格式验证
// 2. writeLine 写入 Writable stream
// 3. maxClusters LRU 缓存行为（LogClusterCache）
// 4. 边界条件：depth=0/1 的节点格式化
```

**Mock 方案**: 使用 `PassThrough` stream 模拟 Writable

**关键测试用例**:
| 用例 | 描述 | 复杂度 |
|------|------|--------|
| printTree-format | 输出树结构格式 | 中 |
| writeLine-stream | 写入 stream | 低 |
| LogClusterCache-LRU | 缓存淘汰机制 | 中 |
| printNode-depths | 不同深度节点格式 | 低 |

**预估工作量**: 0.5 天

---

### Phase 2: 核心中间件层（优先级：最高）

#### 2.1 test/core/middleware/index.test.ts（当前 0% → 90%）
**源文件**: `/home/chery/self/cheryClaw/src/core/middleware/index.ts`

**核心功能**:
1. `Middleware` 类：会话管理、线程创建、消息发送
2. `executeLoop`：循环执行中间件链，处理 tool calls
3. `createThread`：创建新会话线程
4. `send`：消息发送与 generator 管理
5. `isDoneChunk`：类型守卫

**测试策略**:
```typescript
// Mock 依赖：
// 1. compose 函数 - 返回 mock generator
// 2. ToolManager - mock add/get/execute
// 3. AdaptersGroup - mock llmAdapter/messageAdapter/toolAdapter
// 4. buildPrompt - mock 返回固定系统消息
// 5. uuid - mock 返回固定 ID

// 测试场景：
// 1. createThread 创建线程并初始化系统消息
// 2. send 存储用户消息到 pendingInputs
// 3. send 检查活跃 generator 并复用
// 4. executeLoop 循环执行逻辑（maxLoopCount 控制）
// 5. executeLoop 注入 pendingInputs 到 history
// 6. executeLoop 检查停止条件
// 7. isDoneChunk 类型守卫
```

**Mock 方案**:
```typescript
vi.mock("@/core/middleware/compose", () => ({
  compose: vi.fn(() => (ctx) => mockGenerator(ctx)),
}));

vi.mock("@/core/prompt/index", () => ({
  default: vi.fn(() => "mock system prompt"),
}));

vi.mock("uuid", () => ({
  v4: vi.fn(() => "test-uuid-1234"),
}));
```

**关键测试用例**:
| 用例 | 描述 | 复杂度 |
|------|------|--------|
| createThread-basic | 创建线程并设置系统消息 | 中 |
| createThread-uuid | 使用正确 sessionId/threadId | 低 |
| send-pendingInput | 存储用户消息 | 低 |
| send-emptyInput | 空消息不存储 | 低 |
| send-existingGenerator | 复用活跃 generator | 高 |
| send-newGenerator | 创建新 generator | 高 |
| executeLoop-maxLoop | 达到最大循环次数 | 高 |
| executeLoop-toolCallContinue | tool call 继续循环 | 高 |
| executeLoop-stopConditions | 多种停止条件 | 高 |
| executeLoop-resetState | 重置累积状态 | 中 |
| isDoneChunk-guard | 类型守卫正确识别 | 低 |

**技术风险**:
- Generator 异步控制流复杂
- 需要模拟 `for await` 迭代
- `activeGenerators` Map 状态管理

**预估工作量**: 1.5 天

---

#### 2.2 test/agent/middleware/tool.test.ts（当前 0% → 90%）
**源文件**: `/home/chery/self/cheryClaw/src/agent/middleware/tool.ts`

**核心功能**:
1. `toolMiddleware`：两阶段执行（前半部分准备，后半部分执行）
2. `executeSingleToolCall`：单个工具执行
3. `whiteHistory`：批量写入历史
4. `InterruptChunk` 生成与 `handles.acknowledge` 处理
5. 分级检查逻辑

**测试策略**:
```typescript
// Mock 依赖：
// 1. ToolManager.get/execute
// 2. SupervisionLevel 配置
// 3. MiddlewareContext.process 状态

// 测试场景：
// 1. 无 toolCalls 时直接返回
// 2. 工具不存在时返回错误信息
// 3. 全局 auto 级别全部自动执行
// 4. 全局 manual 级别全部需确认
// 5. 全局 confirm 级别按工具声明走
// 6. InterruptChunk yield 与 acknowledge
// 7. acknowledge accept 执行工具
// 8. acknowledge reject 拒绝执行
// 9. hash 去重检查
// 10. whiteHistory 批量写入
```

**Mock 方案**:
```typescript
vi.mock("@/core/config", () => ({
  SupervisionLevel: { auto: 0, confirm: 1, manual: 2 },
}));

// 创建 mock ToolManager 和 MiddlewareContext
function createMockToolManager() {
  return {
    get: vi.fn((name) => mockTools[name]),
    execute: vi.fn(async (name, args) => ({ content: "result", hash: "test-hash" })),
  };
}
```

**关键测试用例**:
| 用例 | 描述 | 复杂度 |
|------|------|--------|
| noToolCalls | 空工具调用列表 | 低 |
| toolNotFound | 工具不存在 | 中 |
| globalAuto-execution | 全局 auto 执行 | 中 |
| globalManual-confirm | 全局 manual 确认 | 高 |
| globalConfirm-mixed | 全局 confirm 混合 | 高 |
| interruptChunk-yield | yield InterruptChunk | 高 |
| acknowledge-accept | 确认后执行 | 高 |
| acknowledge-reject | 拒绝后返回消息 | 高 |
| hashCheck-duplicate | 去重检查跳过 | 中 |
| whiteHistory-assistant | 写入 assistant 消息 | 中 |
| whiteHistory-tool | 写入 tool 消息 | 中 |
| batchExecution | 批量并发执行 | 高 |

**技术风险**:
- 两阶段 Generator 执行（先 yield next，再执行）
- InterruptChunk 的 acknowledge 回调机制
- Promise.all 批量执行

**预估工作量**: 1.5 天

---

### Phase 3: Provider Adapter 层（优先级：中）

#### 3.1 test/agent/provider/openai.test.ts（当前 23% → 90%）
**未覆盖功能**:
- `buildMessages` 完整转换逻辑（tool 消息、assistant with toolCalls）
- `assembleToolCallChunks` 流式工具调用累积
- `buildToolCallMessage` / `buildToolResponseMessage`
- LLM adapter 的 `chat` / `chatStream` 调用

**测试策略**:
```typescript
// 测试场景：
// 1. buildMessages - tool 消息转换
// 2. buildMessages - assistant with toolCalls
// 3. buildMessages - assistant with thinking
// 4. assembleToolCallChunks - 按 index 累积
// 5. assembleToolCallChunks - 首个 chunk id/name
// 6. assembleToolCallChunks - 后续 chunk arguments 累积
// 7. buildToolCallMessage - tid/name/arguments
// 8. buildToolResponseMessage - tool_call_id
// 9. LLM chat - model/url 缺失抛错
// 10. LLM chatStream - stream 选项
// 11. LLM thinking - thinking 参数启用
```

**Mock 方案**: 继续使用现有 OpenAI SDK mock，增强返回数据

**关键测试用例**:
| 用例 | 描述 | 复杂度 |
|------|------|--------|
| buildMessages-tool | tool 角色消息转换 | 中 |
| buildMessages-toolCalls | assistant 带 toolCalls | 中 |
| buildMessages-thinking | assistant 带 thinking | 中 |
| assembleToolCallChunks-basic | 基本累积逻辑 | 高 |
| assembleToolCallChunks-index | 按 index 分组 | 高 |
| assembleToolCallChunks-id | 馍个 chunk id | 中 |
| buildToolCallMessage-convert | 转换格式 | 低 |
| buildToolResponseMessage-format | 格式化 | 低 |
| chat-noModel | 缺少 model 抛错 | 低 |
| chat-noUrl | 缺少 url 抛错 | 低 |
| chatStream-options | 流式选项 | 中 |
| chat-thinking | thinking 参数 | 中 |

**预估工作量**: 1 天

---

#### 3.2 test/agent/provider/ollama.test.ts（当前 28% → 90%）
**未覆盖功能**:
- `buildMessages` 转换逻辑
- `assembleToolCallChunks` 累积逻辑
- `buildToolCallMessage` / `buildToolResponseMessage`
- LLM adapter 调用

**测试策略**: 与 OpenAI 类似，但需适配 Ollama 格式差异
- Ollama 无 tool call id（tid 为空）
- Ollama tool_calls 结构不同

**关键测试用例**: 与 OpenAI 类似（11个）

**预估工作量**: 0.75 天

---

### Phase 4: Tool 层（优先级：中高）

#### 4.1 test/agent/tool/bash.test.ts（当前 5% → 90%）
**未覆盖功能**: `executor.execute` 完整执行逻辑

**测试策略**:
```typescript
// Mock 依赖：
// 1. child_process.spawn - 模拟进程
// 2. bashLogger 所有函数
// 3. config 默认值

// 测试场景：
// 1. 成功执行命令（exit code 0）
// 2. 失败执行（exit code 非 0）
// 3. 超时处理
// 4. 进程错误处理
// 5. stdout/stderr 输出
// 6. 日志文件写入
// 7. cleanOldLogs 调用
```

**Mock 方案**:
```typescript
vi.mock("child_process", () => ({
  spawn: vi.fn((command, options) => createMockProcess()),
}));

function createMockProcess(options: { exitCode?: number, stdout?: string, stderr?: string, error?: Error }) {
  // 返回模拟进程对象
}
```

**关键测试用例**:
| 用例 | 描述 | 复杂度 |
|------|------|--------|
| execute-success | 成功执行 | 中 |
| execute-exitCode | 非 0 退出码 | 中 |
| execute-timeout | 超时处理 | 高 |
| execute-error | 进程错误 | 中 |
| execute-stdout | stdout 输出 | 低 |
| execute-stderr | stderr 输出 | 低 |
| execute-logFile | 日志写入 | 中 |
| execute-cleanOldLogs | 清理旧日志 | 低 |

**技术风险**:
- spawn 进程模拟复杂
- 超时 setTimeout 控制
- 事件监听（stdout/stderr/close/error）

**预估工作量**: 1 天

---

#### 4.2 test/agent/tool/read.test.ts（当前 3% → 90%）
**未覆盖功能**: `executor.execute` 完整逻辑

**测试策略**:
```typescript
// 测试场景：
// 1. 绝对路径验证（成功/失败）
// 2. 文件不存在处理
// 3. 小文件不压缩
// 4. 大文件截断
// 5. 日志文件 Drain 压缩
// 6. offset/limit 分段读取
// 7. hash 生成与 toolSharedData 写入
// 8. compression 参数
```

**Mock 方案**:
```typescript
vi.mock("fs/promises", () => ({
  readFile: vi.fn(async (path) => mockFileContent[path]),
  stat: vi.fn(async (path) => mockFileStat[path]),
}));

vi.mock("@/utils/drain", () => ({
  compressLog: vi.fn(async () => ({ compressedContent: "...", templateCount: 5, compressionRatio: "80%" })),
}));
```

**关键测试用例**:
| 用例 | 描述 | 复杂度 |
|------|------|--------|
| absolutePath-valid | 有效绝对路径 | 低 |
| absolutePath-invalid | 无效路径错误 | 中 |
| fileNotExist | 文件不存在 | 低 |
| smallFile-noCompression | 小文件不压缩 | 中 |
| largeFile-truncate | 截断压缩 | 中 |
| logFile-drain | Drain 压缩 | 高 |
| drain-fallback | Drain 失败回退截断 | 高 |
| offset-limit | 分段读取 | 中 |
| hash-generation | hash 生成 | 低 |
| toolSharedData-write | 写入共享数据 | 中 |
| compression-auto | 自动策略判断 | 高 |
| compression-none | none 策略 | 低 |

**技术风险**:
- fs/promises mock 需要模拟 stat 和 readFile
- Drain 算法调用失败回退逻辑

**预估工作量**: 1 天

---

#### 4.3 test/agent/tool/write.test.ts（当前 3% → 90%）
**未覆盖功能**: `executor.execute` 完整逻辑

**测试策略**:
```typescript
// 测试场景：
// 1. 相对路径转换为绝对路径
// 2. 文件修改检测（hash 对比）
// 3. 文件被修改警告
// 4. 正常写入成功
// 5. 跨文件系统移动（EXDEV）
// 6. 目录不存在错误（ENOENT）
// 7. 权限不足错误（EACCES）
// 8. 临时文件写入 + rename
```

**Mock 方案**:
```typescript
vi.mock("fs/promises", () => ({
  writeFile: vi.fn(async () => {}),
  rename: vi.fn(async (src, dest) => {
    if (dest.includes("cross-fs")) throw { code: "EXDEV" };
  }),
  copyFile: vi.fn(async () => {}),
  unlink: vi.fn(async () => {}),
  stat: vi.fn(async (path) => mockStat[path]),
}));
```

**关键测试用例**:
| 用例 | 描述 | 复杂度 |
|------|------|--------|
| relativePath-convert | 相对路径转换 | 低 |
| fileModified-warning | 文件被修改警告 | 高 |
| write-success | 成功写入 | 中 |
| write-crossFS | 跨文件系统 | 高 |
| directoryNotExist | 目录不存在 | 低 |
| permissionDenied | 权限不足 | 低 |
| tempFile-rename | 临时文件移动 | 中 |
| hash-write | hash 为空字符串 | 低 |

**技术风险**:
- 文件修改检测需要模拟 toolSharedData
- EXDEV 跨文件系统错误处理

**预估工作量**: 1 天

---

#### 4.4 test/agent/tool/skill.test.ts（当前 0% → 90%）
**未覆盖功能**: `executor.execute` 完整逻辑

**测试策略**:
```typescript
// 测试场景：
// 1. skill 存在时返回内容
// 2. skill 不存在时返回错误
// 3. hash 生成
// 4. 技能内容格式化
```

**Mock 方案**: 已有基本 mock，需扩展执行测试

**关键测试用例**:
| 用例 | 描述 | 复杂度 |
|------|------|--------|
| skill-exist | 存在的技能 | 低 |
| skill-notExist | 不存在的技能 | 低 |
| skill-hash | hash 生成 | 低 |
| skill-contentFormat | 内容格式化 | 低 |

**预估工作量**: 0.25 天

---

### Phase 5: Agent Builder 层（优先级：中）

#### 5.1 test/agent/builder.test.ts（当前 52% → 90%）
**未覆盖功能**:
- `build()` 方法的工具去重逻辑（106-138）
- 多 tool_group 加载（86-94）
- 完整 build 流程

**测试策略**:
```typescript
// 测试场景：
// 1. 多 tool_group 加载
// 2. 工具去重（后加载覆盖前加载）
// 3. tool_group 不存在警告
// 4. ToolManager 创建和添加
// 5. Middleware 实例创建
// 6. initEnvInfo 调用
```

**关键测试用例**:
| 用例 | 描述 | 复杂度 |
|------|------|--------|
| build-multiToolGroup | 多工具组 | 高 |
| build-toolDuplicate | 工具去重 | 高 |
| build-toolGroupNotExist | 工具组不存在 | 中 |
| build-toolManagerAdd | 添加工具 | 中 |
| build-middlewareCreate | 创建 Middleware | 高 |
| build-initEnvInfo | 环境初始化 | 低 |

**预估工作量**: 0.5 天

---

## 四、依赖关系与执行顺序

```
Phase 1 (基础设施层)
├── bashLogger.test.ts ──┐
├── drainBase.test.ts   │
                          │
Phase 2 (核心中间件层)   │
├── middleware/index.test.ts ←─┘ (依赖 bashLogger)
├── middleware/tool.test.ts ←─ middleware/index.test.ts
                          │
Phase 3 (Provider层)     │
├── provider/openai.test.ts │
├── provider/ollama.test.ts │
                          │
Phase 4 (Tool层)         │
├── tool/bash.test.ts ←─ bashLogger
├── tool/read.test.ts ←─ drain
├── tool/write.test.ts
├── tool/skill.test.ts
                          │
Phase 5 (Builder层)      │
├── builder.test.ts ←─ provider + tool + middleware
```

**推荐执行顺序**:
1. Phase 1 → 2 → 3 → 4 → 5（按依赖关系）
2. 或 Phase 1/3/4 可并行，Phase 2/5 需等待依赖完成

---

## 五、技术风险总结

| 风险类型 | 模块 | 风险描述 | 解决方案 |
|----------|------|----------|----------|
| Generator 异步流 | middleware/index | executeLoop 的 for await 控制 | 使用 mock generator 返回固定 chunks |
| 两阶段执行 | middleware/tool | yield next 后再执行 | 分步测试，先测试后半部分 |
| InterruptChunk 回调 | middleware/tool | acknowledge 回调机制 | 测试 yield 后手动调用 acknowledge |
| 进程模拟 | tool/bash | spawn 事件监听 | 创建 mock EventEmitter 进程 |
| 文件系统 | tool/read/write | fs/promises mock | 使用 vi.mock 模拟 stat/readFile/writeFile |
| 流式累积 | provider | assembleToolCallChunks | 测试多 chunk 按 index 累积 |

---

## 六、工作量预估

| 文件 | 预估工作量 | 复杂度评级 |
|------|-----------|-----------|
| bashLogger.test.ts | 0.5 天 | 低 |
| drainBase.test.ts | 0.5 天 | 低 |
| middleware/index.test.ts | 1.5 天 | 高 |
| middleware/tool.test.ts | 1.5 天 | 高 |
| provider/openai.test.ts | 1 天 | 中 |
| provider/ollama.test.ts | 0.75 天 | 中 |
| tool/bash.test.ts | 1 天 | 高 |
| tool/read.test.ts | 1 天 | 高 |
| tool/write.test.ts | 1 天 | 高 |
| tool/skill.test.ts | 0.25 天 | 低 |
| builder.test.ts | 0.5 天 | 中 |
| **总计** | **8.5 天** | |

---

## 七、验收标准

- 所有测试文件覆盖率达到 90% 以上
- 全项目覆盖率从 58% 提升至 90%
- 所有测试用例通过
- 无新增 ESLint 错误
- 测试执行时间 < 30 秒