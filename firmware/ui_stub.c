/* ui_stub.c — 串口桩实现（ESP-IDF）。真实硬件：SSD1306 128×64 I2C + EC11 编码器。 */
#include <stdio.h>
#include <stdarg.h>
#include "esp_timer.h"
#include "esp_log.h"
#include "ui_stub.h"

static const char *TAG = "ui";
static uint8_t s_inbox_dirty;

void ui_log(const char *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    vprintf(fmt, ap); printf("\n");
    va_end(ap);
}
uint64_t ui_now_ms(void) { return (uint64_t)esp_timer_get_time() / 1000ULL; }

void ui_render_list(const lean_node *nodes, int n) {
    ESP_LOGI(TAG, "== timeline (%d nodes, latest page) ==", n);
    int from = n > 6 ? n - 6 : 0;   /* OLED 视口=最近 6 条 */
    for (int i = from; i < n; i++)
        ESP_LOGI(TAG, "  [%s/%s] %s", nodes[i].actor_kind, nodes[i].direction, nodes[i].summary);
}
void ui_render_status(void) {
    run_row *r = model_run();
    if (r->present) ESP_LOGI(TAG, "run %s: %s", r->run_id, r->status);
    else ESP_LOGI(TAG, "run: idle");
}
void ui_render_tool(const char *name) { ESP_LOGI(TAG, "tool: %s", name); }
void ui_render_approval(const approval_slot *a) {
    ESP_LOGW(TAG, "APPROVAL %s (%s)", a->sense_name, a->interaction_id);
    ESP_LOGW(TAG, "  args: %.360s", a->arguments);
}
void ui_flag_inbox_refresh(void) { s_inbox_dirty = 1; }
uint8_t ui_inbox_dirty(void) { return s_inbox_dirty; }
void ui_inbox_clear_dirty(void) { s_inbox_dirty = 0; }

/* 输入桩：无真实按键，GPIO/编码器接入点预留 */
static void (*s_on_decide)(const char *, int, bool);
static void (*s_on_send)(const char *);
void ui_input_init(void (*on_decide)(const char *, int, bool), void (*on_send)(const char *)) {
    s_on_decide = on_decide; s_on_send = on_send;
    ESP_LOGI(TAG, "input stub ready (wire EC11 + buttons here)");
}
