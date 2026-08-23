/* ws_lite.c — esp_websocket_client 封装（ESP-IDF ≥5.1；Arduino 可用 arduinoWebSockets 等价替换） */
#include <string.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_websocket_client.h"
#include "esp_log.h"
#include "ws_lite.h"
#include "model.h"

static const char *TAG = "ws_lite";
static esp_websocket_client_handle_t s_cli;
static ws_on_json_frame s_on_json;
static ws_on_event s_on_ev;
static bool s_connected;
ws_stats g_ws_stats;

/* 分片帧组装（静态缓冲，≤LITE_MAX_FRAME，溢出=丢帧） */
static char s_asm[LITE_MAX_FRAME];
static size_t s_asm_len;
typedef enum { RX_FRAME_NONE, RX_FRAME_TEXT, RX_FRAME_BINARY_JSON, RX_FRAME_DROP } rx_frame_t;
static rx_frame_t s_rx_frame;

static void deliver_frame(const char *data, size_t len) {
    if (s_on_json) s_on_json(data, len);
}

static void handle_fragment(
    const char *data,
    size_t len,
    bool final_fragment,
    size_t payload_offset,
    int opcode
) {
    if (len == 0) return;
    const char *json = data;
    size_t json_len = len;

    if (payload_offset == 0) {
        s_asm_len = 0;
        s_rx_frame = RX_FRAME_DROP;
        if (opcode == 0x01) {
            /* Request/Response 使用 WebSocket text 帧，不带应用层类型字节。 */
            s_rx_frame = RX_FRAME_TEXT;
        } else if (opcode == 0x02) {
            uint8_t frame_type = (uint8_t)data[0];
            if (frame_type == 0x01) {
                g_ws_stats.rx_stream++;
                return; /* turnDelta=0：整帧拒绝 */
            }
            if (frame_type != 0x02) return;
            s_rx_frame = RX_FRAME_BINARY_JSON;
            json = data + 1;
            json_len = len - 1;
        } else {
            return;
        }
    } else if (s_rx_frame != RX_FRAME_TEXT && s_rx_frame != RX_FRAME_BINARY_JSON) {
        return;
    }

    if (payload_offset == 0 && final_fragment) {
        if (json_len > sizeof s_asm) {
            g_ws_stats.rx_overflow++;
            s_rx_frame = RX_FRAME_DROP;
            return;
        }
        deliver_frame(json, json_len);
        s_rx_frame = RX_FRAME_NONE;
        return;
    }

    if (s_asm_len + json_len > sizeof s_asm) {
        g_ws_stats.rx_overflow++;
        s_asm_len = 0;
        s_rx_frame = RX_FRAME_DROP;
        return;
    }
    memcpy(s_asm + s_asm_len, json, json_len);
    s_asm_len += json_len;
    if (final_fragment) {
        deliver_frame(s_asm, s_asm_len);
        s_asm_len = 0;
        s_rx_frame = RX_FRAME_NONE;
    }
}

static void event_handler(void *arg, esp_event_base_t base, int32_t id, void *event_data) {
    esp_websocket_event_data_t *e = (esp_websocket_event_data_t *)event_data;
    switch ((esp_websocket_event_id_t)id) {
    case WEBSOCKET_EVENT_CONNECTED:
        s_connected = true;
        if (s_on_ev) s_on_ev(WS_EV_CONNECTED);
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
        s_connected = false;
        s_asm_len = 0;
        s_rx_frame = RX_FRAME_NONE;
        if (s_on_ev) s_on_ev(WS_EV_DISCONNECTED);
        break;
    case WEBSOCKET_EVENT_CLOSED: {
        /* D14/Db：未知 profile v → close(4001, reason=JSON{supportedVersions})。
         * esp-idf 在 CLOSED 事件携带 close code/reason。机读判定后停机提示固件升级。 */
        s_connected = false;
        if (e && e->close_code == 4001) {
            ESP_LOGE(TAG, "lite profile version rejected (close 4001): %.*s",
                     e->data_len, (char *)e->data_ptr);
            if (s_on_ev) s_on_ev(WS_EV_VERSION_REJECTED);
        } else if (s_on_ev) {
            s_on_ev(WS_EV_DISCONNECTED);
        }
        break;
    }
    case WEBSOCKET_EVENT_DATA:
        if (!e || !e->data_ptr || e->data_len <= 0) break;
        if (e->payload_offset == 0 && e->op_code != 0x01 && e->op_code != 0x02) break;
        handle_fragment(
            e->data_ptr,
            (size_t)e->data_len,
            e->payload_offset + e->data_len >= e->payload_len,
            (size_t)e->payload_offset,
            e->op_code
        );
        break;
    default:
        break;
    }
    (void)base; (void)arg;
}

