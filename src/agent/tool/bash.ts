import { z } from "zod";
import { spawn } from "child_process";
import { writeFileSync } from "fs";
import { tool, type ToolResult } from "@/core/tool";
import { SupervisionLevel } from "@/core/config";
import config from "@/utils/config";
import {
  createBashLogPath,
  formatBashLogHeader,
  cleanOldBashLogs,
  type BashLogInfo,
} from "@/utils/bashLogger.js";

const DEFAULT_TIMEOUT = config.global.tool_execute_timeout ?? 30000;
const LOG_RETENTION_HOURS = config.global.bash_log_retention_hours ?? 24;

/** Bash 工具执行结果结构 */
interface BashResult {
  status: 'success' | 'timeout' | 'error';
  pid: number;
  exitCode?: number;
  duration: number;
  command: string;
  description: string;
  output: string;
  logPath?: string;
  message?: string;
}

/** 格式化 BashResult 为字符串 */
function formatBashResult(result: BashResult): string {
  let content = `状态: ${result.status}\n`;
  content += `进程ID: ${result.pid}\n`;
  if (result.exitCode !== undefined) {
    content += `退出码: ${result.exitCode}\n`;
  }
  content += `执行时长: ${result.duration}ms\n`;
  if (result.logPath) {
    content += `日志路径: ${result.logPath}（详细信息使用 read_file 读取）\n`;
  }
  if (result.message) {
    content += `说明: ${result.message}\n`;
  }

  // output 截取策略：超过30行显示前15+后15，中间省略
  const outputLines = result.output.split('\n');
  if (outputLines.length > 30) {
    const first15 = outputLines.slice(0, 15).join('\n');
    const last15 = outputLines.slice(-15).join('\n');
    const middleCount = outputLines.length - 30;
    content += `\n[输出]\n${first15}\n... 省略 ${middleCount} 行 ...\n${last15}`;
  } else {
    content += `\n[输出]\n${result.output}`;
  }

  return content;
}

const BashSchema = z.object({
  command: z
    .string()
    .describe("要执行的 bash 命令"),
  description: z
    .string()
    .describe("命令说明描述命令用途"),
});

export default tool(
  "execute_command",
  `执行 shell 命令（Unix: bash/sh，Windows: cmd/powershell）。如需切换工作目录，请在命令中使用 "cd <目录> && ..." 格式`,
  BashSchema,
  async (input): Promise<ToolResult> => {
    const { command, description } = input;

    const startTime = Date.now();
    const hash = "";

    cleanOldBashLogs(LOG_RETENTION_HOURS);

    return new Promise((resolve) => {
      let timedOut = false;
      let outputBuffer = ''; // 实时累积 stdout/stderr

      const proc = spawn(command, [], {
        shell: true,
      });

      const processPid = proc.pid!;

      proc.stdout.on('data', (data) => {
        outputBuffer += data.toString();
      });

      proc.stderr.on('data', (data) => {
        outputBuffer += data.toString();
      });

      const timer = setTimeout(() => {
        timedOut = true;
        const endTime = Date.now();
        const duration = endTime - startTime;

        // 超时场景：创建日志文件，进程进入后台运行
        const logPath = createBashLogPath(startTime, endTime);
        const logInfo: BashLogInfo = {
          pid: processPid,
          command,
          startTime,
          logPath,
          description,
          status: 'running',
        };
        writeFileSync(logPath, formatBashLogHeader(logInfo) + outputBuffer);

        const result: BashResult = {
          status: 'timeout',
          pid: processPid,
          duration,
          command,
          description,
          output: outputBuffer,
          logPath,
          message: '进程进入后台运行',
        };

        resolve({ content: formatBashResult(result), hash });
      }, DEFAULT_TIMEOUT);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (!timedOut) {
          const endTime = Date.now();
          const duration = endTime - startTime;

          const result: BashResult = {
            status: code === 0 ? 'success' : 'error',
            pid: processPid,
            exitCode: code ?? undefined,
            duration,
            command,
            description,
            output: outputBuffer,
          };

          resolve({ content: formatBashResult(result), hash });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (!timedOut) {
          const endTime = Date.now();
          const duration = endTime - startTime;

          const result: BashResult = {
            status: 'error',
            pid: processPid,
            duration,
            command,
            description,
            output: outputBuffer,
            message: err.message,
          };

          resolve({ content: formatBashResult(result), hash });
        }
      });
    });
  },
  SupervisionLevel.manual,
);