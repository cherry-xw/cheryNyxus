#include "adv_wifi.hpp"
#include "wifi_credentials.hpp"
#include "wifi_security.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include <atomic>
#include <cstring>
namespace advwifi {
namespace {
struct Command { bool scanning; bool pin_ap; Ap ap; Password password; };
QueueHandle_t commands = nullptr, states = nullptr;
SemaphoreHandle_t command_lock = nullptr;
StaticQueue_t command_control;
uint8_t command_storage[sizeof(Command)]{};
std::atomic<bool> quit{false}, done{true};
std::atomic<unsigned> events{0};
std::atomic<uint32_t> address{0};
constexpr unsigned scan_done = 1, associated = 2, got_ip = 4, disconnected = 8, lost_ip = 16;
void event(void*, esp_event_base_t base, int32_t id, void* data) {
    if (base == WIFI_EVENT) {
        if (id == WIFI_EVENT_SCAN_DONE) events.fetch_or(scan_done);
        if (id == WIFI_EVENT_STA_CONNECTED) events.fetch_or(associated);
        if (id == WIFI_EVENT_STA_DISCONNECTED) events.fetch_or(disconnected);
    } else if (id == IP_EVENT_STA_GOT_IP) {
        address.store(static_cast<ip_event_got_ip_t*>(data)->ip_info.ip.addr);
        events.fetch_or(got_ip);
    } else if (id == IP_EVENT_STA_LOST_IP) events.fetch_or(lost_ip);
}
void worker(void*) {
    Snapshot s; s.phase = Phase::Idle;
    esp_netif_t* netif = nullptr;
    esp_event_handler_instance_t wh = nullptr, ih = nullptr;
    bool initialized = false, started = false;
    esp_err_t err = esp_netif_init();
    if (err == ESP_OK) { err = esp_event_loop_create_default(); if (err == ESP_ERR_INVALID_STATE) err = ESP_OK; }
    if (err == ESP_OK) { netif = esp_netif_create_default_wifi_sta(); if (!netif) err = ESP_ERR_NO_MEM; }
    if (err == ESP_OK) {
        wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT(); cfg.nvs_enable = 0;
        err = esp_wifi_init(&cfg); initialized = err == ESP_OK;
    }
    if (err == ESP_OK) err = esp_wifi_set_storage(WIFI_STORAGE_RAM);
    if (err == ESP_OK) err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err == ESP_OK) err = esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, event, nullptr, &wh);
    if (err == ESP_OK) err = esp_event_handler_instance_register(IP_EVENT, ESP_EVENT_ANY_ID, event, nullptr, &ih);
    if (err == ESP_OK) { err = esp_wifi_start(); started = err == ESP_OK; }
    if (err != ESP_OK) { s.phase = Phase::Error; s.error = err; }
    xQueueOverwrite(states, &s);
    int64_t deadline = 0;
    while (!quit.load()) {
        Command c{};
        xSemaphoreTake(command_lock, portMAX_DELAY);
        bool received = xQueueReceive(commands, &c, 0) == pdTRUE;
        if (received) wipe(command_storage, sizeof(command_storage));
        xSemaphoreGive(command_lock);
        if (received) {
            if (!started) err = ESP_ERR_INVALID_STATE;
            else if (s.phase == Phase::Scanning || s.phase == Phase::Connecting || s.phase == Phase::Associated || s.phase == Phase::IpReady) {
                wipe(&c, sizeof(c));
                vTaskDelay(pdMS_TO_TICKS(20));
                continue; // Reject busy command without destroying the active operation/deadline.
            }
            else if (c.scanning) {
                // No simultaneous scan/connect and no unbounded retry.
                events.store(0); s.ip = 0; s.count = 0;
                wifi_scan_config_t cfg{}; cfg.scan_time.active.max = 120;
                err = esp_wifi_scan_start(&cfg, false);
                if (err == ESP_OK) { s.phase = Phase::Scanning; deadline = esp_timer_get_time() + 10000000; }
            } else {
                events.store(0); s.ip = 0;
                wifi_config_t cfg{};
                std::memcpy(cfg.sta.ssid, c.ap.ssid, strnlen(c.ap.ssid, 32));
                std::memcpy(cfg.sta.password, c.password.bytes, c.password.size);
                cfg.sta.bssid_set = c.pin_ap;
                if (c.pin_ap) { std::memcpy(cfg.sta.bssid, c.ap.bssid, 6); cfg.sta.channel = c.ap.channel; }
                cfg.sta.threshold.authmode = static_cast<wifi_auth_mode_t>(c.ap.auth);
                cfg.sta.pmf_cfg.capable = true;
                err = esp_wifi_set_config(WIFI_IF_STA, &cfg);
                wipe(&cfg, sizeof(cfg));
                if (err == ESP_OK) err = esp_wifi_connect();
                if (err == ESP_OK) { s.phase = Phase::Connecting; deadline = esp_timer_get_time() + 20000000; }
            }
            wipe(&c, sizeof(c));
            if (err != ESP_OK) {
                s.phase = Phase::Error; s.error = err;
                if (started) { wifi_config_t empty{}; esp_wifi_set_config(WIFI_IF_STA, &empty); }
            }
            else s.error = ESP_OK;
        }
        unsigned e = events.exchange(0);
        if ((e & scan_done) && s.phase == Phase::Scanning) {
            wifi_ap_record_t records[12]{}; uint16_t n = 12;
            err = esp_wifi_scan_get_ap_records(&n, records);
            esp_wifi_clear_ap_list(); s.count = 0;
            if (err == ESP_OK) for (unsigned i = 0; i < n; ++i) {
                if (!records[i].ssid[0]) continue;
                Ap& a = s.aps[s.count++];
                std::memcpy(a.ssid, records[i].ssid, 32); a.ssid[32] = 0;
                std::memcpy(a.bssid, records[i].bssid, 6);
                a.channel = records[i].primary; a.rssi = records[i].rssi; a.auth = records[i].authmode;
            }
            s.phase = err == ESP_OK ? Phase::Idle : Phase::Error; s.error = err; deadline = 0;
        }
        if ((e & associated) && s.phase == Phase::Connecting) s.phase = Phase::Associated;
        if ((e & got_ip) && (s.phase == Phase::Connecting || s.phase == Phase::Associated)) {
            s.phase = Phase::IpReady; s.ip = address.load(); deadline = 0;
        }
        if ((e & (disconnected | lost_ip)) && (s.phase == Phase::Connecting || s.phase == Phase::Associated || s.phase == Phase::IpReady)) {
            s.phase = Phase::Error; s.error = ESP_FAIL; s.ip = 0; deadline = 0;
            esp_wifi_disconnect();
            wifi_config_t empty{}; esp_wifi_set_config(WIFI_IF_STA, &empty);
        }
        if (deadline && esp_timer_get_time() >= deadline) {
            esp_wifi_scan_stop(); esp_wifi_clear_ap_list(); esp_wifi_disconnect();
            wifi_config_t empty{}; esp_wifi_set_config(WIFI_IF_STA, &empty);
            s.phase = Phase::Error; s.error = ESP_ERR_TIMEOUT; s.ip = 0; deadline = 0;
        }
        xQueueOverwrite(states, &s);
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    // This task owns all SDK calls, including cleanup. UI never waits for them.
    if (initialized) {
        if (started) { esp_wifi_scan_stop(); esp_wifi_clear_ap_list(); esp_wifi_disconnect(); }
        wifi_config_t empty{}; esp_wifi_set_config(WIFI_IF_STA, &empty);
        if (started) esp_wifi_stop();
    }
    if (wh) esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, wh);
    if (ih) esp_event_handler_instance_unregister(IP_EVENT, ESP_EVENT_ANY_ID, ih);
    if (initialized) esp_wifi_deinit();
    if (netif) esp_netif_destroy_default_wifi(netif);
    xSemaphoreTake(command_lock, portMAX_DELAY);
    Command pending{}; while (xQueueReceive(commands, &pending, 0) == pdTRUE) wipe(&pending, sizeof(pending));
    wipe(&pending, sizeof(pending));
    wipe(command_storage, sizeof(command_storage));
    xSemaphoreGive(command_lock);
    done.store(true); vTaskDelete(nullptr);
}
}
esp_err_t start() {
    if (commands) return done.load() ? ESP_ERR_INVALID_STATE : ESP_OK;
    command_lock = xSemaphoreCreateMutex();
    if (!command_lock) return ESP_ERR_NO_MEM;
    commands = xQueueCreateStatic(1, sizeof(Command), command_storage, &command_control); states = xQueueCreate(1, sizeof(Snapshot));
    if (!commands || !states) { if (commands) vQueueDelete(commands); if (states) vQueueDelete(states); commands = states = nullptr; vSemaphoreDelete(command_lock); command_lock = nullptr; return ESP_ERR_NO_MEM; }
    quit.store(false); done.store(false); events.store(0);
    if (xTaskCreate(worker, "adv_wifi", 6144, nullptr, 4, nullptr) != pdPASS) {
        done.store(true); vQueueDelete(commands); vQueueDelete(states); commands = states = nullptr; vSemaphoreDelete(command_lock); command_lock = nullptr; return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
esp_err_t scan() {
    if (!commands || done.load() || quit.load()) return ESP_ERR_INVALID_STATE;
    Command c{}; c.scanning = true;
    xSemaphoreTake(command_lock, portMAX_DELAY);
    esp_err_t err = quit.load() || done.load() ? ESP_ERR_INVALID_STATE :
        xQueueSend(commands, &c, 0) == pdTRUE ? ESP_OK : ESP_ERR_TIMEOUT;
    xSemaphoreGive(command_lock);
    return err;
}
static esp_err_t enqueue_connect(const Ap& ap, const Password& password, bool pin_ap) {
    if (!commands || done.load() || quit.load()) return ESP_ERR_INVALID_STATE;
    bool open = ap.auth == WIFI_AUTH_OPEN;
    if (!(open || ap.auth == WIFI_AUTH_WPA2_PSK || ap.auth == WIFI_AUTH_WPA3_PSK || ap.auth == WIFI_AUTH_WPA2_WPA3_PSK)) return ESP_ERR_NOT_SUPPORTED;
    if (!password.valid(open) || !ap.ssid[0]) return ESP_ERR_INVALID_ARG;
    Command c{}; c.ap = ap; c.password = password; c.pin_ap = pin_ap;
    xSemaphoreTake(command_lock, portMAX_DELAY);
    esp_err_t err = quit.load() || done.load() ? ESP_ERR_INVALID_STATE :
        xQueueSend(commands, &c, 0) == pdTRUE ? ESP_OK : ESP_ERR_TIMEOUT;
    xSemaphoreGive(command_lock);
    wipe(&c, sizeof(c)); return err;
}
esp_err_t connect(const Ap& ap, const Password& password) { return enqueue_connect(ap, password, true); }
esp_err_t connect_saved(const Ap& ap, const Password& password) { return enqueue_connect(ap, password, false); }
void stop() { quit.store(true); }
bool stopped() {
    if (!done.load()) return false;
    if (commands) { vQueueDelete(commands); commands = nullptr; wipe(command_storage, sizeof(command_storage)); }
    if (states) { vQueueDelete(states); states = nullptr; }
    if (command_lock) { vSemaphoreDelete(command_lock); command_lock = nullptr; }
    return true;
}
Snapshot snapshot() { Snapshot s; if (states) xQueuePeek(states, &s, 0); return s; }
esp_err_t save_protected(const Ap& ap, const Password& p) { return save_credentials(ap, p); }
bool protection_ready() { return adv_wifi_protection_ready(); }

}
