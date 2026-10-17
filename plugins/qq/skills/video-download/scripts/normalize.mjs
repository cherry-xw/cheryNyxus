import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, rename, unlink } from 'node:fs/promises'
const run = promisify(execFile)
export async function normalizeVideoFile(file, { maxBytes = Number(process.env.QQ_MAX_DOWNLOAD_BYTES || 1073741824) } = {}) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { maxBuffer: 262144 })
  const info = JSON.parse(stdout)
  const video = info.streams?.find(s => s.codec_type === 'video')
  const audio = info.streams?.find(s => s.codec_type === 'audio')
  if (!video || !(Number(info.format?.duration) > 0)) throw new Error('INVALID_VIDEO')
  const output = `${file}.normalized.mp4`
  try {
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', file, '-map', '0:v:0', '-map', '0:a:0?',
      ...(video.codec_name === 'h264' && video.pix_fmt === 'yuv420p' ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '23']),
      '-threads', String(process.env.QQ_WORKER_THREADS || 4),
      ...(audio ? ['-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k', '-ar', '48000', '-ac', '2'] : []),
      '-movflags', '+faststart', '-fs', String(maxBytes + 1), output], { maxBuffer: 262144 })
    if ((await stat(output)).size > maxBytes) throw new Error('SIZE_LIMIT')
    await rename(output, file)
  } finally { await unlink(output).catch(() => {}) }
}
export async function withDownloadLock(root, action) {
  // The controller serializes tasks and mounts only the current identity's media directory.
  return action()
}
