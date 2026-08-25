import { describe, it, expect } from "vitest";
import {
  registerProviderUrlPattern,
  getProviderUrlPattern,
} from "@/core/llm/urlPattern";

/**
 * Provider URL 模式注册表（docs/agent/provider.md「URL 解析与自动补全」）：
 * 纯数据注册表，只验证注册/获取/覆盖三态语义；解析行为由 resolveProviderUrl
 * （agent/provider/fetchBase.ts）消费，见 fetchBase.test.ts「resolveProviderUrl 统一入口」。
 */

describe("Provider URL 模式注册表", () => {
  it("未注册 → undefined（host 模式，不补全）", () => {
    expect(getProviderUrlPattern("not-registered")).toBeUndefined()
  })

  it("注册后可获取（openai 形态：端点由 SDK 自拼）", () => {
    registerProviderUrlPattern("openai", { chatEndpoint: "", modelsEndpoint: "" })
    expect(getProviderUrlPattern("openai")).toEqual({ chatEndpoint: "", modelsEndpoint: "" })
  })

  it("可只声明 chatEndpoint（models 未声明 = 该 kind 不支持/host 模式）", () => {
    registerProviderUrlPattern("bigmodel", { chatEndpoint: "/chat/completions" })
    const pattern = getProviderUrlPattern("bigmodel")
    expect(pattern?.chatEndpoint).toBe("/chat/completions")
    expect(pattern?.modelsEndpoint).toBeUndefined()
  })

  it("重复注册覆盖（后注册生效）", () => {
    registerProviderUrlPattern("dup", { chatEndpoint: "/a" })
    registerProviderUrlPattern("dup", { chatEndpoint: "/b", modelsEndpoint: "/c" })
    expect(getProviderUrlPattern("dup")).toEqual({ chatEndpoint: "/b", modelsEndpoint: "/c" })
  })
})
