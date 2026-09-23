# model-catalog.yaml — 模型目录

`.chery/model-catalog.yaml` 只保存模型识别规则、事实、编辑器推荐和协议映射，不是第二份 brain 配置。

- `facts`：已知最大上下文、官方协议、工具和媒体能力，用于展示与校验。
- `recommend`：没有协议专属值时，用户选择模型时写入设置页草稿；只有保存到 `config.yaml` 后才生效。可包含 `provider`（服务入口），切换模型时自动把服务与协议切到推荐值。
- `recommendByProtocol`：按 API 协议保存独立的编辑器推荐。切换协议时，设置页只更新仍等于旧自动推荐的字段，用户手动改过的值不被覆盖。
- `wire`：把已经保存的 `thinking` 档位翻译为请求字段，并声明历史思考的协议形状。
- 未匹配具体规则时使用 `unknown.recommend` 填入可调整的保守草稿；不伪造协议 wire 或可用思考档位。推荐未提供 `provider`/`protocol` 时不重置当前服务与协议选择。

## 匹配

`match.models` 支持三种形式：

```yaml
match:
  models:
    - { exact: MiniMax-M3 }
    - { glob: 'MiniMax-M3-*' }
    - { regex: '^relay-(alpha|beta)-\\d+$', flags: i }
  providers: [newapi] # 可选
```

普通字符串等同于 glob；不包含 `*` 时按精确值处理。匹配同时检查完整模型名和最后一个 `/` 后的名称。

默认模型规则全部保存在项目的 `.chery/model-catalog.yaml` 中，程序代码不隐藏厂商规则。它们统一使用“主体模型名 + 版本”正则，可容忍中转站前缀、日期或变体后缀和常见分隔符变化。版本边界会单独校验，例如 `deepseek-v4.1` 不会命中 `deepseek-v4` 规则。

优先级为精确 > 正则 > glob；同类匹配选择更具体的表达式。

## 完整结构

```yaml
version: 1

unknown:
  recommend:
    contextLimit: 128000
    thinking: off
    capabilities:
      toolCall: true
      input: { image: false, video: false, audio: false }
      generate: { image: false, video: false, audio: false }
  capabilities:
    toolCall: true
    input: { image: false, video: false, audio: false }
    generate: { image: false, video: false, audio: false }

models:
  - id: private-model
    match:
      models:
        - { exact: private-model }
        - { regex: '^private-model-\\d+$', flags: i }

    facts:
      contextWindow: 1000000
      protocols: [openai-chat-completions, openai-responses]
      capabilities:
        toolCall: true
        input: { image: false }

    recommend:
      provider: openai
      protocol: openai-responses
      contextLimit: 250000
      thinking: on
      capabilities:
        toolCall: true

    recommendByProtocol:
      openai-responses:
        protocol: openai-responses
        thinking: on
        capabilities:
          toolCall: true

    wire:
      openai-chat-completions:
        reasoningHistory: assistant-field
        thinking:
          - display: off
            params: { thinking: { type: disabled } }
          - display: on
            params: { thinking: { type: enabled } }
```

除 `id` 和 `match.models` 外均可省略。只声明 `wire.thinking` 时，前端仅获得思考档位，其他字段继续保持未知。

`reasoningHistory` 可取：

- `assistant-field`：Chat Completions 的 `assistant.reasoning_content`
- `reasoning-item`：Responses 的 reasoning item
- `thinking-block`：Anthropic Messages thinking block
- `omit`：不回传历史思考

## 推荐写入规则

选择模型时，设置页会请求 `utils.modelRecommendation`：

1. 首次选择模型时把推荐服务、协议、上下文、思考档位和能力写入编辑草稿。
2. 更换模型时，只替换空值或仍等于上一模型推荐值的字段；推荐带 `provider`/`protocol` 时自动切换服务与协议；推荐未给出服务/协议时保留当前选择，不清空。未命中具体规则时，写入 `unknown.recommend` 的保守值，不会把字段置空。
3. 用户已修改的值不被推荐静默覆盖。
4. 点击保存后，草稿写入 `config.yaml` 并成为运行时事实。
5. 运行时上下文百分比只读取 `brain.contextLimit`，不读取 `facts.contextWindow` 或推荐值。

## 默认规则

模板会把已核对官方资料的 MiniMax M2.7/M3、DeepSeek V3.2/R1/V4、GLM 5.1/5.2/5.3、GPT 5.5/5.6、GPT-6 Astra/Sol/Luna、Step 3.5/3.7/5、MiMo V2、Grok 4.7、Claude Opus 4.7、Gemini 3、Qwen3-VL 和 Kimi K3 基础规则写入项目文件。规则只写入能确认的协议字段和媒体事实；资料未明确的 thinking 档位不会由模型名称推断，继续使用未知模型的保守策略。GPT-6 Astra 官方不支持 `none`（off），档位为 `low/medium/high/xhigh/max`；GPT-6 Sol/Luna 与 GPT-5.6 支持 `none/low/medium/high/xhigh/max`。有官方服务入口的厂商（OpenAI、Anthropic、MiniMax、DeepSeek、智谱）在推荐中带 `provider`，切换模型时自动切到对应服务；暂未接入官方服务入口的模型只切协议、保留当前服务。用户可直接修改、删除或追加中转站别名规则。未修改的官方模板文件可随版本安全升级；一旦用户修改，同步器会保留用户版本。

RPM 不属于模型能力，它由账号、服务或中转站决定，只配置在 `config.yaml` 的 brain 中。
