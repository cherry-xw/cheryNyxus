#!/usr/bin/env node
/**
 * MiniMax 多模态图片能力 — 真实 key 端到端验证脚本。
 *
 * 覆盖（对应计划任务）：
 *  - 2.2  图片理解透传：openai-chat-completions 的 image_url data URI（base64）
 *  - 3.2  官方 token 预检：POST /v1/responses/input_tokens（图片作为 input_image）
 *  - 5.1  image-01 文生图：POST /v1/image_generation（response_format=base64）
 *
 * 用法：
 *   $env:MINIMAX_API_KEY="sk-..."            # 必填
 *   $env:MINIMAX_BASE_URL="https://api.minimaxi.com/v1"   # 官方默认；中转示例 yz.xcherry.top
 *   $env:MINIMAX_MODEL="MiniMax-M3"           # 可选，默认 MiniMax-M3
 *   node verify/minimax-image-e2e.mjs
 *
 * 通过 = 打印每个检查 PASS 且退出码 0；任一失败打印 FAIL + 服务端原文，退出码 1。
 * 脚本零依赖（仅用全局 fetch），构造的测试图为内置 1x1 PNG。
 */

const apiKey = process.env.MINIMAX_API_KEY
const baseUrl = (process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1').replace(/\/+$/, '')
const model = process.env.MINIMAX_MODEL || 'MiniMax-M3'

if (!apiKey) {
  console.error('缺少 MINIMAX_API_KEY，请先设置环境变量。')
  process.exit(2)
}

// 内置 1x1 透明 PNG（base64），足够验证 base64 透传
const PNG_1PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let failed = 0
function report(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail) console.log(`      ${detail}`)
  if (!ok) failed += 1
}

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 800) }
}

// ---- 2.2 图片理解透传（openai-chat-completions + image_url data URI）----
async function checkImageUnderstanding() {
  try {
    const { status, ok, json, text } = await post('/chat/completions', {
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图片是什么颜色？回答不超过 10 个字。' },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${PNG_1PX_B64}` },
            },
          ],
        },
      ],
      max_tokens: 32,
    })
    const content = json?.choices?.[0]?.message?.content
    report(
      '2.2 图片理解透传（openai-chat-completions, image_url data URI）',
      ok && typeof content === 'string' && content.length > 0,
      ok ? `回答：${JSON.stringify(content)}` : `HTTP ${status} ${text}`,
    )
  } catch (err) {
    report('2.2 图片理解透传', false, String(err))
  }
}

// ---- 3.2 官方 token 预检（POST /v1/responses/input_tokens，图片作 input_image）----
async function checkInputTokens() {
  try {
    const { status, ok, json, text } = await post('/responses/input_tokens', {
      model,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: '描述这张图' },
            {
              type: 'input_image',
              image_url: `data:image/png;base64,${PNG_1PX_B64}`,
            },
          ],
        },
      ],
    })
    const tokens = json?.output_tokens
    report(
      '3.2 官方 token 预检（POST /v1/responses/input_tokens, 含图片）',
      ok && typeof tokens === 'number' && tokens > 0,
      ok ? `input_tokens=${tokens}` : `HTTP ${status} ${text}`,
    )
  } catch (err) {
    report('3.2 官方 token 预检', false, String(err))
  }
}

// ---- 5.1 image-01 文生图（POST /v1/image_generation, base64 输出）----
async function checkImageGeneration() {
  try {
    const { status, ok, json, text } = await post('/image_generation', {
      model: 'image-01',
      prompt: '一只可爱的橘猫，坐在窗台上，明亮光线，照片风格',
      aspect_ratio: '1:1',
      response_format: 'base64',
      n: 1,
    })
    const images = json?.data?.image_base64 ?? json?.data
    const gotImage =
      ok && Array.isArray(json?.data?.image_base64) && json.data.image_base64.length > 0
    report(
      '5.1 image-01 文生图（POST /v1/image_generation, base64 输出）',
      gotImage,
      gotImage
        ? `返回 ${json.data.image_base64.length} 张（base64 前 40 字符：${String(
            json.data.image_base64[0],
          ).slice(0, 40)}…）`
        : `HTTP ${status} ${text}`,
    )
  } catch (err) {
    report('5.1 image-01 文生图', false, String(err))
  }
}

console.log(`MiniMax 图片端到端验证`)
console.log(`  base = ${baseUrl}`)
console.log(`  model = ${model}`)
console.log('')

await checkImageUnderstanding()
await checkInputTokens()
await checkImageGeneration()

console.log('')
if (failed > 0) {
  console.error(`${failed} 项未通过。请核对 key/端点/模型名，或查看上方服务端原文。`)
  process.exit(1)
}
console.log('全部通过。')
