import { z } from "zod";
import { spawn, type ChildProcess } from "child_process";
import { tool, type ToolResult } from "@/tool/base/toolCreator";
import { SupervisionLevel } from "@/config";
import { resolvePath, getWorkDir } from "@/utils/env.js";
import config from "@/config";

interface ProcessInfo {
  proc: ChildProcess;
  command: string;
  startTime: number;
  stdoutCache: string;
  stderrCache: string;
  status: "running" | "completed" | "killed";
}

// 进程追踪存储
const processMap = new Map<number, ProcessInfo>();
const timeoutMs = config.global.tool_execute_timeout ?? 60000;

const BashSchema = z.object({
  action: z
    .enum(["execute", "poll", "kill"])
    .describe("操作类型：execute=执行命令，poll=获取后续输出，kill=终止进程")
    .default("execute"),
  command: z
    .string()
    .describe("要执行的 bash 命令（action=execute 时必需）")
    .optional(),
  workdir: z
    .string()
    .describe(
      "工作目录（可选）。相对路径将基于初始工作目录解析，绝对路径直接使用",
    )
    .optional(),
  pid: z.number().describe("进程 PID（action=poll/kill 时必需）").optional(),
});

export default tool(
  "execute_command",
  `执行 bash 命令。支持指定工作目录。输出分为 stdout 和 stderr 两部分标注。如果执行时间超过${timeoutMs}ms触发超时。超时后返回PID，可通过 poll 获取后续输出，通过 kill 终止进程。`,
  BashSchema,
  async (input): Promise<ToolResult> => {
    const { action, command, workdir, pid } = input;

    // poll 操作（不参与去重）
    if (action === "poll") {
      if (!pid) {
        return { content: "[ERROR] poll 操作需要提供 pid 参数", hash: "" };
      }
      const info = processMap.get(pid);
      if (!info) {
        return { content: `[ERROR] 进程 PID ${pid} 不存在或已结束`, hash: "" };
      }

      let result = `[PID: ${pid}] [状态: ${info.status}]\n`;
      result += `[stdout]:\n${info.stdoutCache}\n`;
      if (info.stderrCache) result += `[stderr]:\n${info.stderrCache}\n`;
      return { content: result, hash: "" };
    }

    // kill 操作（不参与去重）
    if (action === "kill") {
      if (!pid) {
        return { content: "[ERROR] kill 操作需要提供 pid 参数", hash: "" };
      }
      const info = processMap.get(pid);
      if (!info) {
        return { content: `[ERROR] 进程 PID ${pid} 不存在或已结束`, hash: "" };
      }

      if (info.status !== "running") {
        return {
          content: `[ERROR] 进程 PID ${pid} 已结束（状态: ${info.status})`,
          hash: "",
        };
      }

      info.proc.kill("SIGTERM");
      info.status = "killed";

      let result = `[KILLED] 进程 PID ${pid} 已终止\n`;
      result += `[stdout]:\n${info.stdoutCache}\n`;
      if (info.stderrCache) result += `[stderr]:\n${info.stderrCache}\n`;
      return { content: result, hash: "" };
    }

    // execute 操作
    if (!command) {
      return { content: "[ERROR] execute 操作需要提供 command 参数", hash: "" };
    }

    // 解析工作目录
    let cwd: string;
    if (workdir) {
      cwd = workdir.startsWith("/") ? workdir : resolvePath(workdir);
    } else {
      cwd = getWorkDir();
    }

    // bash hash返回空字符串
    const hash = "";

    return new Promise((resolve) => {
      let timedOut = false;

      const proc = spawn(command, [], {
        shell: true,
        cwd,
      });

      const processPid = proc.pid!;
      const info: ProcessInfo = {
        proc,
        command,
        startTime: Date.now(),
        stdoutCache: "",
        stderrCache: "",
        status: "running",
      };
      processMap.set(processPid, info);

      // 设置超时定时器
      const timer = setTimeout(() => {
        timedOut = true;
        const triggerTime = new Date(info.startTime).toLocaleString('zh-CN', { hour12: false });
        resolve({
          content: `[TIMEOUT] 命令执行超时（PID: ${processPid}，进程仍在后台运行）\n[触发时间: ${triggerTime}]\n\n[stdout]:\n${info.stdoutCache}\n[stderr]:\n${info.stderrCache}\n\n提示：使用 poll 操作获取后续输出，使用 kill 操作终止进程`,
          hash, // timeout也返回hash，可能需要去重
        });
      }, timeoutMs);

      // 收集输出
      proc.stdout.on("data", (data) => {
        info.stdoutCache += data.toString();
      });

      proc.stderr.on("data", (data) => {
        info.stderrCache += data.toString();
      });

      // 进程完成
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (!timedOut) {
          info.status = "completed";
          let result = "";
          if (code !== 0) {
            result = `[ERROR] 命令退出码: ${code}\n\n`;
          }
          result += `[PID: ${processPid}]\n`;
          result += `[stdout]:\n${info.stdoutCache}\n`;
          if (info.stderrCache) result += `[stderr]:\n${info.stderrCache}\n`;
          if (!info.stdoutCache && !info.stderrCache) {
            result += "[无输出]\n";
          }
          resolve({ content: result, hash });
        }
      });

      // 错误处理
      proc.on("error", (err) => {
        clearTimeout(timer);
        if (!timedOut) {
          info.status = "completed";
          resolve({
            content: `[ERROR] 命令执行失败: ${err.message}\n\n${info.stdoutCache ? `[stdout]:\n${info.stdoutCache}\n` : ""}${info.stderrCache ? `[stderr]:\n${info.stderrCache}` : ""}`,
            hash: "", // 错误情况不参与去重
          });
        }
      });
    });
  },
  SupervisionLevel.manual,
);
