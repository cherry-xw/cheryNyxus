/**
 * Provider 测试脚本：验证 openai / bigmodel 两个 provider 的思考强度（ThinkingLevel）链路。
 *
 * 核心验证（针对「历史对话思考信息不再显示」的修复）：
 *   - thinking=high → 流式响应应出现 delta.reasoning_content（reasoning_effort 生效，思考链路恢复）
 *   - thinking=off  → 不发 reasoning_effort，reasoning_content 为空
 *   - openai（SDK 版）与 bigmodel（fetch 版）行为一致（openaiCompat 共享件 + 鸭子类型解析）
 *
 * 端点解析（优先级）：
 *   1. 环境变量 TEST_<PROVIDER>_URL / _KEY / _MODEL（显式覆盖，不依赖 config；KEY 可写 $VAR 引用 .env 变量）
 *   2. .chery/config.yaml 中 provider 匹配的 brain（loadConfig 已 replaceEnvVars；可用 TEST_<PROVIDER>_BRAIN 指定 brain 名，缺省取第一个匹配）
 *   两条路径都缺 → skip 该 provider。
 *   <PROVIDER> 大写为 OPENAI / BIGMODEL。
 *
 * 用法：
 *   pnpm test:providers
 *   # 只测 bigmodel（用智谱官方端点）：
 *   TEST_BIGMODEL_URL=https://open.bigmodel.cn/api/paas/v4 \
 *     TEST_BIGMODEL_KEY=$BIGMODEL_KEY TEST_BIGMODEL_MODEL=glm-4.6 \
 *     pnpm test:providers
 *   # 指定 config 里的 brain 名：
 *   TEST_OPENAI_BRAIN=ali_glm5 pnpm test:providers
 *
 * 资源清理：纯只读（不改 config.yaml、不写 DB、不留临时文件），仅消耗 API 配额。
 *
 * 未覆盖（需手动 / 集成测试）：
 *   - abort：前端「停止」→ compose.ts generator.throw() → fetchBase finally 切断连接（需完整服务链路）
 *   - 多模态 gate：image/video/audio 附件走 buildMessages content array（需 base64 附件 + capabilities 声明）
 */
import { registerOpenAIAdapter } from "@/agent/provider/openai";
import { registerBigmodelAdapter } from "@/agent/provider/bigmodel";
import { getLLMAdapter, type LLMOptions, type ThinkingLevel } from "@/core/llm/adapter";
import config from "@/utils/config";

// 注册内置 provider（脚本独立运行，不走 bootstrap）
registerOpenAIAdapter();
registerBigmodelAdapter();

type ProviderName = "openai" | "bigmodel";

const PROVIDERS: ProviderName[] = ["openai", "bigmodel"];
const LEVELS: ThinkingLevel[] = ["high", "off"];

/** 触发推理模型先思考再作答的简单 prompt。 */
const PROMPT = "用一句话解释什么是闭包。请先简短思考推理过程，再给出回答。";

interface Endpoint {
  provider: ProviderName;
  /** 来源标记：「env」或 config 里的 brain 名 */
  source: string;
  model: string;
  url: string;
  key: string;
}

/** LLMOptions.thinking 期望真值 key：解析 $VAR 占位符（env 未设 → null），非占位符原样返回。 */
function resolveRealKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/^\$([A-Z_][A-Z0-9_]*)$/);
  if (m) return process.env[m[1]!] ?? null;
  return raw;
}

/** 解析 provider 的测试端点：环境变量优先，回退 config.llm.brain 扫描。 */
function resolveEndpoint(provider: ProviderName): Endpoint | null {
  const prefix = `TEST_${provider.toUpperCase()}`;
  const envUrl = process.env[`${prefix}_URL`];
  const envModel = process.env[`${prefix}_MODEL`];
  const envKey = resolveRealKey(process.env[`${prefix}_KEY`]);
  if (envUrl && envModel && envKey) {
    return { provider, source: "env", model: envModel, url: envUrl, key: envKey };
  }
  // 回退：扫描 config.llm.brain
  const preferred = process.env[`${prefix}_BRAIN`];
  const brains = config.llm?.brain ?? {};
  for (const name of Object.keys(brains)) {
    if (preferred && name !== preferred) continue;
    const b = brains[name];
    if (!b || b.provider !== provider) continue;
    const key = resolveRealKey(b.key);
    if (!b.model || !b.url || !key) continue;
    return { provider, source: name, model: b.model, url: b.url, key };
  }
  return null;
}

