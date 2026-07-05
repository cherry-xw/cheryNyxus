import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import config from "@/utils/config.js";
import { logger } from "@/utils/logger/index.js";

/**
 * MIME 类型映射（自写 minimal static serve，无新依赖）
 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export interface CreateHttpServerOptions {
  webPort: number;
  staticDir: string;
}

/**
 * 创建 HTTP 服务器：
 * - GET /api/config → 返回 {wsPort, webPort, transport}，供前端自动构建 WS 连接地址
 * - 其余路径 → 静态 serve staticDir（SPA fallback 到 index.html）
 *
 * 协议规范见 docs/protocol.md「HTTP API」段。
 */
export function createHttpServer({ webPort, staticDir }: CreateHttpServerOptions) {
  const root = resolve(staticDir);

  if (!existsSync(root)) {
    logger.info(`HTTP 静态目录不存在: ${root}（serve 时返回 404，请先 pnpm web:build）`);
  }

  const server = createServer((req, res) => {
    handleRequest(req, res, root).catch((err) => {
      logger.info(`HTTP 错误: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    });
  });

  server.listen(webPort);
  logger.info(`HTTP 服务启动，端口: ${webPort}（静态目录: ${root}）`);

  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  const url = req.url ?? "/";

  // GET /api/config —— 前端 fetch 自动构建 WS 地址（见 protocol.md）
  if (url === "/api/config" || url.startsWith("/api/config?")) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        wsPort: config.server.port,
        webPort: config.server.web_port,
        transport: config.server.transport,
      }),
    );
    return;
  }

  // 静态文件 serve
  const pathname = decodeURIComponent(url.split("?")[0] ?? "/");
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safe);

  // 防目录越界
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const stats = await stat(filePath).catch(() => null);
  if (stats?.isFile()) {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    });
    res.end(data);
    return;
  }

  // SPA fallback —— hash 路由下未知路径回 index.html
  const indexData = await readFile(join(root, "index.html")).catch(() => null);
  if (indexData) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(indexData);
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
}
