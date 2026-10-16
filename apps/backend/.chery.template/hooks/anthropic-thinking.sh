#!/bin/sh
# Anthropic PreLLMRequest hook 示例：thinking 参数适配
#
# stdin 喂入 {event, payload: {provider, model, url, thinking, stream, body}, ctx} JSON
# stdout 返回决策 JSON（exit 0）：
#   - {"body": <new>}        替换请求体
#   - {"decision":"block","reason":"..."}  阻断请求
#   - {}                    不修改
#
# 此示例：anthropic 官方端点 → body 不动；其他端点 → 改写 thinking 字段适配其私有 schema。
# 用 jq 解析 stdin；如无 jq 可装或换成 node/python 解析。

set -e

INPUT=$(cat)
THINKING=$(echo "$INPUT" | jq -r '.payload.thinking // "off"')
URL=$(echo "$INPUT" | jq -r '.payload.url // ""')
BODY=$(echo "$INPUT" | jq -c '.payload.body')

# 官方 API：body 不动，直接透传
case "$URL" in
  https://api.anthropic.com|https://api.anthropic.com/*)
    echo "$INPUT" | jq '{body: .payload.body}'
    exit 0
    ;;
esac

# 其它端点：按档位映射 thinking 为各端点期望的私有字段
# 示例（按实际端点协议调整）：
NEW_BODY=$(echo "$BODY" | jq --arg t "$THINKING" '
  if $t == "off" then
    . | del(.thinking) | del(.output_config)
  elif $t == "high" then
    . + { thinking: { type: "enabled", budget_tokens: 8000 } } | del(.output_config)
  elif $t == "medium" then
    . + { thinking: { type: "enabled", budget_tokens: 4000 } } | del(.output_config)
  elif $t == "low" then
    . + { thinking: { type: "enabled", budget_tokens: 2000 } } | del(.output_config)
  else  # "on"
    . + { thinking: { type: "enabled", budget_tokens: 4000 } } | del(.output_config)
  end
')

echo "$INPUT" | jq --arg nb "$NEW_BODY" '{body: ($nb | fromjson)}'