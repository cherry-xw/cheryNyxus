#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "driver/spi_master.h"
#include "driver/i2c_master.h"
#include "driver/sdspi_host.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_panel_ops.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "esp_vfs_fat.h"
#include "sdmmc_cmd.h"
#include "key_event.h"
#include "adv_ui.h"
#include "driver/ledc.h"
#include "wifi_security.h"

static const char *TAG = "adv";
static esp_lcd_panel_handle_t panel;
static esp_lcd_panel_io_handle_t panel_io;
static i2c_master_dev_handle_t keyboard;
static bool keyboard_ok, sd_ok;
static unsigned devices;
static int battery = -1;
static adv_key_t last_key;
static bool has_key;

esp_err_t adv_set_brightness(uint8_t value) {
    if (value < 10 || value > 100) return ESP_ERR_INVALID_ARG;
    esp_err_t err = ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, value * 1023 / 100);
    return err == ESP_OK ? ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0) : err;
}

static void display_init(void) {
    ledc_timer_config_t timer = {.speed_mode = LEDC_LOW_SPEED_MODE, .duty_resolution = LEDC_TIMER_10_BIT,
        .timer_num = LEDC_TIMER_0, .freq_hz = 5000, .clk_cfg = LEDC_AUTO_CLK};
    ESP_ERROR_CHECK(ledc_timer_config(&timer));
    ledc_channel_config_t light = {.gpio_num = 38, .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0, .timer_sel = LEDC_TIMER_0, .duty = 0};
    ESP_ERROR_CHECK(ledc_channel_config(&light));
    spi_bus_config_t bus = {.mosi_io_num = 35, .miso_io_num = -1, .sclk_io_num = 36,
        .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = 240 * 20 * 2};
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));

    esp_lcd_panel_io_spi_config_t io_cfg = {.dc_gpio_num = 34, .cs_gpio_num = 37,
        .pclk_hz = 20000000, .lcd_cmd_bits = 8, .lcd_param_bits = 8, .spi_mode = 0,
        .trans_queue_depth = 1};
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &io_cfg, &panel_io));
    esp_lcd_panel_dev_config_t cfg = {.reset_gpio_num = 33,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB, .bits_per_pixel = 16};
    ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(panel_io, &cfg, &panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(panel));

    ESP_ERROR_CHECK(esp_lcd_panel_set_gap(panel, 40, 53));
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(panel, true));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));
    /* esp_lvgl_port owns rotation and DMA completion. */
}


