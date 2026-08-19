import { logger } from '@/utils/logger/index.js'

/**
 * 致命启动错误（如端口被占用）上报。
 *
 * worker 监听端口失败（EADDRINUSE）时调用：先经 IPC 通知 guardian 该错误**不可重试**，
 * 再记录错误日志并退出进程。guardian 收到 `{type:"fatal", code, port}` 后停止重启循环
 * 并给出端口占用提示（见 docs/service/README.md「守护进程（guardian）双进程模型」）。
 *
 * 直接运行（无 guardian IPC 通道，`process.send` 为 undefined）时仅走日志 + 退出路径。
 */
export function reportFatalStartupError(reason: { code: string; port: number }): void {
  try {
    process.send?.({ type: 'fatal', code: reason.code, port: reason.port })
  } catch {
    // IPC 不可用或已断开（guardian 已退出）：仅走日志路径
  }
  logger.error(
    `[fatal] 启动失败：端口 ${reason.port} 已被占用（${reason.code}）。请释放该端口后重新启动。`,
  )
  process.exit(1)
}
