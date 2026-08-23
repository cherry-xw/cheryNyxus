/**
 * 工作台 lite 极简 UI 的独立 WS 连接（T33 L0）。
 * 设计契约：docs/web/mcu-lite-workbench-ui.md §3.1（v0.2 定稿）。
 *
 * 复用 WsClient 全部内聚能力（心跳/重连/token 注入/rpc 超时），仅注入 lite profile
 * 查询参数——独立实例，严禁复用主 UI 单例 wsClient（信封最小化破坏主 UI replay 协议）。
 */
import { WsClient } from './ws'

/** lite 连接的 UI 可观测状态（状态条渲染源）。 */
export type LiteConnectionPhase =
  | 'idle' // 未启动（lite 视图未激活）
  | 'connecting' // 首次连接中
  | 'connected' // 已连接
  | 'reconnecting' // 断线重连中（第 N 次退避）
  | 'unsupported' // 握手期 close(4001)：版本不兼容，禁用切换提示升级

export interface LiteConnectionState {
  phase: LiteConnectionPhase
  /** reconnecting 时的重试次数（退避序列序号，从 1 起）。 */
  reconnectAttempts: number
  /** 应用层帧 payload 累计字节（C 定案口径：不含握手/心跳，pong 不计）。 */
  receivedBytes: number
}

export interface LiteClientOptions {
  /** lite 字段集版本；缺省 1。 */
  v?: number
  /** 单帧字节上限；缺省 2048（设计 §3.1）。 */
  maxFrameBytes?: number
  /** turnDelta 连接级参数（默认关；开启=实例需重建，不能热切换，§4.2 A 定案）。 */
  turnDelta?: boolean
  onState?: (state: LiteConnectionState) => void
  /** lite 事件（notification，含信封最小化形态）。 */
  onEvent?: (event: unknown) => void
}

export class LiteClient {
  readonly client = new WsClient()
  private readonly options: Required<Pick<LiteClientOptions, 'v' | 'maxFrameBytes' | 'turnDelta'>> & LiteClientOptions
  private state: LiteConnectionState = { phase: 'idle', reconnectAttempts: 0, receivedBytes: 0 }
  /** 握手版本拒绝（close code 4001）判定。 */
  private sawUnsupported = false

  constructor(options: LiteClientOptions = {}) {
    this.options = { v: 1, maxFrameBytes: 2048, turnDelta: false, ...options }
    this.client.onStatus((status) => this.onStatus(status))
    this.client.onEvent((event) => {
      this.countBytes(event)
      this.options.onEvent?.(event)
    })
  }

  getState(): LiteConnectionState {
    return { ...this.state }
  }

  private setState(patch: Partial<LiteConnectionState>): void {
    this.state = { ...this.state, ...patch }
    this.options.onState?.(this.getState())
  }

  /** 激活 lite 视图时建连（幂等：已连接/连接中直接返回）。 */
  async connect(): Promise<void> {
    if (this.state.phase === 'connected' || this.state.phase === 'connecting') return
    this.sawUnsupported = false
    this.setState({ phase: 'connecting', reconnectAttempts: 0 })
    await this.client.connect({
      query: {
        profile: 'lite',
        v: String(this.options.v),
        maxFrameBytes: String(this.options.maxFrameBytes),
        ...(this.options.turnDelta ? { turnDelta: '1' } : {}),
      },
    })
  }

  /** 切换回完整视图：lite 连接保留（§5.1 单视图操作约束——连接不断，仅视图层停交互）。 */
  deactivate(): void {
    // L0：连接保留策略（设计定稿）。完全断开留 L4 收尾按验收定。
  }

  disconnect(): void {
    this.client.disconnect()
    this.setState({ phase: 'idle', reconnectAttempts: 0 })
  }

  private onStatus(status: 'connected' | 'connecting' | 'disconnected'): void {
    if (this.sawUnsupported) return // 版本拒绝后不再翻转状态（unsupported 为终态，UI 提示升级）
    if (status === 'connected') {
      this.setState({ phase: 'connected', reconnectAttempts: 0 })
      return
    }
    if (status === 'disconnected') {
      if (this.state.phase === 'idle') return
      // 首连失败（未成功过）→ unsupported 候选：服务端 close(4001) 的握手拒绝。
      // 浏览器 WS API 不暴露 close code 给 onStatus 回调，此处以「首次连接立即断开」
      // 近似判定；精确 code 判定由 WsClient 扩展 close-event 透出（L4 收尾增强）。
      if (this.state.phase === 'connecting') {
        this.sawUnsupported = true
        this.setState({ phase: 'unsupported' })
        return
      }
      this.setState({ phase: 'reconnecting', reconnectAttempts: this.state.reconnectAttempts + 1 })
      return
    }
    this.setState({ phase: 'connecting' })
  }

  /** C 定案：只计应用层帧 payload 字节。pong/心跳由 WsClient 过滤不入 onEvent，天然排除。 */
  private countBytes(event: unknown): void {
    try {
      const bytes =
        typeof event === 'object' && event !== null
          ? JSON.stringify(event).length
          : String(event ?? '').length
      this.setState({ receivedBytes: this.state.receivedBytes + bytes })
    } catch {
      // 不可序列化事件不计
    }
  }
}
