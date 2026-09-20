import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { IPty } from 'node-pty'
import type { Client, ClientChannel } from 'ssh2'
import type { TerminalTarget, TerminalEventNotificationData } from '../message/types.js'
import { createNotification } from '../message/types.js'
import { operationError } from '../message/operationError.js'
import { connectionManager } from '../websocket/connection.js'
import { transport } from '../websocket/transport.js'
import { getCredentialSecret, getCredentialUsername } from '@/utils/secretStore.js'
import { getTrustedSshHostKey, trustSshHostKey } from '@/utils/sshHostStore.js'
import { resolveChatWorkspaceEntry } from '../workspace/sandbox.js'

type Session = {
  id: string
  owner: string
  cols: number
  rows: number
  lastInput: number
  target: { kind: 'local' | 'ssh'; label: string }
  local?: IPty
  client?: Client
  stream?: ClientChannel
  closed: boolean
}
const sessions = new Map<string, Session>()
const requireRuntime = createRequire(import.meta.url)
const IDLE_MS = 30 * 60_000

function emit(session: Session, event: Omit<TerminalEventNotificationData, 'sessionId'>): void {
  const ws = connectionManager.getWsByConnectionId(session.owner)
  if (!ws || ws.readyState !== 1) {
    dispose(session)
    return
  }
  try {
    if (ws.bufferedAmount > 2 * 1024 * 1024) {
      ws.send(
        transport.encode(
          createNotification('terminal.event', undefined, {
            sessionId: session.id,
            event: 'error',
            message: 'Terminal 输出过快，连接已关闭；请减少输出后重新连接',
          }),
        ),
      )
      ws.send(
        transport.encode(
          createNotification('terminal.event', undefined, {
            sessionId: session.id,
            event: 'exit',
            code: null,
          }),
        ),
      )
      dispose(session)
      return
    }
    ws.send(
      transport.encode(
        createNotification('terminal.event', undefined, { sessionId: session.id, ...event }),
      ),
    )
  } catch {
    dispose(session)
  }
}
function output(session: Session, chunk: string | Buffer): void {
  const text = String(chunk)
  for (let i = 0; i < text.length && !session.closed; i += 16384)
    emit(session, { event: 'output', data: text.slice(i, i + 16384) })
}
function dispose(session: Session): void {
  if (session.closed) return
  session.closed = true
  sessions.delete(session.id)
  try {
    session.local?.kill()
  } catch {
    /* already exited */
  }
  session.stream?.close()
  session.client?.end()
}
function finish(session: Session, code: number | null = null, signal: string | null = null): void {
  if (session.closed) return
  emit(session, { event: 'exit', code, signal })
  dispose(session)
}
export function matchesHostKey(key: Buffer, expected: string): boolean {
  return (
    'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '') ===
    expected.trim()
  )
}

