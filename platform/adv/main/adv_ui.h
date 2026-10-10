#pragma once
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "key_event.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct {
    bool keyboard_ok, sd_ok, has_key;
    unsigned devices;
    int battery;
    adv_key_t key;
} adv_status_t;
void adv_ui_init(esp_lcd_panel_io_handle_t io, esp_lcd_panel_handle_t panel);
void adv_ui_key(adv_key_t key);
void adv_ui_update(const adv_status_t *status);
void adv_storage_mounted(bool mounted);
esp_err_t adv_set_brightness(uint8_t value);
#ifdef __cplusplus
}
#endif
