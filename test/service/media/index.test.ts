/**
 * service/media/index 单元测试。
 *
 * 覆盖（P6c attachments round-trip 兜底）：
 * - mediaKindForMime 各 mimeType 映射（image/video/audio + 边界）
 * - understandMediaReference 成功路径（mock fetch + mock config）
 * - understandMediaReference 失败路径（资产不存在 / 服务未配置 / 服务 4xx）
 * - saveMediaAsset 边界（不支持的 mimeType / 超大文件 / 空文件）
 *
 * 不覆盖：capability gate 在 chatMiddleware.enrichMediaInputs 内（plan 显式提及）——
 *   依赖 chatMiddleware + adapters 集成测试，参见 test/agent/middleware/chat.test.ts。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// mock node:fs/promises（saveMediaAsset 走 fs.writeFile，readMediaAsset 走 fs.stat + fs.readFile）
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from("fake-media-bytes")),
  stat: vi.fn().mockResolvedValue({ isFile: () => true }),
}));

// mock config（媒体服务配置：命名实体集合，每个服务有 type + url + enabled）
vi.mock("@/utils/config.js", () => ({
  default: {
    media: {
      "vision-svc": { type: "image", url: "http://media/img", enabled: true, model: "vision", maxUploadMb: 100 },
      "video-svc": { type: "video", url: "http://media/video", enabled: true, model: "video-u" },
      "audio-svc": { type: "audio", url: "http://media/audio", enabled: true, model: "audio-u" },
    },
  },
}));

// global fetch mock
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { mkdir, writeFile, stat } from "node:fs/promises";
import {
  mediaKindForMime,
  saveMediaAsset,
  readMediaAsset,
  understandMediaReference,
} from "@/service/media/index.js";

const mkdirMock = vi.mocked(mkdir);
const writeFileMock = vi.mocked(writeFile);
const statMock = vi.mocked(stat);

describe("mediaKindForMime", () => {
  it("image 类：png/jpeg/webp/gif → image", () => {
    expect(mediaKindForMime("image/png")).toBe("image");
    expect(mediaKindForMime("image/jpeg")).toBe("image");
    expect(mediaKindForMime("image/webp")).toBe("image");
    expect(mediaKindForMime("image/gif")).toBe("image");
  });

  it("video 类：mp4/webm/quicktime → video", () => {
    expect(mediaKindForMime("video/mp4")).toBe("video");
    expect(mediaKindForMime("video/webm")).toBe("video");
    expect(mediaKindForMime("video/quicktime")).toBe("video");
  });

  it("audio 类：mpeg/wav/ogg/mp4/webm → audio", () => {
    expect(mediaKindForMime("audio/mpeg")).toBe("audio");
    expect(mediaKindForMime("audio/wav")).toBe("audio");
    expect(mediaKindForMime("audio/ogg")).toBe("audio");
    expect(mediaKindForMime("audio/mp4")).toBe("audio");
    expect(mediaKindForMime("audio/webm")).toBe("audio");
  });

  it("大小写不敏感", () => {
    expect(mediaKindForMime("IMAGE/PNG")).toBe("image");
  });

  it("未知 mimeType → undefined", () => {
    expect(mediaKindForMime("application/pdf")).toBeUndefined();
    expect(mediaKindForMime("text/plain")).toBeUndefined();
    expect(mediaKindForMime("")).toBeUndefined();
  });
});

describe("understandMediaReference", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // 恢复 stat 默认（mockResolvedValueOnce 跨测试可能残留覆盖）
    statMock.mockReset();
    statMock.mockResolvedValue({ isFile: () => true });
  });

  it("成功路径：fetch 返 text → 解析 kind + text", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: "图片描述：一只猫" }),
    });
    const result = await understandMediaReference("abc-123.png");
    expect(result.kind).toBe("image");
    expect(result.text).toBe("图片描述：一只猫");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://media/img");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("资产不存在 → throw '媒体资产不存在'", async () => {
    statMock.mockResolvedValueOnce(undefined as never);
    await expect(understandMediaReference("nonexistent.png")).rejects.toThrow(/媒体资产不存在/);
  });

  it("服务 4xx → throw '<kind> 媒体服务理解请求失败'", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(understandMediaReference("abc.mp4")).rejects.toThrow(/video 媒体服务理解请求失败/);
  });

  it("服务返回无 text → throw '媒体服务未返回理解文本'", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });
    await expect(understandMediaReference("abc.mp3")).rejects.toThrow(/未返回理解文本/);
  });
});

describe("saveMediaAsset", () => {
  beforeEach(() => {
    mkdirMock.mockClear();
    writeFileMock.mockClear();
  });

  it("正常路径：写入 .chery/media/<uuid>.<ext>", async () => {
    const buf = Buffer.from("png-bytes");
    const asset = await saveMediaAsset(buf, "image/png", "cat.png");
    expect(asset.kind).toBe("image");
    expect(asset.mimeType).toBe("image/png");
    expect(asset.size).toBe(buf.length);
    expect(asset.filename).toMatch(/^[a-f0-9-]+\.png$/);
    expect(asset.id).toBeDefined();
    expect(asset.path).toContain(".chery/media");
  });

  it("不支持的 mimeType → throw '不支持的媒体类型'", async () => {
    await expect(saveMediaAsset(Buffer.from("x"), "application/pdf", "x.pdf")).rejects.toThrow(
      /不支持的媒体类型/,
    );
  });

  it("空 body → throw '媒体文件大小'", async () => {
    await expect(saveMediaAsset(Buffer.alloc(0), "image/png", "empty.png")).rejects.toThrow(
      /媒体文件大小/,
    );
  });

  it("超大 body → throw '媒体文件大小'", async () => {
    const huge = Buffer.alloc(101 * 1024 * 1024); // 101MB > maxUploadMb 100
    await expect(saveMediaAsset(huge, "image/png", "huge.png")).rejects.toThrow(/媒体文件大小/);
  });
});

describe("readMediaAsset", () => {
  it("合法文件名 + 文件存在 → 返 {data, mimeType}", async () => {
    const result = await readMediaAsset("abc-123.png");
    expect(result).toBeDefined();
    expect(result!.mimeType).toBe("image/png");
    expect(result!.data).toBeInstanceOf(Buffer);
  });

  it("非法文件名（路径穿越） → undefined", async () => {
    expect(await readMediaAsset("../etc/passwd")).toBeUndefined();
    expect(await readMediaAsset("foo")).toBeUndefined();
  });

  it("文件不存在 → undefined", async () => {
    statMock.mockResolvedValueOnce(undefined as never);
    expect(await readMediaAsset("missing.png")).toBeUndefined();
  });
});