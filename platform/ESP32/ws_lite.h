/* ws_lite.h — 最小 WS 客户端（lite profile）
 *
 * 依据：protocol.md「lite profile 连接级投影」。
 * - URL: ws://host:port/?profile=lite&v=1&maxFrameBytes=2048[&token=...]
 * - 未知 v：握手期 close(4001, reason=JSON{supportedVersions:[...]})——机读判定后停机提示升级固件。
 * - 接收：RPC Response 的 WebSocket text JSON 与 binary 0x02 Notification JSON 均交回调；
 *   binary 0x01(stream) 因 turnDelta=0 防御性拒绝并计数。
 * - 缓冲：esp_websocket_client buffer_size = LITE_MAX_FRAME（2048）＝声明的 maxFrameBytes，
 *   服务端保证任何帧 ≤2KB（§3.7 含响应帧）。超限防御：组装缓冲溢出→丢帧+rx_overflow 计数。
 */
#ifndef WS_LITE_H
#define WS_LITE_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include "device_config.h"

#define LITE_MAX_FRAME          MCU_MAX_FRAME_BYTES
#define LITE_PAGE_LIMIT         MCU_TIMELINE_PAGE_SIZE
#define LITE_EXECUTION_LIMIT    MCU_EXECUTION_STEP_CAPACITY

/* 一次性 JSON 回调（text response / binary notification 共用） */
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
    uint32_t rx_stream;      /* 0x01 帧数（turnDelta=0 时收到即拒绝/忽略） */
    uint32_t rx_overflow;    /* 超 LITE_MAX_FRAME 丢弃（应为 0——契约保证） */
    uint32_t rx_parse_fail;  /* JSON/token 超限（应为 0） */
} ws_stats;

extern ws_stats g_ws_stats;

bool ws_lite_start(const char *host, uint16_t port, const char *token,
                   ws_on_json_frame on_json, ws_on_event on_ev);
void ws_lite_stop(void);
bool ws_lite_send_text(const char *buf, size_t len);   /* RPC 请求上行 */
bool ws_lite_is_connected(void);

#ifdef MCU_HOST_TEST
/* host 回归入口：模拟 ESP-IDF 的 text/binary 分片投递。 */
void ws_lite_test_feed_fragment(
    const char *data,
    size_t len,
    size_t payload_offset,
    size_t payload_length,
    int opcode
);
#endif

#endif
