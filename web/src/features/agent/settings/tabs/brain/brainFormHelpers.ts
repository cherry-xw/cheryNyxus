import type { BrainConfigDto, MediaCapabilitiesDto } from '@/application/backend/public'

// ── info tip 文案（结构化多行，.label-tip-popper pre-line 渲染，\n 分点） ──
export const PROVIDER_TIP = [
  '服务：请求实际发往的官方厂商、中转站或自定义入口。',
  '它只提供默认地址和可选协议，不再决定消息解析方式。',
].join('\n')
export const PROTOCOL_TIP = [
  'API 协议：决定请求体、流事件、工具调用与思考内容的解析方式。',
  '协议应匹配服务入口实际暴露的端点。',
].join('\n')
export const KEY_TIP = [
  'key：API 密钥，从 .env 变量中选择（$ENV 占位符）。',
  '· 本地服务（LM Studio / vLLM / Ollama OpenAI 模式）不校验 key，可直接输入任意字符串（如 lm-studio）',
  '· 留空会触发运行期鉴权失败',
  '',
  '修改 .env 后点右侧「刷新」按钮，新密钥立即可选并生效，无需重启。',
].join('\n')
export const URL_TIP = [
  'url：请求地址，支持 $ENV 占位从环境变量注入。',
  '· 未勾选「完整 URL」：版本段（/v1 等）由你填写，后端按所选协议拼 /chat/completions、/responses 或 /messages',
  '· 勾选「完整 URL」：后端不拼接任何字符串，请求地址即你填写的整个 URL（须含版本段与端点，如 https://api.openai.com/v1/chat/completions）',
  '· ollama 填 host（如 http://localhost:11434），无版本段概念',
].join('\n')

/** 设置页默认以 K 为单位编辑，配置仍保存完整数值。 */
export function displayContextLimit(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value / 1000
}
export function updateContextLimit(cfg: { contextLimit?: number }, value: unknown): void {
  const limit = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(limit) || limit <= 0) return
  cfg.contextLimit = limit * 1000
}
export function capabilities(cfg: BrainConfigDto) {
  return (cfg.capabilities ??= {})
}
export function mediaCapabilities(cfg: BrainConfigDto, key: 'input' | 'generate') {
  const caps = capabilities(cfg)
  return (caps[key] ??= {})
}
export function toggleMediaCapability(
  cfg: BrainConfigDto,
  group: 'input' | 'generate',
  kind: keyof MediaCapabilitiesDto,
): void {
  const media = mediaCapabilities(cfg, group)
  media[kind] = media[kind] !== true
}
export function toolCallEnabled(cfg: BrainConfigDto): boolean {
  return cfg.capabilities?.toolCall !== false
}
export function setToolCall(cfg: BrainConfigDto, value: unknown): void {
  capabilities(cfg).toolCall = value as boolean
  if (value === false) capabilities(cfg).generate = {}
}

/** 当前 brain 是否官方 Anthropic（影响 redacted_thinking 回传策略）；
 *  仅 provider=anthropic 时生效；其它 provider 始终 false。 */
export function anthropicOfficial(cfg: BrainConfigDto): boolean {
  if (cfg.provider === 'deepseek') return false
  return (
    cfg.anthropicCompat?.official ??
    (cfg.protocol === 'anthropic-messages' &&
      (cfg.provider === 'anthropic' || cfg.provider === 'minimax'))
  )
}
