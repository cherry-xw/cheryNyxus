# mock — 离线 Provider 脚本

> 模板目录：`.chery.template/mock/` ｜ 运行位置：`.chery/mock/`
> 加载入口：[src/agent/provider/mock/](../../src/agent/provider/mock/) ｜ 详细文档：[../../docs/mock.md](../../docs/mock.md)

## 用途

为 `provider: mock` 的 brain 提供脚本化响应（YAML），让 LLM 调用无需真实 API、可预测地回放。开发调试、CI 测试、Agent 行为验证场景使用。

每个 LLM 调用按 `messages` 中 assistant 计数索引取一条响应；耗尽后按 `repeat` 策略重复。

## 文件清单

| 文件 | 职责 |
|------|------|
| [../mock/read_file.yaml](../mock/read_file.yaml) | 示例脚本：四轮回放（content → 多 tool call → 多 tool call → content），覆盖 loop 多轮 sense 链 |

## 脚本字段

### 顶层字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `repeat` | enum | ❌ | `last` | 索引耗尽后的重复策略：`last`（重复最后一条）/ `loop`（从头循环）/ `error`（抛错） |
| `script` | array | ✅ | — | 响应条目数组，按 LLM 调用序索引 |

### script[] 条目字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `content` | string | ❌ | LLM 返回的 content（文本内容） |
| `thinking` | string | ❌ | LLM 返回的 thinking（思考过程） |
| `senseCalls` | array | ❌ | LLM 返回的 tool call 列表 |
| `error` | object | ❌ | 模拟错误（provider 抛错而非返回响应） |

### senseCalls[] 条目字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ❌ | tool call id（缺省自动生成） |
| `name` | string | ✅ | 感官名（必须存在于该 brain 角色的 `senseGroup`） |
| `arguments` | string (JSON) | ✅ | 感官入参（JSON 字符串，运行时解析） |

### error 字段

```yaml
error:
  message: "mock simulated failure"
  type: "rate_limit"        # 可选：错误类型（参考 provider 错误分类）
```

## 监管等级

mock 脚本中**不**声明监管等级。由 `config.yaml` 的 `sense_groups.<group>` 的 `:level` 后缀或感官内置声明决定。

## 示例（模板 read_file.yaml）

```yaml
repeat: last
script:
  # 轮 1：纯文本响应
  - content: "好的，我先看看情况。"

  # 轮 2：多个 tool call（不同感官）
  - thinking: "需要读取两个文件"
    content: "先读取文件"
    senseCalls:
      - name: read_file
        arguments: '{"path":"/a.txt"}'
      - name: read_file
        arguments: '{"path":"/b.txt"}'

  # 轮 3：组合 tool call
  - thinking: "写入结果并执行命令"
    content: "现在写入并执行"
    senseCalls:
      - name: write_file
        arguments: '{"path":"/out.txt","content":"hello"}'
      - name: execute_command
        arguments: '{"command":"ls -la"}'

  # 轮 4：总结 content
  - content: "所有任务已完成。"
```

## 关联配置

`.chery/config.yaml` 中：

```yaml
llm:
  brain:
    mock_test:
      model: mock_test
      provider: mock
      thinking: 'off'
      mock:
        enabled: true
        file: mock/read_file.yaml         # 相对 .chery/
      contextLimit: 8192
      capabilities:
        input: {}
        generate: {}
```

## 注意事项

- script 中引用的 sense 必须存在于该 brain 角色的 `senseGroup`；否则 senseMiddleware 会按「无此工具」静默跳过，**不**影响 loop/checkpoint 流程验证
- `arguments` 必须是合法 JSON 字符串（注意引号转义）
- 多 tool call（`senseCalls` 含多个条目）会触发 loop 中多 sense 并行 / 串行执行（取决于实现）
- 错误模拟（`error`）可用于测试 provider 错误分类与重试逻辑

## 关联

- Provider 文档：[docs/agent/provider.md](../../docs/agent/provider.md)
- Mock 详细说明：[../../docs/mock.md](../../docs/mock.md)
- Provider Adapter 入口：[src/agent/provider/mock/](../../src/agent/provider/mock/)