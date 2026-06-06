/**
 * 交互测试脚本
 * 与 yarn dev 启动的服务交互，日志存入 log/ 文件夹
 *
 * 测试流程：
 * 1. 看soul列表，没有特定的就创建，有就载入
 * 2. 找到之前特定的历史会话有就删除，没有就发起新的
 * 3. 发送和demo一样的问题，并审批
 * 4. 重启服务，载入之前的soul和对话，并发送：定位一下项目入口
 */

import WebSocket from "ws";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const WS_URL = "ws://localhost:8080";
const TARGET_BRAIN = "ali_glm5";
const LOG_DIR = join(process.cwd(), "log");

// 确保 log 目录存在
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = join(LOG_DIR, `interaction-${timestamp}.log`);

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  writeFileSync(LOG_FILE, line, { flag: "a" });
  console.log(message);
}

interface Request {
  id: string;
  kind: "request";
  method: string;
  params: unknown;
}

interface Response {
  id: string;
  kind: "response";
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface Notification {
  kind: "notification";
  type: string;
  requestId: string;
  data: unknown;
}

interface Chunk {
  kind: "chunk";
  type: string;
  requestId: string;
  seq?: number;
  data: unknown;
}

class InteractionTest {
  private ws: WebSocket;
  private requestId = 0;
  private pendingResponses = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private notifications: Array<Notification | Chunk> = [];
  private soulId: string | null = null;
  private chatId: string | null = null;
  /** 审批处理器（在收到 interrupt 时调用） */
  private approvalHandler: ((approvalId: string, senseName: string) => Promise<void>) | null = null;
  /** 当前等待的 request id */
  private waitingRequestId: string | null = null;

  constructor() {
    this.ws = new WebSocket(WS_URL);
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.on("open", () => {
        log("WebSocket 连接建立");
        resolve();
      });
      this.ws.on("error", (err) => {
        log(`WebSocket 错误: ${err.message}`);
        reject(err);
      });
      this.ws.on("message", (data) => {
        this.handleMessage(data);
      });
      this.ws.on("close", () => {
        log("WebSocket 连接关闭");
      });
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

    // 尝试解析为二进制帧
    if (buffer[0] === 0x01) {
      // Stream chunk
      const seq = buffer.readUInt32BE(1);
      const requestIdLen = buffer[5];
      const requestId = buffer.slice(6, 6 + requestIdLen).toString();
      const chunkData = JSON.parse(buffer.slice(6 + requestIdLen).toString());
      const chunk: Chunk = { kind: "chunk", type: "stream", requestId, seq, data: chunkData };
      this.notifications.push(chunk);
      log(`[Chunk] seq=${seq}, data=${JSON.stringify(chunkData).slice(0, 100)}`);
    } else if (buffer[0] === 0x02) {
      // Notification or staged chunk
      const msg = JSON.parse(buffer.slice(1).toString());
      if (msg.kind === "notification") {
        const notification = msg as Notification;
        this.notifications.push(notification);
        log(`[Notification] type=${msg.type}, data=${JSON.stringify(msg.data).slice(0, 100)}`);

        // 实时处理 interrupt
        if (msg.type === "interrupt" && this.approvalHandler && this.waitingRequestId) {
          const approvalData = notification.data as { approvalId: string; senseName: string };
          log(`收到审批请求: ${approvalData.senseName}`);
          // 异步处理审批，不阻塞消息处理
          this.approvalHandler(approvalData.approvalId, approvalData.senseName)
            .then(() => log(`审批处理完成: ${approvalData.senseName}`))
            .catch(err => log(`审批处理失败: ${err.message}`));
        }
      } else if (msg.kind === "chunk") {
        this.notifications.push(msg as Chunk);
        log(`[Chunk] type=${msg.type}, data=${JSON.stringify(msg.data).slice(0, 100)}`);
      }
    } else {
      // 纯 JSON 消息（CHERY_TRANSPORT=json 模式）或 Response
      try {
        const msg = JSON.parse(buffer.toString());
        if (msg.kind === "notification") {
          const notification = msg as Notification;
          this.notifications.push(notification);
          log(`[Notification] type=${notification.type}, data=${JSON.stringify(notification.data).slice(0, 100)}`);

          // 实时处理 interrupt
          if (notification.type === "interrupt" && this.approvalHandler && this.waitingRequestId) {
            const approvalData = notification.data as { approvalId: string; senseName: string };
            log(`收到审批请求: ${approvalData.senseName}`);
            this.approvalHandler(approvalData.approvalId, approvalData.senseName)
              .then(() => log(`审批处理完成: ${approvalData.senseName}`))
              .catch(err => log(`审批处理失败: ${(err as Error).message}`));
          }
        } else if (msg.kind === "chunk") {
          this.notifications.push(msg as Chunk);
          log(`[Chunk] type=${(msg as Chunk).type}, data=${JSON.stringify((msg as Chunk).data).slice(0, 100)}`);
        } else if (msg.kind === "response") {
          const response = msg as Response;
          const pending = this.pendingResponses.get(response.requestId);
          if (pending) {
            if (response.success) {
              pending.resolve(response.data);
            } else {
              pending.reject(new Error(response.error?.message || "Unknown error"));
            }
            this.pendingResponses.delete(response.requestId);
            // 只有当 Response.requestId 等于 waitingRequestId 时才清除 approvalHandler
            if (this.waitingRequestId === response.requestId) {
              this.waitingRequestId = null;
              this.approvalHandler = null;
            }
          }
          log(`[Response] requestId=${response.requestId}, success=${response.success}`);
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = `${++this.requestId}`;
    const req: Request = { id, kind: "request", method, params };

    return new Promise((resolve, reject) => {
      this.pendingResponses.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(req));
      log(`[Request] method=${method}, id=${id}`);
    });
  }

  async streamRequest(method: string, params: unknown): Promise<Array<Notification | Chunk>> {
    const id = `${++this.requestId}`;
    const req: Request = { id, kind: "request", method, params };

    this.notifications = [];

    return new Promise((resolve, reject) => {
      this.pendingResponses.set(id, {
        resolve: () => resolve(this.notifications),
        reject,
      });
      this.ws.send(JSON.stringify(req));
      log(`[StreamRequest] method=${method}, id=${id}`);
    });
  }

  async streamRequestWithApproval(
    method: string,
    params: unknown,
    handler: (approvalId: string, senseName: string) => Promise<void>,
  ): Promise<Array<Notification | Chunk>> {
    const id = `${++this.requestId}`;
    const req: Request = { id, kind: "request", method, params };

    this.notifications = [];
    this.approvalHandler = handler;
    this.waitingRequestId = id;

    return new Promise((resolve, reject) => {
      this.pendingResponses.set(id, {
        resolve: () => resolve(this.notifications),
        reject,
      });
      this.ws.send(JSON.stringify(req));
      log(`[StreamRequest] method=${method}, id=${id}`);
    });
  }

  async waitForNotification(type: string, timeout = 30000): Promise<Notification | undefined> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = this.notifications.find(n => n.kind === "notification" && n.type === type);
      if (found) return found as Notification;
      await new Promise(r => setTimeout(r, 100));
    }
    return undefined;
  }