export async function createTerminal(
  owner: string,
  chatId: string,
  target: TerminalTarget | undefined,
  cols = 100,
  rows = 30,
): Promise<Session> {
  if (!connectionManager.getWsByConnectionId(owner)) throw operationError('连接已断开，请重新连接')
  if (sessions.size >= 32 || [...sessions.values()].filter((s) => s.owner === owner).length >= 4)
    throw operationError('Terminal 数量已达上限，请先关闭已有终端')
  const session: Session = {
    id: randomUUID(),
    owner,
    cols,
    rows,
    lastInput: Date.now(),
    target: { kind: target?.kind ?? 'local', label: '' },
    closed: false,
  }
  sessions.set(session.id, session)
  try {
    if (target?.kind === 'ssh') {
      const username =
        target.username || (target.credentialId ? getCredentialUsername(target.credentialId) : '')
      const password =
        target.password ??
        (target.credentialId ? getCredentialSecret(target.credentialId) : undefined)
      if (!username || (!password && !target.privateKey))
        throw operationError('SSH 用户名或凭据不可用')
      const { Client } = requireRuntime('ssh2') as typeof import('ssh2')
      const client = new Client()
      session.client = client
      const expectedHostKey = getTrustedSshHostKey(target.host, target.port ?? 22)
      let observedHostKey: string | undefined
      session.target.label = 'SSH · ' + username + '@' + target.host + ':' + (target.port ?? 22)
      await new Promise<void>((resolve, reject) => {
        let ready = false
        let hostRejected = false
        const timer = setTimeout(() => reject(operationError('SSH 连接超时')), 20_000)
        const fail = () => {
          clearTimeout(timer)
          const message = hostRejected
            ? 'SSH 主机指纹不匹配，连接已拒绝'
            : 'SSH 连接失败，请检查主机、账号及凭据'
          if (!ready) reject(operationError(message))
          else {
            emit(session, { event: 'error', message })
            finish(session)
          }
        }
        client.on('error', fail)
        client.on('close', () => {
          clearTimeout(timer)
          if (!ready) reject(operationError('SSH 连接已关闭'))
          else finish(session)
        })
        client.once('ready', () => {
          if (session.closed) {
            clearTimeout(timer)
            reject(operationError('连接已取消'))
            return
          }
          client.shell({ term: 'xterm-256color', cols, rows }, (error, stream) => {
            clearTimeout(timer)
            if (error || session.closed) {
              stream?.close()
              reject(operationError('无法打开 SSH 交互终端'))
              return
            }
            session.stream = stream
            stream.setEncoding('utf8')
            stream.stderr.setEncoding('utf8')
            stream.on('data', (chunk: string) => output(session, chunk))
            stream.stderr.on('data', (chunk: string) => output(session, chunk))
            stream.on('error', () => {
              emit(session, { event: 'error', message: 'SSH 终端通道已断开，请重新连接' })
              finish(session)
            })
            stream.on('close', (code: number | undefined, signal: string | undefined) =>
              finish(session, code ?? null, signal ?? null),
            )
            if (!expectedHostKey && observedHostKey) {
              trustSshHostKey(target.host, target.port ?? 22, observedHostKey)
            }
            ready = true
            resolve()
          })
        })
        client.connect({
          host: target.host,
          port: target.port ?? 22,
          username,
          ...(password ? { password } : {}),
          ...(target.privateKey
            ? { privateKey: target.privateKey, passphrase: target.passphrase }
            : {}),
          readyTimeout: 15000,
          keepaliveInterval: 10000,
          keepaliveCountMax: 3,
          hostVerifier: (key: Buffer) => {
            observedHostKey = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
            hostRejected = !!expectedHostKey && observedHostKey !== expectedHostKey
            return !hostRejected
          },
        })
      })
    } else {
      const { absolute, stat } = await resolveChatWorkspaceEntry(chatId, target?.cwd ?? '')
      if (!stat.isDirectory()) throw operationError('Terminal 工作目录不是文件夹')
      if (session.closed) throw operationError('连接已取消')
      const pty = requireRuntime('node-pty') as typeof import('node-pty')
      const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh'
      session.target.label = '后端主机 · ' + absolute
      session.local = pty.spawn(shell, process.platform === 'win32' ? ['-NoLogo'] : [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: absolute,
        env: process.env,
      })
      session.local.onData((data) => output(session, data))
      session.local.onExit(({ exitCode, signal }) => {
        finish(session, exitCode, signal === undefined ? null : String(signal))
      })
    }
    if (session.closed) throw operationError('Terminal 连接已结束')
    return session
  } catch (error) {
    dispose(session)
    throw error
  }
}
export function getTerminal(owner: string, sessionId: string): Session {
  const session = sessions.get(sessionId)
  if (!session || session.closed || session.owner !== owner)
    throw operationError('Terminal 会话不存在或不属于当前连接')
  return session
}
export function writeTerminal(owner: string, sessionId: string, data: string): void {
  const session = getTerminal(owner, sessionId)
  session.lastInput = Date.now()
  if (session.local) session.local.write(data)
  else session.stream?.write(data)
}
export function resizeTerminal(owner: string, sessionId: string, cols: number, rows: number): void {
  const session = getTerminal(owner, sessionId)
  session.cols = cols
  session.rows = rows
  session.local?.resize(cols, rows)
  session.stream?.setWindow(rows, cols, 0, 0)
}
export function closeTerminal(owner: string, sessionId: string): void {
  finish(getTerminal(owner, sessionId))
}
export function closeAllTerminals(): void {
  for (const session of [...sessions.values()]) dispose(session)
}
connectionManager.onClose((owner) => {
  for (const session of [...sessions.values()]) if (session.owner === owner) dispose(session)
})
const idleTimer = setInterval(() => {
  for (const session of [...sessions.values()])
    if (Date.now() - session.lastInput > IDLE_MS) {
      emit(session, { event: 'error', message: 'Terminal 已空闲 30 分钟，连接已关闭' })
      finish(session)
    }
}, 60_000)
idleTimer.unref()
