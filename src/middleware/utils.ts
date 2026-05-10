import type { HistoryProxy } from "./types";
import type { LLMResponse } from "@/message/index";

/**
 * 创建 HistoryProxy（使用 Proxy 劫持 Array，兼容数组类型）
 */
export function createHistoryProxy(): HistoryProxy {
  const history: LLMResponse[] = [];
  let _lastAStagedIndex = -1;

  // 使用 Proxy 劫持数组操作
  const proxy = new Proxy(history, {
    get(target, prop) {
      // 劫持 push 方法
      if (prop === "push") {
        return function (item: LLMResponse) {
          target.push(item);
          if (item.role === "assistant") {
            _lastAStagedIndex = target.length - 1;
          }
        };
      }

      // 自定义属性
      if (prop === "_lastAssistantIndex") {
        return _lastAStagedIndex;
      }

      if (prop === "lastAssistant") {
        return _lastAStagedIndex >= 0 ? target[_lastAStagedIndex] : undefined;
      }

      // 其他属性直接访问原始数组
      const value = target[prop as keyof LLMResponse[]];
      // 绑定方法到原始数组（如 map/filter 等）
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as HistoryProxy;

  return proxy;
}
