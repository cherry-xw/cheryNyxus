import type { RpcRouter, HandlerContext } from '../message/router.js'
import {
  Method,
  type TerminalCreateRequestData,
  type TerminalCreateResponseData,
  type TerminalInputRequestData,
  type TerminalInputResponseData,
  type TerminalResizeRequestData,
  type TerminalResizeResponseData,
  type TerminalCloseRequestData,
  type TerminalCloseResponseData,
} from '../message/types.js'
import { createTerminal, writeTerminal, resizeTerminal, closeTerminal } from './manager.js'
import { userOperation } from '../message/operationError.js'

async function handleCreate(
  _ctx: HandlerContext,
  data: TerminalCreateRequestData,
): Promise<TerminalCreateResponseData> {
  const session = await createTerminal(
    _ctx.connectionId,
    data.chatId,
    data.target,
    data.cols,
    data.rows,
  )
  return { sessionId: session.id, target: session.target, cols: session.cols, rows: session.rows }
}
async function handleInput(
  _ctx: HandlerContext,
  data: TerminalInputRequestData,
): Promise<TerminalInputResponseData> {
  writeTerminal(_ctx.connectionId, data.sessionId, data.data)
  return { sessionId: data.sessionId, accepted: true }
}
async function handleResize(
  _ctx: HandlerContext,
  data: TerminalResizeRequestData,
): Promise<TerminalResizeResponseData> {
  resizeTerminal(_ctx.connectionId, data.sessionId, data.cols, data.rows)
  return { sessionId: data.sessionId, cols: data.cols, rows: data.rows }
}
async function handleClose(
  _ctx: HandlerContext,
  data: TerminalCloseRequestData,
): Promise<TerminalCloseResponseData> {
  closeTerminal(_ctx.connectionId, data.sessionId)
  return { sessionId: data.sessionId, closed: true }
}

export function registerTerminalHandlers(router: RpcRouter): void {
  router.register(Method.TERMINAL_CREATE, (ctx, data) =>
    userOperation(() => handleCreate(ctx, data), 'Terminal 无法启动，请检查后端 Shell 和连接配置'),
  )
  router.register(Method.TERMINAL_INPUT, (ctx, data) =>
    userOperation(() => handleInput(ctx, data), 'Terminal 写入失败，请重新连接'),
  )
  router.register(Method.TERMINAL_RESIZE, (ctx, data) =>
    userOperation(() => handleResize(ctx, data), 'Terminal 尺寸更新失败，请重新连接'),
  )
  router.register(Method.TERMINAL_CLOSE, (ctx, data) =>
    userOperation(() => handleClose(ctx, data), 'Terminal 关闭失败，请刷新后重试'),
  )
}
