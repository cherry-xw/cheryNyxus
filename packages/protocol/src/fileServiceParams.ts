import { z } from 'zod'

const prompt = z.string().min(1).refine(value => !!value.trim(), '请填写提示或问题')
const integer = z.number().int().safe()
const imageOptions = {
  size: z.enum(['1024x1024', '1536x1024', '1024x1536', 'auto']).optional(),
  quality: z.enum(['low', 'medium', 'high', 'auto']).optional(),
  background: z.enum(['transparent', 'opaque', 'auto']).optional(),
  output_format: z.enum(['png', 'jpeg', 'webp']).optional(),
  output_compression: integer.min(0).max(100).optional(),
  moderation: z.enum(['low', 'auto']).optional(),
}
/** Web 表单、AI 参数说明和执行入口共用的字段校验。型号间的限制仍由执行器复核。 */
export const FILE_SERVICE_ADAPTER_PARAM_SCHEMAS = {
  'minimax-images': z.object({ prompt: prompt.max(1500), n: integer.min(1).max(9).optional(),
    aspect_ratio: z.enum(['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9']).optional(),
    width: integer.min(512).max(2048).multipleOf(8).optional(), height: integer.min(512).max(2048).multipleOf(8).optional(),
    response_format: z.enum(['base64', 'url']).optional(), seed: integer.optional(), prompt_optimizer: z.boolean().optional(), aigc_watermark: z.boolean().optional(),
    style: z.object({ style_type: z.enum(['漫画', '元气', '中世纪', '水彩']), style_weight: z.number().gt(0).max(1).optional() }).strict().optional(),
  }).strict(),
  'openai-images': z.object({ prompt, ...imageOptions, n: integer.min(1).max(10).optional(), input_fidelity: z.enum(['low', 'high']).optional(), maskAssetId: z.string().min(1).optional(), response_format: z.literal('b64_json').optional() }).strict(),
  'openai-responses-image': z.object({ prompt, ...imageOptions, image_model: z.string().min(1).optional(), input_fidelity: z.enum(['low', 'high']).optional(), partial_images: z.literal(0).optional(), action: z.enum(['auto', 'generate', 'edit']).optional() }).strict(),
  'google-gemini-image': z.object({ prompt,
    imageConfig: z.object({ aspectRatio: z.enum(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']).optional(), imageSize: z.enum(['1K', '2K', '4K']).optional() }).strict().optional(),
    responseModalities: z.array(z.enum(['TEXT', 'IMAGE'])).min(1).optional(),
  }).strict(),
  'google-imagen': z.object({ prompt, sampleCount: integer.min(1).max(4).optional(), aspectRatio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']).optional(), personGeneration: z.enum(['dont_allow', 'allow_adult', 'allow_all']).optional(), outputOptions: z.object({ mimeType: z.enum(['image/png', 'image/jpeg']) }).strict().optional() }).strict(),
  'doubao-seedream': z.object({ prompt, size: z.string().regex(/^(1K|2K|4K|[1-9]\d{2,4}x[1-9]\d{2,4})$/).optional(), response_format: z.enum(['b64_json', 'url']).optional(), output_format: z.enum(['png', 'jpeg']).optional(), watermark: z.boolean().optional(), seed: integer.min(-1).max(2_147_483_647).optional(), sequential_image_generation: z.enum(['auto', 'disabled']).optional(), sequential_image_generation_options: z.object({ max_images: integer.min(1).max(15) }).strict().optional(), stream: z.literal(false).optional() }).strict(),
} as const
export type HttpFileServiceAdapterId = keyof typeof FILE_SERVICE_ADAPTER_PARAM_SCHEMAS
