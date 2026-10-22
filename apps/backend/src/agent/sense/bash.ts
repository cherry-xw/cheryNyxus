import { z } from 'zod'
import { StringDecoder } from 'node:string_decoder'
import { directContainerExecution } from '@/core/security/executionMode.js'
import { sense, type SenseResult } from '@/core/sense'
import { SupervisionLevel } from '@/core/config'
import config from '@/utils/config'
import { getCommandRuntime } from '@/service/commands.js'
import { registerHostCommand, releaseHostCommand, requestHostCommandStop } from '@/service/hostCommands.js'
import type { RunningCommand } from '@/service/commandRuntime.js'
import { getRootChatId } from '@/db/chat.js'
import { getActiveChatRunId } from '@/service/chat/runtimeCache.js'
import { createEnvLogRedactor } from '@/utils/envGuard.js'
import {
  resolveShellExecutable,
  resolveCommandWorkdir,
  spawnSandboxedCommand,
} from '@/core/security/sandbox.js'

/** Bash 工具执行结果结构 */
interface BashResult {
  status: 'success' | 'timeout' | 'error'
  pid: number
  exitCode?: number
  duration: number
  command: string
  description: string
  output: string
  message?: string
}

/** 格式化 BashResult 为字符串 */
function formatBashResult(result: BashResult): string {
  let content = `状态: ${result.status}\n`
  content += `进程ID: ${result.pid}\n`
  if (result.exitCode !== undefined) {
    content += `退出码: ${result.exitCode}\n`
  }
  content += `执行时长: ${result.duration}ms\n`
  if (result.message) {
    content += `说明: ${result.message}\n`
  }

  // output 截取策略：超过30行显示前15+后15，中间省略
  const outputLines = result.output.split('\n')
  if (outputLines.length > 30) {
    const first15 = outputLines.slice(0, 15).join('\n')
    const last15 = outputLines.slice(-15).join('\n')
    const middleCount = outputLines.length - 30
    content += `\n[输出]\n${first15}\n... 省略 ${middleCount} 行 ...\n${last15}`
  } else {
    content += `\n[输出]\n${result.output}`
  }

  return content
}

const BashSchema = z.object({
  shell: z.enum(['bash', 'powershell']).describe('脚本方言，必须显式指定'),
  command: z.string().describe('要执行的脚本源码'),
  description: z.string().describe('命令说明描述命令用途'),
  workdir: z
    .string()
    .optional()
    .describe('命令工作目录；相对路径以服务进程当前目录为基准，缺省为服务进程当前目录'),
})