static esp_err_t key_write(uint8_t reg, uint8_t value) {
    uint8_t data[] = {reg, value};
    return i2c_master_transmit(keyboard, data, sizeof(data), 50);
}
static esp_err_t key_read(uint8_t reg, uint8_t *value) {
    return i2c_master_transmit_receive(keyboard, &reg, 1, value, 1, 50);
}
static esp_err_t keyboard_init(i2c_master_bus_handle_t bus) {
    i2c_device_config_t cfg = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = 0x34, .scl_speed_hz = 100000};
    esp_err_t err = i2c_master_bus_add_device(bus, &cfg, &keyboard);
    if (err != ESP_OK) return err;
    /* KP_GPIO1/2/3 select seven rows and eight columns. Default debounce enabled. */
    const uint8_t config[][2] = {{0x1d,0x7f},{0x1e,0xff},{0x1f,0x00},{0x29,0},{0x2a,0},{0x2b,0},{0x01,0x01}};
    for (unsigned i = 0; i < sizeof(config)/sizeof(config[0]); ++i) {
        err = key_write(config[i][0], config[i][1]);
        if (err != ESP_OK) return err;
    }
    for (unsigned i = 0; i < 10; ++i) {
        uint8_t raw;
        err = key_read(0x04, &raw);
        if (err != ESP_OK) return err;
        if (!raw) break;
    }
    return key_write(0x02, 0x1f);
}
static void poll_keyboard(void) {
    uint8_t count;
    esp_err_t err = key_read(0x03, &count);
    if (err != ESP_OK) goto failed;
    for (unsigned i = 0; i < (count & 0x0f) && i < 10; ++i) {
        uint8_t raw;
        err = key_read(0x04, &raw);
        if (err != ESP_OK) goto failed;
        if (adv_decode_key(raw, &last_key)) {
            has_key = true;
            ESP_LOGI(TAG, "key row=%u col=%u %s", last_key.row, last_key.col, last_key.pressed ? "down" : "up");
            adv_ui_key(last_key);
        }
    }
    err = key_write(0x02, 0x1f);
    if (err == ESP_OK) return;
failed:
    keyboard_ok = false;
    ESP_LOGE(TAG, "keyboard disabled: %s", esp_err_to_name(err));
}
static void sd_init(void) {
    spi_bus_config_t cfg = {.mosi_io_num = 14, .miso_io_num = 39, .sclk_io_num = 40,
        .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = 4096};
    esp_err_t err = spi_bus_initialize(SPI3_HOST, &cfg, SPI_DMA_CH_AUTO);
    if (err != ESP_OK) { ESP_LOGW(TAG, "SD SPI: %s", esp_err_to_name(err)); return; }
    sdmmc_host_t host = SDSPI_HOST_DEFAULT(); host.slot = SPI3_HOST; host.max_freq_khz = 10000;
    sdspi_device_config_t slot = SDSPI_DEVICE_CONFIG_DEFAULT(); slot.host_id = SPI3_HOST; slot.gpio_cs = 12;
    esp_vfs_fat_sdmmc_mount_config_t mount = {.format_if_mount_failed = false, .max_files = 2, .allocation_unit_size = 16384};
    sdmmc_card_t *card = NULL;
    err = esp_vfs_fat_sdspi_mount("/sdcard", &host, &slot, &mount, &card);
    sd_ok = err == ESP_OK;
    if (sd_ok) sdmmc_card_print_info(stdout, card);
    else ESP_LOGW(TAG, "SD unavailable: %s", esp_err_to_name(err));
}
void app_main(void) {
    esp_err_t nvs_err = adv_nvs_init();
    if (nvs_err != ESP_OK) ESP_LOGE(TAG, "NVS unavailable; not erased: %s", esp_err_to_name(nvs_err));
    display_init();
    i2c_master_bus_handle_t bus = NULL;
    i2c_master_bus_config_t cfg = {.i2c_port = I2C_NUM_0, .sda_io_num = 8, .scl_io_num = 9,
        .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7, .flags.enable_internal_pullup = true};
    esp_err_t err = i2c_new_master_bus(&cfg, &bus);
    if (err == ESP_OK) {
        for (uint8_t addr = 0x08; addr < 0x78; ++addr) {
            if (i2c_master_probe(bus, addr, 20) == ESP_OK) { ++devices; ESP_LOGI(TAG, "I2C address 0x%02x", addr); }
        }
        err = keyboard_init(bus); keyboard_ok = err == ESP_OK;
    }
    if (err != ESP_OK) ESP_LOGW(TAG, "I2C/keyboard: %s", esp_err_to_name(err));
    adc_oneshot_unit_handle_t adc = NULL;
    adc_oneshot_unit_init_cfg_t acfg = {.unit_id = ADC_UNIT_1};
    err = adc_oneshot_new_unit(&acfg, &adc);
    if (err == ESP_OK) {
        adc_oneshot_chan_cfg_t channel = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
        err = adc_oneshot_config_channel(adc, ADC_CHANNEL_9, &channel); /* GPIO10 */
        if (err != ESP_OK) { adc_oneshot_del_unit(adc); adc = NULL; }
    }
    sd_init();
    adv_storage_mounted(sd_ok);
    adv_ui_init(panel_io, panel);
    int64_t refresh = 0;
    while (true) {
        if (keyboard_ok) poll_keyboard();
        int64_t now = esp_timer_get_time();
        if (now >= refresh) {
            if (!adc || adc_oneshot_read(adc, ADC_CHANNEL_9, &battery) != ESP_OK) battery = -1;

            ESP_LOGI(TAG, "devices=%u keyboard=%s sd=%s battery_raw=%d", devices,
                keyboard_ok ? "ok" : "error", sd_ok ? "mounted" : "unavailable", battery);
            refresh = now + 1000000;
        }
        adv_status_t status = {.keyboard_ok = keyboard_ok, .sd_ok = sd_ok, .has_key = has_key,
            .devices = devices, .battery = battery, .key = last_key};
        adv_ui_update(&status);
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
