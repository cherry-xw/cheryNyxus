import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve, dirname, join, normalize, extname, sep } from "path";
import { fileURLToPath } from "url";
import { logger } from "@/utils/logger/index.js";
import config from "@/utils/config.js";

/**
 * 静态资源 MIME 映射
 * .js 必须用 text/javascript（非 application/javascript），否则 <script type="module"> 在部分浏览器不执行
 */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};

/**
 * 解析 web 目录路径
 * 支持两种运行模式：
 * 1. 项目根目录运行（yarn dev）→ src/web
 * 2. dist 目录运行（node dist/index.js）→ dist/web
 */
function resolveWebDir(): string {
  // Windows 下需用 fileURLToPath 正确转换 file:// URL 为本地路径
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "web"), // build 模式：dist/web/
    resolve(currentDir, "src/web"), // dev 模式（未打包）
    resolve(process.cwd(), "src/web"), // fallback: 从 cwd 查找
    resolve(process.cwd(), "web"), // fallback: dist 目录运行
  ];
  for (const p of candidates) {
    if (existsSync(p) && statSync(p).isDirectory()) return p;
  }
  return candidates[0]!; // fallback
}

/**
 * 可公开的配置信息（供前端自动构建 WebSocket URL）
 */
interface PublicConfig {
  wsPort: number;      // WebSocket 服务端口
  webPort: number;     // Web 页面端口
  transport: string;   // 传输格式：binary / json
}

/**
 * 获取可公开的配置
 */
function getPublicConfig(): PublicConfig {
  return {
    wsPort: config.server.port,
    webPort: config.server.web_port,
    transport: config.server.transport,
  };
}

/**
 * 启动 Web 静态文件服务（整目录）
 */
export function startWebServer(port: number): void {
  const webDir = resolveWebDir();
  logger.info(`Web 静态目录: ${webDir}`);

  // path traversal 防护基准：所有解析后路径必须在此根之下
  const safeRoot = webDir.endsWith(sep) ? webDir : webDir + sep;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    let pathname = decodeURIComponent(url.pathname);

    // API endpoint: 返回可公开配置
    if (pathname === "/api/config") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*", // 允许跨域
      });
      res.end(JSON.stringify(getPublicConfig()));
      return;
    }

    if (pathname === "/" || pathname === "") pathname = "/index.html";

    // 解析 + 规范化，path traversal 双重防护
    const requested = normalize(join(webDir, pathname));
    if (!requested.startsWith(safeRoot)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!existsSync(requested) || !statSync(requested).isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = extname(requested).toLowerCase();
    // 拒绝服务后端 .ts 源码（前端目录仅 .html/.js/.css 等静态资源）
    if (ext === ".ts") { res.writeHead(403); res.end("Forbidden"); return; }
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    try {
      const body = readFileSync(requested);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache", // 开发态禁缓存，改 js 刷新即生效
      });
      res.end(body);
    } catch {
      res.writeHead(500);
      res.end("Internal error");
    }
  });

  server.listen(port, () => {
    logger.info(`Web 静态服务启动，端口: ${port}`);
  });
}