  async run(): Promise<void> {
    try {
      await this.connect();

      // 1. soul.list → soul.create 或 soul.load
      log("=== Step 1: Soul 列表 ===");
      const listResult = await this.request("soul.list", {}) as { souls: Array<{ soulId: string; config: { model: string } }> };
      log(`现有 Souls: ${listResult.souls.length}`);

      const existing = listResult.souls.find(s => s.config.model.includes("glm"));
      if (existing) {
        this.soulId = existing.soulId;
        log(`使用现有 Soul: ${this.soulId}`);
        await this.request("soul.load", { soulId: this.soulId });
      } else {
        const createResult = await this.request("soul.create", { brain: TARGET_BRAIN }) as { soulId: string };
        this.soulId = createResult.soulId;
        log(`创建新 Soul: ${this.soulId}`);
      }

      // 2. chat.list → 查看历史
      log("=== Step 2: Chat 列表 ===");
      const chatListResult = await this.request("chat.list", { soulId: this.soulId }) as { chats: Array<{ chatId: string }> };
      log(`现有 Chats: ${chatListResult.chats.length}`);

      // 删除之前的聊天（如果有）
      for (const chat of chatListResult.chats) {
        log(`删除旧 Chat: ${chat.chatId}`);
        await this.request("chat.delete", { chatId: chat.chatId });
      }

      // 3. 发送问题 + 审批
      log("=== Step 3: 发送消息 ===");
      const prompt = "列出当前目录下的文件";
      const streamResult = await this.streamRequestWithApproval(
        "chat.send",
        { soulId: this.soulId, prompt },
        async (approvalId, senseName) => {
          await this.request("sense.approval", {
            soulId: this.soulId,
            approvalId,
            action: "accept",
          });
          log(`审批通过: ${senseName}`);
        },
      );

      // 等待完成
      const done = await this.waitForNotification("done", 60000);
      if (done) {
        log("聊天完成");
      }

      // 获取 chatId（从 response 中）
      const lastChunk = streamResult[streamResult.length - 1];
      if (lastChunk && lastChunk.kind === "chunk") {
        // chatId 在 response 中返回
      }

      // 4. 重启后载入历史对话（这里只是模拟，不实际重启）
      log("=== Step 4: 载入历史对话测试 ===");
      // 先获取 chatId
      const newChatList = await this.request("chat.list", { soulId: this.soulId }) as { chats: Array<{ chatId: string }> };
      if (newChatList.chats.length > 0) {
        this.chatId = newChatList.chats[0]!.chatId;
        log(`Chat ID: ${this.chatId}`);

        // 载入历史
        await this.streamRequest("chat.get", { chatId: this.chatId });
        log("历史载入完成");

        // 继续对话
        log("=== Step 5: 继续对话 ===");
        await this.streamRequestWithApproval(
          "chat.send",
          {
            soulId: this.soulId,
            chatId: this.chatId,
            prompt: "定位一下项目入口",
          },
          async (approvalId, senseName) => {
            await this.request("sense.approval", {
              soulId: this.soulId,
              approvalId,
              action: "accept",
            });
            log(`审批通过: ${senseName}`);
          },
        );

        const done2 = await this.waitForNotification("done", 60000);
        if (done2) {
          log("继续对话完成");
        }
      }

      log("=== 测试完成 ===");
    } catch (err) {
      const error = err as Error;
      log(`测试失败: ${error.message}`);
    } finally {
      this.ws.close();
    }
  }
}

async function main(): Promise<void> {
  const test = new InteractionTest();
  await test.run();
}

main().catch(console.error);