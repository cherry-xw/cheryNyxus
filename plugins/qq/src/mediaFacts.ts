import { z } from 'zod'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
export async function inspectMedia(file: string) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file], { maxBuffer: 65536 })
  return mediaFacts(JSON.parse(stdout))
}

const probeSchema = z.object({
  streams: z.array(z.object({
    codec_type: z.string(), codec_name: z.string().min(1).max(64).optional(),
    width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  })),
  format: z.object({ duration: z.union([z.string().min(1), z.number()]) }),
})

/** Describe the actual output, not the downloader's requested quality label. */
export function mediaFacts(probe: unknown) {
  const value = probeSchema.parse(probe)
  const video = value.streams.find(stream => stream.codec_type === 'video')
  const audio = value.streams.find(stream => stream.codec_type === 'audio')
  const durationSeconds = Number(value.format.duration)
  if (!video?.width || !video.height || !video.codec_name || !Number.isFinite(durationSeconds) || durationSeconds <= 0)
    throw new Error('视频成品信息无效，未加入发送队列')
  return { width: video.width, height: video.height, durationSeconds, videoCodec: video.codec_name,
    ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}) }
}
