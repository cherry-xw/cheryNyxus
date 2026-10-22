import { Document, Microphone, Picture, VideoCamera } from '@element-plus/icons-vue'

export const BRAIN_MEDIA_OPTIONS = [
  { key: 'image', label: '图片', icon: Picture, inputEmoji: '🖼️', outputEmoji: '🎨' },
  { key: 'video', label: '视频', icon: VideoCamera, inputEmoji: '🎞️', outputEmoji: '🎬' },
  { key: 'audio', label: '音频', icon: Microphone, inputEmoji: '🔊', outputEmoji: '🎵' },
  { key: 'file', label: '文件', icon: Document, inputEmoji: '📄', outputEmoji: '📄' },
] as const

export type BrainMediaKind = (typeof BRAIN_MEDIA_OPTIONS)[number]['key']
export type BrainMediaGroup = 'input' | 'output'