bool ws_lite_start(const char *host, uint16_t port, const char *token,
                   ws_on_json_frame on_json, ws_on_event on_ev) {
    /* Reconnects are initiated by the app loop, never from the ESP event callback.
     * Dispose the prior disconnected client before replacing its handle. */
    if (s_cli) {
        esp_websocket_client_destroy(s_cli);
        s_cli = NULL;
    }
    s_connected = false;
    s_on_json = on_json;
    s_on_ev = on_ev;
    s_asm_len = 0;
    s_rx_frame = RX_FRAME_NONE;
    char uri[192];
    if (token && token[0])
        snprintf(uri, sizeof uri,
                 "ws://%s:%u/?profile=lite&v=1&maxFrameBytes=%u&turnDelta=%u&token=%s",
                 host, (unsigned)port, (unsigned)MCU_MAX_FRAME_BYTES,
                 (unsigned)MCU_TURN_DELTA, token);
    else
        snprintf(uri, sizeof uri,
                 "ws://%s:%u/?profile=lite&v=1&maxFrameBytes=%u&turnDelta=%u",
                 host, (unsigned)port, (unsigned)MCU_MAX_FRAME_BYTES,
                 (unsigned)MCU_TURN_DELTA);

    const esp_websocket_client_config_t cfg = {
        .uri = uri,
        .buffer_size = LITE_MAX_FRAME + 1, /* binary JSON 另有 1B 应用层 type 前缀 */
        .reconnect_timeout_ms = 0,         /* 重连策略由 app 状态机统一管（指数退避+抖动） */
        .disable_auto_reconnect = true,
        .task_stack = 4096,
    };
    s_cli = esp_websocket_client_init(&cfg);
    if (!s_cli) return false;
    if (esp_websocket_client_register_events(
            s_cli, WEBSOCKET_EVENT_ANY, event_handler, NULL) != ESP_OK) {
        esp_websocket_client_destroy(s_cli);
        s_cli = NULL;
        return false;
    }
    memset(&g_ws_stats, 0, sizeof g_ws_stats);
    if (esp_websocket_client_start(s_cli) != ESP_OK) {
        esp_websocket_client_destroy(s_cli);
        s_cli = NULL;
        return false;
    }
    return true;
}

void ws_lite_stop(void) {
    if (s_cli) { esp_websocket_client_destroy(s_cli); s_cli = NULL; }
    s_connected = false;
    s_asm_len = 0;
    s_rx_frame = RX_FRAME_NONE;
}

bool ws_lite_send_text(const char *buf, size_t len) {
    if (!s_cli || !s_connected) return false;
    return esp_websocket_client_send_text(s_cli, buf, (int)len, pdMS_TO_TICKS(3000)) >= 0;
}

bool ws_lite_is_connected(void) { return s_connected; }

#ifdef MCU_HOST_TEST
void ws_lite_test_feed_fragment(
    const char *data,
    size_t len,
    size_t payload_offset,
    size_t payload_length,
    int opcode
) {
    handle_fragment(data, len, payload_offset + len >= payload_length, payload_offset, opcode);
}
#endif