/** 鸭子类型提取 chunk 的 content / reasoning_content（openai SDK chunk 与 bigmodel 裸 JSON 同形）。 */
function extractDelta(chunk: unknown): { content?: string; reasoning?: string } {
  const c = chunk as {
    choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
  };
  const delta = c.choices?.[0]?.delta;
  if (!delta) return {};
  return { content: delta.content, reasoning: delta.reasoning_content };
}

/** 单行预览（折叠空白 + 截断），避免 reasoning 长文刷屏。 */
function preview(s: string | undefined, n = 70): string {
  if (!s) return "(空)";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** 单次测试用例：给定 provider + thinking 档位，跑流式并统计 reasoning/content。 */
async function runCase(ep: Endpoint, level: ThinkingLevel): Promise<void> {
  const adapter = getLLMAdapter(ep.provider);
  if (!adapter) {
    console.log(`    ✗ adapter 未注册: ${ep.provider}`);
    return;
  }
  const options: LLMOptions = {
    model: ep.model,
    url: ep.url,
    key: ep.key,
    thinking: level,
  };
  const messages = [{ role: "user", content: PROMPT }];
  let reasoning = "";
  let content = "";
  let chunks = 0;
  const start = Date.now();
  try {
    const stream = await adapter.chatStream(messages, [], options);
    for await (const chunk of stream) {
      chunks++;
      const d = extractDelta(chunk);
      if (d.reasoning) reasoning += d.reasoning;
      if (d.content) content += d.content;
    }
  } catch (err) {
    console.log(`    ✗ level=${level} 出错: ${(err as Error).message}`);
    return;
  }
  const ms = Date.now() - start;
  // 期望：high → reasoning 非空；off → reasoning 为空
  const expectReasoning = level !== "off";
  const ok = expectReasoning ? reasoning.length > 0 : reasoning.length === 0;
  const flag = ok ? "✓" : "⚠";
  console.log(`    ${flag} level=${level.padEnd(6)} ${ms}ms ${chunks}chunks`);
  console.log(`      思考(${reasoning.length}字): ${preview(reasoning)}`);
  console.log(`      内容(${content.length}字): ${preview(content)}`);
}

async function main(): Promise<void> {
  console.log("=== Provider 测试：思考强度（ThinkingLevel）链路 ===\n");
  for (const provider of PROVIDERS) {
    const ep = resolveEndpoint(provider);
    if (!ep) {
      const prefix = `TEST_${provider.toUpperCase()}`;
      console.log(
        `[${provider}] skip — 未配置端点。设置 ${prefix}_URL/_KEY/_MODEL 环境变量，或在 config.yaml 配 provider:${provider} 的 brain（也可用 ${prefix}_BRAIN 指定 brain 名）。\n`,
      );
      continue;
    }
    console.log(`[${provider}] source=${ep.source}  model=${ep.model}`);
    for (const level of LEVELS) {
      await runCase(ep, level);
    }
    console.log("");
  }
  console.log("=== 判读指南 ===");
  console.log("• level=high 行「思考」应有内容 → reasoning_effort 生效，思考链路恢复（修复确认）");
  console.log("• level=off  行「思考」应为空 → 不发参，符合预期");
  console.log("• ⚠ 表示实测与期望不符（可能模型本身不区分，或端点不认 reasoning_effort）");
  console.log("• openai（SDK）与 bigmodel（fetch）两路应表现一致");
}

main().catch((err) => {
  console.error("脚本失败:", err);
  process.exit(1);
});
