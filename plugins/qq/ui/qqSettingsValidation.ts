export type QQSettingsCategory = 'targets'|'conversation'|'interaction'|'messages'|'memory'|'worker'
export interface QQSettingsIssue { path:string; message:string; category:QQSettingsCategory; label:string }

const labels:Record<string,string>={groups:'允许的群号',users:'允许私聊的 QQ 号',bindings:'目标与预设绑定',schemaVersion:'配置格式',
  continuationTtlMs:'活跃讨论超时',messageMergeMs:'连续消息合并等待',queueLimit:'每目标队列上限',maxMessageChars:'回复分片字数',
  backgroundMessageLimit:'本次背景消息上限',managementHistoryLimit:'管理历史显示上限',backgroundMaxChars:'背景文字上限',backgroundMaxAgeMs:'背景有效期',
  waitIntervalSeconds:'等待反馈间隔',waitMessageMode:'等待文案顺序',waitMessages:'等待文案',toolIcons:'工具图标映射',
  memoryMaxEntries:'记忆条数上限',memoryMaxChars:'每条记忆字数',memoryContextChars:'记忆注入字数预算',memoryConsolidateRatio:'记忆整理触发比例',memoryTargetRatio:'记忆整理目标比例',publicTermsMaxEntries:'公共词义条数上限',
  'learning.maxCallsPerHour':'自动学习调用上限','learning.maxPending':'待处理学习任务上限',summaryPrompt:'讨论摘要提示词',systemPrompt:'QQ 补充说明',
  pokeCooldownMs:'戳一戳冷却',mentionCooldownMs:'@ 间隔',voiceMaxChars:'语音字数上限',voiceDefaultCharacter:'固定声音',voiceMode:'语音使用方式',
  'imageStorage.singleBytes':'单张原图上限','imageStorage.totalBytes':'全部目标原图额度','imageStorage.perTargetBytes':'每个目标原图额度',
  workerCpuCores:'执行容器 CPU 核数上限',workerMemoryMb:'执行容器内存上限',workerPidsLimit:'执行容器进程数上限',workerMaxDownloadMb:'单次视频下载上限',workerBubbleVideoMaxMb:'视频气泡上限',workerProgressIntervalMinutes:'下载进度通报间隔',workerThreadCount:'视频下载与转换线程数',
  mode:'参与方式',initiative:'参与倾向',style:'表达风格',customStyle:'表达补充',batchWaitMs:'聚合等待',minCheckIntervalMs:'非活跃观察间隔',maxChecksPerHour:'每群每小时观察次数',minReplyIntervalMs:'新参与间隔',contextReadLimit:'判断前补查次数'}

export function qqSettingIssue(issue:{path:readonly PropertyKey[];message:string}):QQSettingsIssue {
  const path=issue.path.map(String).join('.'),root=String(issue.path[0]??'')
  const category:QQSettingsCategory=root==='conversation'||root==='systemPrompt'||root==='linkAutoDownloadEnabled'?'conversation'
    :root.startsWith('memory')||root.startsWith('publicTerms')||root.startsWith('learning')||root==='summaryPrompt'?'memory'
    :root.startsWith('worker')?'worker':root.startsWith('voice')||['pokeEnabled','pokeCooldownMs','mentionCooldownMs','reactionEnabled'].includes(root)?'interaction'
    :['schemaVersion','selfId','groups','users','bindings'].includes(root)?'targets':'messages'
  return {path,message:issue.message,category,label:labels[path]??labels[root]??labels[String(issue.path.at(-1))]??'QQ 设置'}
}
export const qqSettingErrorId=(path:string)=>`qq-setting-error-${encodeURIComponent(path)}`
