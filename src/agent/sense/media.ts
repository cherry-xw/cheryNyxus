import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { sense } from '@/core/sense'
import { SupervisionLevel } from '@/core/config'
import {
  callMediaService,
  saveMediaAsset,
  resolveMediaAsset,
  type MediaAsset,
  type MediaKind,
} from '@/service/media/index.js'
import { hashGenerator } from '@/utils/hash.js'

/** 从模型输出的参考图引用（/api/media/<file> 或 [[media:<file>]]）提取 filename。 */
const MEDIA_REF_RE = /(?:\/api\/media\/|\[\[media:)([a-f0-9-]+\.[a-z0-9]+)(?:\]\])?/i

function mediaSense(kind: MediaKind) {
  return sense(
    `generate_${kind}`,
    `生成${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}`,
    z.object({
      prompt: z.string().min(1),
      /**
       * 参考媒体引用（图生图/参考生成）：上下文里的图片引用（/api/media/<file> 或 [[media:<file>]]）。
       * 可选；提供时后端读资产作为参考图传给媒体服务（网关侧转 subject_reference 等）。
       */
      reference: z.string().optional(),
    }),
    async ({ prompt, reference }) => {
      let assets: MediaAsset[] = []
      const refMatch = reference ? reference.match(MEDIA_REF_RE) : undefined
      if (refMatch) {
        const asset = await resolveMediaAsset(refMatch[1]!)
        if (asset) assets = [asset]
      }
      const result = await callMediaService(kind, 'generate', {
        prompt,
        ...(assets.length > 0 ? { assets } : {}),
      })
      const created = await Promise.all(
        (result.assets ?? []).map(async (asset, index) =>
          saveMediaAsset(
            Buffer.from(asset.data, 'base64'),
            asset.mimeType,
            asset.filename ?? `${kind}-${index}`,
          ),
        ),
      )
      const content =
        [result.text, ...created.map((asset) => `/api/media/${asset.filename}`)]
          .filter(Boolean)
          .join('\n') || `未返回${kind}资产`
      return { content, hash: hashGenerator(`media-${kind}`, content) }
    },
    SupervisionLevel.smart,
    {
      // 生成类工具能力声明：产出对应媒体类型；图生图（reference 参考图）接收 image 输入。
      produces: [kind],
      ...(kind === 'image' ? { accepts: ['image'] } : {}),
    },
  )
}

export default [mediaSense('image'), mediaSense('video'), mediaSense('audio')]
