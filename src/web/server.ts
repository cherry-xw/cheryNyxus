import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { logger } from "@/utils/logger/index.js";

/**
 * 解析 HTML 文件路径
 * 支持两种运行模式：
 * 1. 项目根目录运行（yarn dev）→ src/web/index.html
 * 2. dist 目录运行（node dist/index.js）→ dist/web/index.html
 */
function resolveHtmlPath(): string {
  // 使用 import.meta.url 获取当前文件所在目录（打包后是 dist/index.js 的目录）
  const currentDir = dirname(new URL(import.meta.url).pathname);
  const candidates = [
    resolve(currentDir, "web/index.html"),  // build 模式：dist/web/index.html
    resolve(currentDir, "src/web/index.html"),  // dev 模式（未打包）
    resolve(process.cwd(), "src/web/index.html"),  // fallback: 从 cwd 查找
    resolve(process.cwd(), "web/index.html"),  // fallback: dist 目录运行
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
