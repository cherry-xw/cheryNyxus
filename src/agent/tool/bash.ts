import { z } from "zod";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { tool, type ToolResult } from "@/core/tool";
import { SupervisionLevel } from "@/core/config";
import { getWorkDir } from "@/utils/env.js";
import config from "@/utils/config";
import {
  createLogFile,
  createLogStream,
  formatLogHeader,
  getLogSize,
  shouldShowPartialLog,
  getLogSizeThreshold,
  formatLogSize,
  cleanOldLogs,
  type BashLogInfo,
} from "@/utils/bashLogger.js";

const DEFAULT_TIMEOUT = config.global.tool_execute_timeout ?? 30000;
const LOG_RETENTION_HOURS = config.global.bash_log_retention_hours ?? 24;

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
  `执行 shell 命令（Unix: bash/sh，Windows: cmd/powershell）。默认超时时间${DEFAULT_TIMEOUT/1000}秒，超时后进程在后台继续运行，日志记录到临时文件。可使用 read_file 工具读取完整日志。如需切换工作目录，请在命令中使用 "cd <目录> && ..." 格式（Unix）或 "cd <目录> & ..." 格式（Windows）。`,
  BashSchema,
  async (input): Promise<ToolResult> => {
    const { command, description } = input;

    const startTime = Date.now();
    const logPath = createLogFile(startTime, startTime);
    const logStream = createLogStream(logPath);

    const hash = "";

    cleanOldLogs(LOG_RETENTION_HOURS);

    return new Promise((resolve) => {
      let timedOut = false;

      const proc = spawn(command, [], {
        shell: true,
        cwd: getWorkDir(),
      });

      const processPid = proc.pid!;

      const logInfo: BashLogInfo = {
        pid: processPid,
        command,
        startTime,
        logPath,
        description,
        status: 'running',
      };

      logStream.write(formatLogHeader(logInfo));

      const timer = setTimeout(() => {
        timedOut = true;

        logStream.write(`\n[Timeout Triggered]: ${new Date().toLocaleString('zh-CN', { hour12: false })}\n`);

        const logSize = getLogSize(logPath);
        const showPartial = shouldShowPartialLog(logPath);
        const threshold = getLogSizeThreshold();

        let partialLog: string;
        try {
          const content = readFileSync(logPath, 'utf-8');
          partialLog = showPartial ? content.substring(0, threshold) : content;
        } catch (err) {
          partialLog = `[ERROR] 读取日志失败: ${(err as Error).message}`;
        }

        let result = `[TIMEOUT] 命令执行超时（PID: ${processPid}）\n`;
        result += `[触发时间: ${new Date(startTime).toLocaleString('zh-CN', { hour12: false })}]\n\n`;

        if (showPartial) {
          result += `日志文件已生成：${logPath}\n`;
          result += `日志大小：${formatLogSize(logSize)}（超过${formatLogSize(threshold)}阈值，仅显示前${formatLogSize(threshold)}）\n\n`;
        } else {
          result += `进程仍在后台运行，日志记录位置：\n${logPath}\n\n`;
        }

        result += `最近输出：\n${partialLog}\n\n`;
        result += `提示：进程仍在运行，可稍后使用 read_file 工具读取完整日志文件`;

        resolve({
          content: result,
          hash,
        });
      }, DEFAULT_TIMEOUT);

      proc.stdout.on('data', (data) => {
        const output = data.toString();
        logStream.write(`[stdout]: ${output}\n`);
      });

      proc.stderr.on('data', (data) => {
        const output = data.toString();
        logStream.write(`[stderr]: ${output}\n`);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        logStream.write(`\n[Exit Code]: ${code}\n`);
        logStream.write(`[EndTime]: ${new Date().toLocaleString('zh-CN', { hour12: false })}\n`);
        logStream.end();

        if (!timedOut) {
          let logContent: string;
          try {
            logContent = readFileSync(logPath, 'utf-8');
          } catch (err) {
            logContent = `[ERROR] 读取日志失败: ${(err as Error).message}`;
          }

          let result = `[完成] 命令执行成功（PID: ${processPid}）\n`;
          if (code !== 0) {
            result = `[ERROR] 命令退出码: ${code}（PID: ${processPid}）\n`;
          }
          result += `\n${logContent}`;

          resolve({ content: result, hash });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        logStream.write(`\n[Error]: ${err.message}\n`);
        logStream.write(`[EndTime]: ${new Date().toLocaleString('zh-CN', { hour12: false })}\n`);
        logStream.end();

        if (!timedOut) {
          let logContent: string;
          try {
            logContent = readFileSync(logPath, 'utf-8');
          } catch {
            logContent = '';
          }

          resolve({
            content: `[ERROR] 命令执行失败: ${err.message}\n\n日志文件：${logPath}\n\n${logContent}`,
            hash,
          });
        }
      });
    });
  },
  SupervisionLevel.manual,
);