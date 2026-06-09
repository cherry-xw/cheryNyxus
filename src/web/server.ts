import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { logger } from "@/utils/logger/index.js";

/**
 * 解析 HTML 文件路径
 * Vite SSR 单文件构建，import.meta.url 指向 dist/index.js，无法用于定位 HTML
 * 使用 process.cwd() 作为项目根目录
 */
function resolveHtmlPath(): string {
  const root = process.cwd();
  const candidates = [
    resolve(root, "src/web/index.html"),  // dev 模式：源码目录
    resolve(root, "dist/web/index.html"),  // build 模式：产物目录
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0]!; // fallback
}

/**
 * 启动 Web 静态文件服务
 */
export function startWebServer(port: number): void {
  const htmlPath = resolveHtmlPath();
  logger.info(`Web HTML 路径: ${htmlPath}`);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/" || req.url === "/index.html") {
      try {
        const html = readFileSync(htmlPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("index.html not found");
      }
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(port, () => {
    logger.info(`Web 测试页面启动，端口: ${port}`);
  });
}
