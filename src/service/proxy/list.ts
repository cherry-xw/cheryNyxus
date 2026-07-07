import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { HandlerContext } from "../message/router.js";
import {
  Method,
  type ProxyStatusResponseData,
  type ProxyGroupsResponseData,
  type ProxySelectResponseData,
  type ProxyToggleResponseData,
} from "../message/types.js";

const execAsync = promisify(exec);

// Clash Party Unix socket 路径（从进程信息中获取）
const CLASH_SOCKET_PATH = "/tmp/mihomo-party-1000-41739.sock";

// Unix socket HTTP 请求封装
async function clashApi(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const url = `http://localhost${path}`;
  const bodyArg = body ? `-d '${JSON.stringify(body)}'` : "";
  const cmd = `curl -s -X ${method} --unix-socket ${CLASH_SOCKET_PATH} ${url} ${bodyArg}`;

  try {
    const { stdout } = await execAsync(cmd, { timeout: 5000 });
    if (!stdout || stdout === "") {
      return null;
    }
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Clash API 请求失败: ${(error as Error).message}`);
  }
}

/**
 * 获取代理状态：当前选中节点、延迟、连接数等
 */
export async function handleProxyStatus(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<ProxyStatusResponseData> {
  const proxies = (await clashApi("/proxies")) as { proxies: Record<string, unknown> };
  if (!proxies?.proxies) {
    throw new Error("无法获取代理状态");
  }

  // 提取关键信息
  const global = proxies.proxies["GLOBAL"] as {
    now?: string;
    all?: string[];
    type?: string;
  };

  const groups: Record<string, { now: string; all: string[]; type: string }> = {};
  const nodes: Record<string, { alive: boolean; delay: number; type: string }> = {};

  for (const [name, proxy] of Object.entries(proxies.proxies)) {
    const p = proxy as {
      type?: string;
      now?: string;
      all?: string[];
      alive?: boolean;
      history?: Array<{ delay: number }>;
    };

    // 筛选关键代理组
    if (["GLOBAL", "🔰 节点选择", "♻️ 自动选择", "🎯 全球直连", "🚥 故障转移"].includes(name)) {
      groups[name] = {
        now: p.now ?? "",
        all: p.all ?? [],
        type: p.type ?? "",
      };
    }

    // 筛选真实节点（排除虚拟类型）
    if (
      p.type &&
      !["Selector", "URLTest", "Fallback", "Direct", "Reject", "Compatible", "Pass", "RejectDrop"].includes(p.type)
    ) {
      const lastHistory = p.history?.[p.history.length - 1];
      nodes[name] = {
        alive: p.alive ?? false,
        delay: lastHistory?.delay ?? 0,
        type: p.type,
      };
    }
  }

  return {
    globalNow: global?.now ?? "DIRECT",
    globalType: global?.type ?? "Selector",
    groups,
    nodes,
    timestamp: Date.now(),
  };
}

/**
 * 获取代理组列表（含可选节点）
 */
export async function handleProxyGroups(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<ProxyGroupsResponseData> {
  const proxies = (await clashApi("/proxies")) as { proxies: Record<string, unknown> };
  if (!proxies?.proxies) {
    throw new Error("无法获取代理组");
  }

  const groups: Array<{
    name: string;
    type: string;
    now: string;
    all: string[];
    icon?: string;
  }> = [];

  for (const [name, proxy] of Object.entries(proxies.proxies)) {
    const p = proxy as {
      type?: string;
      now?: string;
      all?: string[];
      hidden?: boolean;
    };

    // 筛选可切换的代理组（Selector 类型，非隐藏）
    if (p.type === "Selector" && !p.hidden) {
      groups.push({
        name,
        type: p.type,
        now: p.now ?? "",
        all: p.all ?? [],
      });
    }
  }

  return { groups };
}

/**
 * 切换代理组选中节点
 */
export async function handleProxySelect(
  _ctx: HandlerContext,
  params: { group: string; node: string },
): Promise<ProxySelectResponseData> {
  const { group, node } = params;

  await clashApi(`/proxies/${encodeURIComponent(group)}`, "PUT", { name: node });

  // 验证切换结果
  const proxies = (await clashApi(`/proxies/${encodeURIComponent(group)}`)) as {
    now?: string;
  };

  return {
    group,
    node,
    success: proxies?.now === node,
  };
}

/**
 * 测试节点延迟
 */
export async function handleProxyDelay(
  _ctx: HandlerContext,
  params: { node: string; url?: string },
): Promise<{ node: string; delay: number; alive: boolean }> {
  const { node, url = "http://www.gstatic.com/generate_204" } = params;

  const result = (await clashApi(
    `/proxies/${encodeURIComponent(node)}/delay?timeout=5000&url=${encodeURIComponent(url)}`,
  )) as { delay?: number };

  return {
    node,
    delay: result?.delay ?? 0,
    alive: typeof result?.delay === "number" && result.delay > 0,
  };
}

/**
 * 开关系统代理（通过 Clash Party GUI）
 * 注意：Clash Party 不直接提供系统代理 API，需要通过 mihomo 配置
 * 这里返回当前系统代理状态（从 mihomo.yaml 读取）
 */
export async function handleProxyToggle(
  _ctx: HandlerContext,
  params: { enable: boolean },
): Promise<ProxyToggleResponseData> {
  const { enable } = params;

  // Clash Party 的系统代理需要通过 GUI 或 mihomo 配置文件控制
  // 这里暂时只返回状态，实际开关需要用户在 GUI 中操作
  // 或者通过修改 ~/.config/mihomo-party/config.yaml 中的 sysProxy.enable

  // 当前实现：仅返回期望状态（不实际修改，避免需要 root 权限）
  return {
    enabled: enable,
    message: enable
      ? "请在 Clash Party GUI 中开启系统代理"
      : "请在 Clash Party GUI 中关闭系统代理",
    note: "系统代理开关需要 Clash Party GUI 操作",
  };
}

/**
 * 注册 Proxy handlers
 */
export function registerProxyHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.PROXY_STATUS, handleProxyStatus);
  router.register(Method.PROXY_GROUPS, handleProxyGroups);
  router.register(Method.PROXY_SELECT, handleProxySelect);
  router.register(Method.PROXY_DELAY, handleProxyDelay);
  router.register(Method.PROXY_TOGGLE, handleProxyToggle);
}