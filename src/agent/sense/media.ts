import { Buffer } from "node:buffer";
import { z } from "zod";
import { sense } from "@/core/sense";
import { SupervisionLevel } from "@/core/config";
import { callMediaService, saveMediaAsset, type MediaKind } from "@/service/media/index.js";
import { hashGenerator } from "@/utils/hash.js";

function mediaSense(kind: MediaKind) {
  return sense(
    `generate_${kind}`,
    `生成${kind === "image" ? "图片" : kind === "video" ? "视频" : "音频"}`,
    z.object({ prompt: z.string().min(1) }),
    async ({ prompt }) => {
      const result = await callMediaService(kind, "generate", { prompt });
      const created = await Promise.all((result.assets ?? []).map(async (asset, index) =>
        saveMediaAsset(Buffer.from(asset.data, "base64"), asset.mimeType, asset.filename ?? `${kind}-${index}`),
      ));
      const content = [result.text, ...created.map(asset => `/api/media/${asset.filename}`)].filter(Boolean).join("\n") || `未返回${kind}资产`;
      return { content, hash: hashGenerator(`media-${kind}`, content) };
    },
    SupervisionLevel.confirm,
  );
}

export default [mediaSense("image"), mediaSense("video"), mediaSense("audio")];
