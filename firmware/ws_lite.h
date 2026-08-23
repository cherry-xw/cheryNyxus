/* ws_lite.h — 最小 WS 客户端（lite profile）
 *
 * 依据：protocol.md「lite profile 连接级投影」。
 * - URL: ws://host:port/?profile=lite&v=1&maxFrameBytes=2048[&token=...]
 * - 未知 v：握手期 close(4001, reason=JSON{supportedVersions:[...]})——机读判定后停机提示升级固件。
 * - 接收：binary 帧 0x02(JSON) 交回调；0x01(stream) 服务端已抑制，防御性忽略+计数。
 * - 缓冲：esp_websocket_client buffer_size = LITE_MAX_FRAME（2048）＝声明的 maxFrameBytes，
 *   服务端保证任何帧 ≤2KB（§3.7 含响应帧）。超限防御：组装缓冲溢出→丢帧+rx_overflow 计数。
 */
#ifndef WS_LITE_H
#define WS_LITE_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#define LITE_MAX_FRAME   2048
/* 注意（T27 实测发现）：当前服务端 Response 投影只截断字符串字段、不按 maxFrameBytes
 * 切分节点数组（liteProjection.ts:441 "void profile ... 归 T16"），默认 20 节点页 ≈9KB
 * 会超出任何 C3 档帧缓冲。因此本固件 timeline.get 显式 limit=3（实测 1643B/124 token，
 * 2048B/160 token 预算内），用 nextCursor 游标分页循环（P1-② 已实现）拉满窗口。 */
#define LITE_PROFILE_URL "?profile=lite&v=1&maxFrameBytes=2048"
#define LITE_PAGE_LIMIT   3

/* 一次性整帧回调（json_lite 解析在回调内完成） */
typedef void (*ws_on_json_frame)(const char *json, size_t len);

/* 生命周期事件 */
typedef enum {
    WS_EV_CONNECTED,        /* 可发起 hydration */
    WS_EV_DISCONNECTED,     /* 进入退避重连（外部状态机处理） */
    WS_EV_VERSION_REJECTED, /* close 4001：固件版本不支持，停机 */
} ws_event;

typedef void (*ws_on_event)(ws_event ev);

/* 统计（串口/日志展示，验证 §3.7 服务端保证是否成立） */
typedef struct {
    uint32_t rx_json;        /* 0x02 帧数 */
    uint32_t rx_stream;      /* 0x01 帧数（应为 0——lite 抑制） */
    uint32_t rx_overflow;    /* 超 LITE_MAX_FRAME 丢弃（应为 0——契约保证） */
    uint32_t rx_parse_fail;  /* JSON/token 超限（应为 0） */
} ws_stats;

extern ws_stats g_ws_stats;

bool ws_lite_start(const char *host, uint16_t port, const char *token,
                   ws_on_json_frame on_json, ws_on_event on_ev);
void ws_lite_stop(void);
bool ws_lite_send_text(const char *buf, size_t len);   /* RPC 请求上行 */
bool ws_lite_is_connected(void);

#endif
