/* ws_lite.c — esp_websocket_client 封装（ESP-IDF ≥5.1；Arduino 可用 arduinoWebSockets 等价替换） */
#include <string.h>
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

static void deliver_frame(const char *data, size_t len) {
    if (s_on_json) s_on_json(data, len);
}

static void handle_data(const char *data, size_t len, bool final_frag, size_t payload_off) {
    (void)payload_off; /* lite 帧恒小（≤2KB），esp_websocket_client 单事件完整投递为主路径 */
    if (len == 0) return;
    uint8_t ftype = (uint8_t)data[0];
    if (ftype == 0x01) {           /* stream chunk：契约已抑制，防御忽略 */
        g_ws_stats.rx_stream++;
        return;
    }
    if (ftype != 0x02) return;     /* 未知帧类型：忽略 */
    const char *json = data + 1;
    size_t jlen = len - 1;
    if (payload_off == 0 && final_frag) {   /* 快路径：一次性整帧，零拷贝就地解析 */
        deliver_frame(json, jlen);
        return;
    }
    /* 慢路径：分片组装（防御；WS 客户端 buffer ≥ 帧大小时不会走到） */
    if (s_asm_len + jlen > sizeof s_asm) {
        g_ws_stats.rx_overflow++;
        s_asm_len = 0;             /* 丢弃整个帧，等待下一帧边界（契约 §3.7 保证不该发生） */
        return;
    }
    memcpy(s_asm + s_asm_len, json, jlen);
    s_asm_len += jlen;
    if (final_frag) {
        deliver_frame(s_asm, s_asm_len);
        s_asm_len = 0;
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
        if (!e->op_code) break;                    /* 继续帧由首片处理 */
        if (e->op_code == 0x02 /* binary */)
            handle_data(e->data_ptr, (size_t)e->data_len, e->payload_len == e->data_len + (e->payload_offset ? 0 : 0), (size_t)e->payload_offset);
        break;
    default:
        break;
    }
    (void)base; (void)arg;
}

bool ws_lite_start(const char *host, uint16_t port, const char *token,
                   ws_on_json_frame on_json, ws_on_event on_ev) {
    s_on_json = on_json;
    s_on_ev = on_ev;
    char uri[128];
    if (token && token[0])
        snprintf(uri, sizeof uri, "ws://%s:%u/?profile=lite&v=1&maxFrameBytes=2048&token=%s", host, (unsigned)port, token);
    else
        snprintf(uri, sizeof uri, "ws://%s:%u/?profile=lite&v=1&maxFrameBytes=2048", host, (unsigned)port);

    const esp_websocket_client_config_t cfg = {
        .uri = uri,
        .buffer_size = LITE_MAX_FRAME,     /* = maxFrameBytes：服务端保证帧 ≤ 此值（§3.7） */
        .reconnect_timeout_ms = 0,         /* 重连策略由 app 状态机统一管（指数退避+抖动） */
        .disable_auto_reconnect = true,
        .task_stack = 4096,
    };
    s_cli = esp_websocket_client_init(&cfg);
    if (!s_cli) return false;
    esp_websocket_client_register_events(s_cli, WEBSOCKET_EVENT_ANY, event_handler, NULL);
    memset(&g_ws_stats, 0, sizeof g_ws_stats);
    return esp_websocket_client_start(s_cli) == ESP_OK;
}

void ws_lite_stop(void) {
    if (s_cli) { esp_websocket_client_destroy(s_cli); s_cli = NULL; }
    s_connected = false;
}

bool ws_lite_send_text(const char *buf, size_t len) {
    if (!s_cli || !s_connected) return false;
    return esp_websocket_client_send_text(s_cli, buf, (int)len, pdMS_TO_TICKS(3000)) >= 0;
}

bool ws_lite_is_connected(void) { return s_connected; }
