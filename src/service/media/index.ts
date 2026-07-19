import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import config, { type MediaServiceConfig } from "@/utils/config.js";

export type MediaKind = "image" | "video" | "audio";

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  mimeType: string;
  filename: string;
  path: string;
  size: number;
}

const MIME_KIND: Record<string, MediaKind> = {
  "image/png": "image", "image/jpeg": "image", "image/webp": "image", "image/gif": "image",
  "video/mp4": "video", "video/webm": "video", "video/quicktime": "video",
  "audio/mpeg": "audio", "audio/wav": "audio", "audio/ogg": "audio", "audio/mp4": "audio", "audio/webm": "audio",
};

function mediaRoot(): string {
  return resolve(process.env.CHERY_DIR || process.cwd(), ".chery", "media");
}

export function mediaKindForMime(mimeType: string): MediaKind | undefined {
  return MIME_KIND[mimeType.toLowerCase()];
}

/** 按 kind 查找第一个已启用的命名媒体服务。旧 config.media[kind] 直查改为遍历命名服务集合。 */
function findMediaService(kind: MediaKind): (MediaServiceConfig & { name: string }) | undefined {
  if (!config.media) return undefined;
  for (const [name, svc] of Object.entries(config.media)) {
    if (svc.type === kind && svc.enabled && svc.url) return { ...svc, name };
  }
  return undefined;
}

const DEFAULT_MAX_UPLOAD_MB = 100;

export async function saveMediaAsset(body: Buffer, mimeType: string, originalName = "upload"): Promise<MediaAsset> {
  const kind = mediaKindForMime(mimeType);
  if (!kind) throw new Error("暂不支持这种媒体类型");
  const svc = findMediaService(kind);
  const maxMb = svc?.maxUploadMb ?? DEFAULT_MAX_UPLOAD_MB;
  const maxBytes = maxMb * 1024 * 1024;
  if (body.length === 0 || body.length > maxBytes) throw new Error(`媒体太大了（上限 ${maxMb}MiB）`);
  const id = randomUUID();
  const extension = extname(basename(originalName)).replace(/[^.a-z0-9]/gi, "") || ({ image: ".bin", video: ".bin", audio: ".bin" }[kind]);
  const filename = `${id}${extension}`;
  const root = mediaRoot();
  await mkdir(root, { recursive: true });
  const path = join(root, filename);
  await writeFile(path, body);
  return { id, kind, mimeType, filename, path, size: body.length };
}

export async function readMediaAsset(filename: string): Promise<{ data: Buffer; mimeType: string } | undefined> {
  if (!/^[a-f0-9-]+\.[a-z0-9]+$/i.test(filename)) return undefined;
  const path = join(mediaRoot(), filename);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const mimeByExtension: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4" };
  return { data: await readFile(path), mimeType: mimeByExtension[extname(filename).toLowerCase()] ?? "application/octet-stream" };
}

/** 媒体网关统一协议：网关接收 JSON，媒体二进制以 base64 编码，返回文本和/或 base64 资产。 */
export async function callMediaService(kind: MediaKind, operation: "understand" | "generate" | "edit", input: { prompt?: string; assets?: MediaAsset[] }): Promise<{ text?: string; assets?: Array<{ data: string; mimeType: string; filename?: string }> }> {
  const service = findMediaService(kind);
  if (!service) throw new Error(`媒体服务 "${kind}" 没开启，请在设置里检查`);
  const assets = await Promise.all((input.assets ?? []).map(async asset => ({
    id: asset.id, mimeType: asset.mimeType, filename: asset.filename, data: (await readFile(asset.path)).toString("base64"),
  })));
  const response = await fetch(service.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(service.key ? { Authorization: `Bearer ${service.key}` } : {}) },
    body: JSON.stringify({ operation, model: service.model, prompt: input.prompt, assets }),
  });
  if (!response.ok) throw new Error(`媒体服务 "${kind}" 暂时用不了`);
  return await response.json() as { text?: string; assets?: Array<{ data: string; mimeType: string; filename?: string }> };
}

/** 从本地受控资产生成理解结果，供聊天中间件在 LLM 调用前注入文本上下文。 */
export async function understandMediaReference(filename: string): Promise<{ kind: MediaKind; text: string }> {
  const asset = await readMediaAsset(filename);
  if (!asset) throw new Error("媒体文件不存在");
  const kind = mediaKindForMime(asset.mimeType);
  if (!kind) throw new Error("媒体类型不支持");
  const service = findMediaService(kind);
  if (!service) throw new Error(`媒体服务 "${kind}" 没开启，请在设置里检查`);
  const response = await fetch(service.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(service.key ? { Authorization: `Bearer ${service.key}` } : {}) },
    body: JSON.stringify({ operation: "understand", model: service.model, assets: [{ filename, mimeType: asset.mimeType, data: asset.data.toString("base64") }] }),
  });
  if (!response.ok) throw new Error(`媒体服务 "${kind}" 暂时用不了`);
  const result = await response.json() as { text?: string };
  if (!result.text) throw new Error(`媒体服务 "${kind}" 没返回结果`);
  return { kind, text: result.text };
}
