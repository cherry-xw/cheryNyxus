# Mock Provider 使用说明

> [← 返回 README](../README.md) ｜ [协议规范](protocol.md) ｜ [交互流程](interaction.md)

离线测试 send/resume/revoke/loop 全流程的脚本化 LLM。无需真实模型/网络，按预定脚本逐轮回放响应，用于验证代码执行流向正确性。

## 配置

config.yaml 的 brain 下声明 mock provider，**只保留开关 + 脚本文件路径**（脚本内容独立文件，避免 config 过长）：

```yaml
llm:
  brain:
    mock_test:
      model: mock_test          # 任意，脚本按此 model 名查找
      provider: mock
      mock:
        enabled: true           # 开关，缺省 true
        file: mock/read_file.yaml  # 脚本文件，相对 .chery 目录
```

## 脚本文件格式

`.chery/<file>.yaml`，结构 `{ repeat?, script[] }`：

```yaml
repeat: last                    # 耗尽后行为：last=重复最后一条；缺省=返回空
script:
  - thinking: "思考内容"          # 思考增量（可选）
    content: "正文内容"           # 正文增量（可选）
    senseCalls:                  # 工具调用（可选；监管等级由 sense_groups 决定，不在此处）
      - id: "call_1"             # 可选，缺省 mock-${i}
        name: "read_file"
        arguments: '{"path":"/a.txt"}'
    error: "timeout"             # 抛错（可选，测 retry 中间件）
```

**单脚本项字段：**

| 字段 | 说明 |
|------|------|
| `thinking?` | 思考增量 |
| `content?` | 正文增量 |
| `senseCalls?` | 工具调用数组 `{id?, name, arguments}` |
| `error?` | 抛错信息（触发 retry） |

> 不缓存：每次 LLM 调用重读文件，dev 改脚本免重启。

## 索引机制

mock 按 **LLM 调用序** 逐条回放 script：

```
index = messages 中 role==="assistant" 的数量
```

- 每次 LLM 调用产生一个 assistant 轮 → 已调用次数 = 下一个 script 下标
- **无状态、天然 per-chat**（每个 chat 独立计数）
- **撤回自动回退**：`buildMessages` 过滤 revoked 消息，被撤回的 assistant 不计入 → 索引回到撤回前

流式输出：一条脚本项拆成多个 delta chunk（thinking / content / senseCalls 各一），触发 checkpoint 的 delta 状态机。

## 接线

无需额外代码。`chat.create` 用 mock brain 即走 mock：

```json
→ {"method":"chat.create","params":{"chatId":"c1","brain":"mock_test","senseGroups":["safe_senses"]}}
```

`runtimeResolver` 按 `provider:"mock"` 自动取 mock 的 LLM/Message/Sense adapter 三件套。

## 测试场景对照

改脚本文件内容即可模拟各交互模式：

| 场景 | 调用次数 | `script[]` |
|------|---------|-----------|
| 纯文本（流程A） | 1 | `[{content:"回复"}]` |
| thinking + 文本 | 1 | `[{thinking:"...",content:"回复"}]` |
| auto sense（流程B） | 2 | `[{content:"读取",senseCalls:[{name:"read_file",arguments:'{"path":"/a"}'}]},{content:"结果"}]` |
| confirm sense（流程C） | 2 | 同上（confirm 由 sense_groups `:level` 定，mock 不感知） |
| 多 sense 单轮 | 2 | `[{senseCalls:[A,B]},{content:"..."}]` |
| 多轮 sense 链 | 3+ | `[{senseCalls:[A]},{senseCalls:[B]},{content:"完成"}]` |
| maxLoop 超限 | 30+ | `[{senseCalls:[A]}]` + `repeat:last` |
| retry | - | `[{error:"timeout"}]` |
| send 撤回重跑 | 1 | 撤回后索引回退到 0，重放 script[0] |
| resume Case1 续接 | 1 | pending 不增 assistant，续接后取 script[next] |
| resume Case2（全done） | 1 | 直接取 script[next]，LLM 基于 done sense 回复 |

## 示例脚本

### auto sense 两轮（read_file）

`.chery/mock/read_file.yaml`：

```yaml
repeat: last
script:
  - content: "我来读取文件"
    senseCalls:
      - name: "read_file"
        arguments: '{"path":"/a.txt"}'
  - content: "文件内容是 hello"
```

### confirm sense（需 sense_groups 配 `:level`）

```yaml
script:
  - content: "准备写文件"
    senseCalls:
      - name: "write_file"
        arguments: '{"path":"/b.txt","content":"hi"}'
  - content: "已写入"
```

config.yaml sense_groups 加 confirm 级：

```yaml
sense_groups:
  write_senses:
    - write_file:confirm
```

### maxLoop 超限

```yaml
repeat: last
script:
  - senseCalls:
      - name: "read_file"
        arguments: '{"path":"/a.txt"}'
```

LLM 每轮都调 read_file，loop 持续到 maxLoopCount 触发 error。

### retry

```yaml
script:
  - error: "网络超时"
```

mock.chat/chatStream 抛错 → retry 中间件捕获。

## 注意

- **监管等级不在 mock**：auto/confirm/manual 由 config `sense_groups` 的 `:level` 后缀决定。测 confirm 需在 sense_groups 配 `:confirm`
- mock 已作为 builtin 注册，生产环境不用 `provider:"mock"` brain 即不触发（惰性）
- 脚本文件缺失：mock 返回空 content（warn 日志），不崩
