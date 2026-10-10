#ifndef HOST_ESP_WEBSOCKET_CLIENT_H
#define HOST_ESP_WEBSOCKET_CLIENT_H

#include <stdbool.h>
#include <stdint.h>
#include "freertos/FreeRTOS.h"

#ifndef ESP_OK
#define ESP_OK 0
#endif

typedef void *esp_websocket_client_handle_t;
typedef const char *esp_event_base_t;

typedef enum {
    WEBSOCKET_EVENT_ANY = -1,
    WEBSOCKET_EVENT_CONNECTED,
    WEBSOCKET_EVENT_DISCONNECTED,
    WEBSOCKET_EVENT_DATA,
    WEBSOCKET_EVENT_CLOSED,
} esp_websocket_event_id_t;

typedef struct {
    int close_code;
    int data_len;
    const char *data_ptr;
    int op_code;
    int payload_len;
    int payload_offset;
} esp_websocket_event_data_t;

typedef struct {
    const char *uri;
    int buffer_size;
    int reconnect_timeout_ms;
    bool disable_auto_reconnect;
    int task_stack;
} esp_websocket_client_config_t;

esp_websocket_client_handle_t esp_websocket_client_init(const esp_websocket_client_config_t *config);
int esp_websocket_client_register_events(
    esp_websocket_client_handle_t client,
    esp_websocket_event_id_t event,
    void (*handler)(void *, esp_event_base_t, int32_t, void *),
    void *arg
);
int esp_websocket_client_start(esp_websocket_client_handle_t client);
int esp_websocket_client_destroy(esp_websocket_client_handle_t client);

/* Host-test lifecycle controls/counters. */
extern int g_esp_ws_stub_init_count;
extern int g_esp_ws_stub_destroy_count;
extern int g_esp_ws_stub_active_handles;
void esp_websocket_stub_reset(void);
void esp_websocket_stub_fail_next_start(void);
int esp_websocket_client_send_text(
    esp_websocket_client_handle_t client,
    const char *data,
    int length,
    TickType_t timeout
);

#endif
