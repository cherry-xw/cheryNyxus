#include <stddef.h>
#include "esp_websocket_client.h"

int g_esp_ws_stub_init_count;
int g_esp_ws_stub_destroy_count;
int g_esp_ws_stub_active_handles;
static int s_fail_next_start;

void esp_websocket_stub_reset(void) {
    g_esp_ws_stub_init_count = 0;
    g_esp_ws_stub_destroy_count = 0;
    g_esp_ws_stub_active_handles = 0;
    s_fail_next_start = 0;
}

void esp_websocket_stub_fail_next_start(void) { s_fail_next_start = 1; }

esp_websocket_client_handle_t esp_websocket_client_init(const esp_websocket_client_config_t *config) {
    if (config) {
        g_esp_ws_stub_init_count++;
        g_esp_ws_stub_active_handles++;
    }
    return config ? (esp_websocket_client_handle_t)config : NULL;
}

int esp_websocket_client_register_events(
    esp_websocket_client_handle_t client,
    esp_websocket_event_id_t event,
    void (*handler)(void *, esp_event_base_t, int32_t, void *),
    void *arg
) {
    (void)client; (void)event; (void)handler; (void)arg;
    return ESP_OK;
}

int esp_websocket_client_start(esp_websocket_client_handle_t client) {
    if (s_fail_next_start) {
        s_fail_next_start = 0;
        return -1;
    }
    return client ? ESP_OK : -1;
}

int esp_websocket_client_destroy(esp_websocket_client_handle_t client) {
    if (client) {
        g_esp_ws_stub_destroy_count++;
        g_esp_ws_stub_active_handles--;
    }
    return ESP_OK;
}

int esp_websocket_client_send_text(
    esp_websocket_client_handle_t client,
    const char *data,
    int length,
    TickType_t timeout
) {
    (void)client; (void)data; (void)timeout;
    return length;
}