export default sense(
  'execute_command',
  `按部署配置直接执行或在 OS 沙箱中按精确 argv 执行 Bash 或 PowerShell。必须显式指定 shell；workdir 独立于会话工作区，缺省为服务进程当前目录。`,
  BashSchema,
  async (input, _senseSharedData, senseCtx): Promise<SenseResult> => {
    const { shell, command, description, workdir } = input

    const startTime = Date.now()
    const hash = ''
    const timeoutMs = config.global.sense_execute_timeout ?? DEFAULT_GLOBAL_OPTIONS.sense_execute_timeout
    const chatId = senseCtx?.chatId
    senseCtx?.signal?.throwIfAborted()

    if (!directContainerExecution() && !senseCtx?.security?.requiredSandboxMode) {
      return {
        content:
          '状态: error\n说明: 缺少已复核的沙箱授权，已拒绝执行命令。请通过统一工具门的审批后重试。',
      }
    }

    let cwd: string
    let sandboxed: ReturnType<typeof spawnSandboxedCommand>
    let monitored: RunningCommand | undefined
    let instanceId = ''
    let cancellationRequested = false
    try {
      cwd = resolveCommandWorkdir(workdir)
      const shellCommand = resolveShellExecutable(shell)
      if (chatId) {
        const runtime = getCommandRuntime()
        instanceId = runtime.options.backendInstanceId
        monitored = runtime.start({ chatId, rootChatId: getRootChatId(chatId), runId: getActiveChatRunId(chatId) ?? null,
          toolCallId: senseCtx?.messageId ?? null, sourceKind: 'host_bash', command, description, workdir: cwd }, () => {
          cancellationRequested = true
          if (sandboxed?.process.pid) requestHostCommandStop(sandboxed.process.pid)
        })
      }
      sandboxed = spawnSandboxedCommand({
        executable: shellCommand.executable,
        args: [...shellCommand.args, command],
        cwd,

        mode: directContainerExecution()
          ? 'danger-full-access'
          : senseCtx!.security!.requiredSandboxMode!,
      })
    } catch (error) {
      await monitored?.finish({ status: 'exited', exitCode: null })
      return { content: `状态: error\n说明: ${(error as Error).message}` }
    }

    return new Promise((resolve) => {
      let timedOut = false
      let outputOpening = ''
      let outputLatest = ''
      let omitted = false
      let spawnError: Error | undefined
      const redactors = { stdout: createEnvLogRedactor(), stderr: createEnvLogRedactor() }
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
      const preview = (text: string) => {
        const room = 32_768 - outputOpening.length
        outputOpening += text.slice(0, Math.max(0, room))
        outputLatest += text.slice(Math.max(0, room))
        if (outputLatest.length > 32_768) { outputLatest = outputLatest.slice(-32_768); omitted = true }
      }
      const output = () => outputOpening + (omitted ? '\n[输出过长，已省略中间内容；完整保留范围请查看命令日志]\n' : '') + outputLatest

      const proc = sandboxed.process

      const processPid = proc.pid ?? 0
      if (chatId && monitored && proc.pid) {
        registerHostCommand(chatId, proc, monitored, instanceId)
        monitored.started(String(proc.pid))
      }
      const cancel = () => {
        cancellationRequested = true
        if (monitored) void monitored.requestCancel().catch(() => {})
        else { try { proc.kill('SIGTERM') } catch { /* Wait for close, not a signal ACK. */ } }
      }
      senseCtx?.signal?.addEventListener('abort', cancel, { once: true })
      if (senseCtx?.signal?.aborted) cancel()
      for (const stream of ['stdout', 'stderr'] as const) proc[stream].on('data', (data: Buffer) => {
        monitored?.write(stream, data)
        preview(decoders[stream].write(redactors[stream].write(data)))
      })

      const timer = setTimeout(() => {
        timedOut = true
        const endTime = Date.now()
        const duration = endTime - startTime

        monitored?.background()

        const result: BashResult = {
          status: 'timeout',
          pid: processPid,
          duration,
          command,
          description,
          output: output(),
          message: '进程进入后台运行',
        }

        resolve({ content: formatBashResult(result), hash })
      }, timeoutMs)

      proc.once('close', (code, signal) => {
        clearTimeout(timer)
        senseCtx?.signal?.removeEventListener('abort', cancel)
        sandboxed.cleanup()
        for (const stream of ['stdout', 'stderr'] as const) {
          preview(decoders[stream].write(redactors[stream].end()))
          preview(decoders[stream].end())
        }
        const cancelled = cancellationRequested || monitored?.snapshot().status === 'cancel_requested'
        const finalized = (async () => {
          if (proc.pid) await releaseHostCommand(proc.pid, instanceId)
          await monitored?.finish({ status: cancelled && signal ? 'killed' : 'exited', exitCode: code, signal })
        })()
        void Promise.resolve(finalized).then(() => {
          if (timedOut) return
          const endTime = Date.now()
          const duration = endTime - startTime

          const result: BashResult = {
            status: code === 0 ? 'success' : 'error',
            pid: processPid,
            exitCode: code ?? undefined,
            duration,
            command,
            description,
            output: output(),
            ...(spawnError ? { message: spawnError.message } : {}),
          }

          resolve({ content: formatBashResult(result), hash,
            ...(cancelled ? { status: 'cancelled' as const, errorCode: 'cancelled' as const } : {}) })
        })
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        // Node emits close after error; a kill/send error alone is not exit evidence.
        spawnError = err
      })
    })
  },
  SupervisionLevel.smart,
)
import { DEFAULT_GLOBAL_OPTIONS } from '@chery/protocol'
