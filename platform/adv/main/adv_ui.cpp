#include "adv_ui.h"
#include "ui_input.h"
#include "text_editor.h"
#include "adv_foundation.hpp"
#include "adv_wifi.hpp"
#include "esp_lvgl_port.h"
#include "esp_log.h"
#include "nvs.h"
#include <cstdio>
#include <cstring>
#include <memory>

LV_FONT_DECLARE(adv_font_basic);
namespace {
adv::Runtime runtime;
adv::Preferences preferences;
esp_err_t preferences_error = ESP_OK;
enum class Page { Launcher, Settings, Diagnostics, Text, Wifi, Password };
adv_text_modifiers_t text_modifiers{};
lv_obj_t *textarea = nullptr;
char draft[1025] = "你好世界\n";
advwifi::Password password;
advwifi::Ap chosen;
char character = 'a';
unsigned ap_index = 0;
bool exiting = false;
Page page = Page::Launcher;
unsigned selected = 0;
bool fn = false;
lv_obj_t *title, *rows[5], *notice, *footer;
char message[64] = "";
char cached[5][80]{};

void set_row(unsigned i, const char *value) {
    if (std::strcmp(cached[i], value) == 0) return;
    std::snprintf(cached[i], sizeof(cached[i]), "%s", value);
    lv_label_set_text(rows[i], cached[i]);
}
void show_page(Page next) {
    if (textarea) {
        if (!adv_text_save_draft(textarea, draft)) {
            std::snprintf(message, sizeof(message), "Invalid draft; return blocked");
            return;
        }
        lv_obj_delete(textarea); textarea = nullptr;
    }
    page = next;
    selected = 0;
    for (unsigned i=0; i<5; ++i) set_row(i, "");
    lv_label_set_text(title, page == Page::Launcher ? "cheryNyxus ADV" :
        page == Page::Settings ? "Settings" : page == Page::Wifi ? "Wi-Fi settings" : page == Page::Password ? "Password" : page == Page::Text ? "Text editing (no send)" : "Hardware diagnostics");
    for (auto *row : rows) {
        if (page == Page::Text) lv_obj_add_flag(row, LV_OBJ_FLAG_HIDDEN);
        else lv_obj_remove_flag(row, LV_OBJ_FLAG_HIDDEN);
    }
    if (page == Page::Text) {
        textarea = lv_textarea_create(lv_screen_active());
        lv_obj_set_pos(textarea, 4, 20); lv_obj_set_size(textarea, 232, 82);
        lv_obj_set_style_text_font(textarea, &adv_font_basic, 0);
        lv_textarea_set_max_length(textarea, 256);
        lv_textarea_set_text(textarea, draft);
        lv_textarea_set_cursor_pos(textarea, LV_TEXTAREA_CURSOR_LAST);
        std::snprintf(message, sizeof(message), "RAM draft only; no input method");
    }
    lv_label_set_text(footer, "Tab: next  Enter: select");
}
class SettingsApp final : public mooncake::AppAbility {
    void onCreate() override { setAppInfo().name = "Settings"; }
    void onOpen() override { show_page(Page::Settings); }
};
class DiagnosticsApp final : public mooncake::AppAbility {
    void onCreate() override { setAppInfo().name = "Hardware diagnostics"; }
    void onOpen() override { show_page(Page::Diagnostics); }
};
std::unique_ptr<mooncake::AppAbility> make_settings() { return std::make_unique<SettingsApp>(); }
std::unique_ptr<mooncake::AppAbility> make_diagnostics() { return std::make_unique<DiagnosticsApp>(); }
esp_err_t save_settings() { return preferences_error == ESP_OK ? adv::save_preferences(preferences) : preferences_error; }
esp_err_t no_pending_writes() { return ESP_OK; } // Diagnostics only reads hardware.
void result(const char *operation, esp_err_t err) {
    std::snprintf(message, sizeof(message), "%s: %s", operation, err == ESP_OK ? "saved" : esp_err_to_name(err));
}
void handle(adv_action_t action) {
    if (action == ADV_NONE) return;
    if (exiting) return;
    if (action == ADV_EXIT && runtime.running()) {
        if (textarea && !adv_text_save_draft(textarea, draft)) { std::snprintf(message, sizeof(message), "Invalid draft; exit blocked"); return; }
        esp_err_t err = page == Page::Diagnostics || page == Page::Text ? ESP_OK : save_settings();
        if (err != ESP_OK) { result("Exit save failed", err); return; }
        if (textarea) { lv_obj_delete(textarea); textarea = nullptr; }
        password.clear(); advwifi::stop(); exiting = true;
        std::snprintf(message, sizeof(message), "Stopping network before exit");
        return;
    }
    if (page == Page::Diagnostics && action == ADV_ACCEPT) { show_page(Page::Text); return; }
    unsigned count = page == Page::Launcher ? static_cast<unsigned>(runtime.count()) : page == Page::Settings ? 5 : page == Page::Wifi ? 4 : page == Page::Password ? 4 : 0;
    if (!count) return;
    if (action == ADV_NEXT) selected = (selected + 1) % count;
    if (action == ADV_PREVIOUS) selected = (selected + count - 1) % count;
    if (page == Page::Launcher && action == ADV_ACCEPT) {
        if (!runtime.open(runtime.entry(selected)->id)) std::snprintf(message, sizeof(message), "Application open failed");
    } else if (page == Page::Settings) {
        if (selected == 0 && (action == ADV_LEFT || action == ADV_RIGHT || action == ADV_ACCEPT)) {
            // Service and UI both enforce the recoverable 10..100 range.
            int next = preferences.brightness + (action == ADV_LEFT ? -10 : 10);
            if (next < 10) next = 10;
            if (next > 100) next = 100;
            esp_err_t err = adv_set_brightness(static_cast<uint8_t>(next));
            if (err == ESP_OK) { preferences.brightness = next; std::snprintf(message, sizeof(message), "Unsaved changes"); }
            else result("Brightness failed", err);
        } else if (selected == 1 && (action == ADV_ACCEPT || action == ADV_LEFT || action == ADV_RIGHT)) {
            preferences.auto_connect = !preferences.auto_connect;
            std::snprintf(message, sizeof(message), "Unsaved changes");
        } else if (selected == 2 && action == ADV_ACCEPT) {
            esp_err_t err = advwifi::start();
            if (err != ESP_OK) result("Wi-Fi start", err);
            else { show_page(Page::Wifi); std::snprintf(message, sizeof(message), "%s", advwifi::protection_ready() ? "Select network to save credentials" : "Session only: protection not deployed"); }
        } else if (selected == 3 && action == ADV_ACCEPT) result("Preferences", save_settings());
        else if (selected == 4 && action == ADV_ACCEPT) {
            esp_err_t err = save_settings();
            if (err != ESP_OK) { result("Exit save failed", err); return; }
            password.clear(); advwifi::stop(); exiting = true;
        }
    } else if (page == Page::Wifi) {
        auto s = advwifi::snapshot();
        if (selected == 1 && s.count && (action == ADV_LEFT || action == ADV_RIGHT)) ap_index = (ap_index + (action == ADV_LEFT ? s.count - 1 : 1)) % s.count;
        if (action == ADV_ACCEPT && selected == 0) { esp_err_t e = advwifi::scan(); std::snprintf(message, sizeof(message), "Scan: %s", esp_err_to_name(e)); }
        if (action == ADV_ACCEPT && selected == 1 && s.count) { chosen = s.aps[ap_index % s.count]; password.clear(); character = 'a'; show_page(Page::Password); }
        if (action == ADV_ACCEPT && selected == 2) std::snprintf(message, sizeof(message), "%s", advwifi::protection_ready() ? "Select network; save on password page" : "Save blocked: protection not deployed");
        if (action == ADV_ACCEPT && selected == 3) show_page(Page::Settings);
    } else if (page == Page::Password) {
        if (selected == 0 && (action == ADV_LEFT || action == ADV_RIGHT)) character = static_cast<char>(32 + (character - 32 + (action == ADV_LEFT ? 94 : 1)) % 95);
        if (action == ADV_ACCEPT && selected == 0) { if (!password.append(character)) std::snprintf(message, sizeof(message), "Password limit: 63 bytes"); }
        if (action == ADV_ACCEPT && selected == 1) password.erase();
        if (action == ADV_ACCEPT && selected == 2) {
            bool persistent = advwifi::protection_ready();
            esp_err_t e = persistent ? advwifi::save_protected(chosen, password) : ESP_OK;
            if (e != ESP_OK) { result("Credentials save failed", e); return; }
            e = advwifi::connect(chosen, password);
            std::snprintf(message, sizeof(message), "%s; connect: %s", persistent ? "Credentials saved" : "Session only", esp_err_to_name(e));
            if (e == ESP_OK || persistent) { password.clear(); show_page(Page::Wifi); }
        }
        if (action == ADV_ACCEPT && selected == 3) { password.clear(); show_page(Page::Wifi); }
    }
}
void paint(const adv_status_t &s) {
    char text[80];
    if (page == Page::Launcher) {
        for (unsigned i=0; i<runtime.count(); ++i) {
            std::snprintf(text, sizeof(text), "%c %s", selected == i ? '>' : ' ', runtime.entry(i)->name);
            set_row(i, text);
        }
        set_row(3, s.keyboard_ok ? "Choose one application" : "Keyboard unavailable");
    } else if (page == Page::Settings) {
        std::snprintf(text, sizeof(text), "%c Brightness: %u%%", selected == 0 ? '>' : ' ', preferences.brightness); set_row(0, text);
        std::snprintf(text, sizeof(text), "%c Auto: %s%s", selected == 1 ? '>' : ' ', preferences.auto_connect ? "on" : "off", advwifi::protection_ready() ? "" : " (blocked)"); set_row(1, text);
        set_row(2, selected == 2 ? "> Wi-Fi settings" : "  Wi-Fi settings");
        set_row(3, selected == 3 ? "> Save preferences" : "  Save preferences");
        set_row(4, selected == 4 ? "> Save + restart" : "  Save + restart");
    } else if (page == Page::Wifi) {
        auto w = advwifi::snapshot();
        set_row(0, selected == 0 ? "> Scan networks" : "  Scan networks");
        if (w.count) { auto &a = w.aps[ap_index % w.count]; std::snprintf(text, sizeof(text), "%c %u/%u %.32s (%d)", selected == 1 ? '>' : ' ', ap_index % w.count + 1, w.count, a.ssid, a.rssi); }
        else std::snprintf(text, sizeof(text), "%c No networks; scan first", selected == 1 ? '>' : ' ');
        set_row(1, text);
        std::snprintf(text, sizeof(text), "%c Protected save: %s", selected == 2 ? '>' : ' ', advwifi::protection_ready() ? "password page" : "BLOCKED"); set_row(2, text);
        set_row(3, selected == 3 ? "> Back to settings" : "  Back to settings");
        const char* state = w.phase == advwifi::Phase::Scanning ? "Scanning" : w.phase == advwifi::Phase::Connecting ? "Connecting" : w.phase == advwifi::Phase::Associated ? "Associated; waiting IP" : w.phase == advwifi::Phase::IpReady ? "IP ready (not Internet)" : w.phase == advwifi::Phase::Error ? "Network error" : "Idle";
        std::snprintf(text, sizeof(text), "%s (%s)", state, esp_err_to_name(w.error)); set_row(4, text);
    } else if (page == Page::Password) {
        std::snprintf(text, sizeof(text), "%c Add character: %c", selected == 0 ? '>' : ' ', character); set_row(0, text);
        set_row(1, selected == 1 ? "> Delete last character" : "  Delete last character");
        std::snprintf(text, sizeof(text), "%c %s", selected == 2 ? '>' : ' ', advwifi::protection_ready() ? "Save credentials + connect" : "Connect this session (not saved)"); set_row(2, text);
        set_row(3, selected == 3 ? "> Cancel / clear password" : "  Cancel / clear password");
        char mask[64]; std::memset(mask, '*', password.size); mask[password.size] = 0;
        std::snprintf(text, sizeof(text), "Password: %s", mask); set_row(4, text);
    } else if (page == Page::Diagnostics) {
        std::snprintf(text, sizeof(text), "I2C: %u  Keys: %s", s.devices, s.keyboard_ok ? "OK" : "error"); set_row(0, text);
        std::snprintf(text, sizeof(text), "SD at boot: %s", s.sd_ok ? "mounted" : "unavailable"); set_row(1, text);
        if (s.battery >= 0) std::snprintf(text, sizeof(text), "Battery raw ADC: %d", s.battery);
        else std::snprintf(text, sizeof(text), "Battery ADC: unavailable");
        set_row(2, text);
        if (s.has_key) std::snprintf(text, sizeof(text), "Key R%u C%u: %s", s.key.row, s.key.col, s.key.pressed ? "down" : "up");
        else std::snprintf(text, sizeof(text), "Press a key");
        set_row(3, text);
        set_row(4, "Fn + Esc: restart to chooser");
    }
    lv_label_set_text(notice, page == Page::Settings && preferences_error != ESP_OK ? "Load error: saving blocked" : message);
    if (page == Page::Settings) lv_label_set_text(footer, selected == 0 ? "Fn+, /: brightness +/-" : "Enter: select  Fn+Esc: exit");
    if (page == Page::Diagnostics) lv_label_set_text(footer, "Enter: text  Fn+Esc: restart");
    if (page == Page::Text) lv_label_set_text(footer, "Tab: back  Fn+Esc: restart");
    if (page == Page::Wifi || page == Page::Password) lv_label_set_text(footer, "Tab: next  Fn+, /: change");
}
}
extern "C" void adv_ui_init(esp_lcd_panel_io_handle_t io, esp_lcd_panel_handle_t panel) {
    lvgl_port_cfg_t cfg = ESP_LVGL_PORT_INIT_CONFIG();
    ESP_ERROR_CHECK(lvgl_port_init(&cfg));
    lvgl_port_display_cfg_t display{};
    display.io_handle = io; display.panel_handle = panel;
    display.buffer_size = 240 * 20; display.double_buffer = false;
    display.hres = 240; display.vres = 135;
    display.rotation.swap_xy = true; display.rotation.mirror_y = true;
    display.color_format = LV_COLOR_FORMAT_RGB565;
    display.flags.buff_dma = true; display.flags.swap_bytes = true;
    // full_refresh/direct_mode and PSRAM remain disabled (partial DMA).
    ESP_ERROR_CHECK(lvgl_port_lock(0) ? ESP_OK : ESP_FAIL);
    ESP_ERROR_CHECK(lvgl_port_add_disp(&display) ? ESP_OK : ESP_ERR_NO_MEM);
    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x101820), 0);
    lv_obj_set_style_text_color(screen, lv_color_hex(0xffffff), 0);
    title = lv_label_create(screen); lv_obj_set_pos(title, 4, 0);
    for (unsigned i=0; i<5; ++i) {
        rows[i] = lv_label_create(screen); lv_obj_set_pos(rows[i], 4, 20 + 16*i);
        lv_label_set_text(rows[i], "");
        lv_obj_set_width(rows[i], 232); lv_label_set_long_mode(rows[i], LV_LABEL_LONG_SCROLL_CIRCULAR);
    }
    notice = lv_label_create(screen); lv_obj_set_pos(notice, 4, 104);
    lv_obj_set_width(notice, 232); lv_label_set_long_mode(notice, LV_LABEL_LONG_SCROLL_CIRCULAR);
    footer = lv_label_create(screen); lv_obj_set_pos(footer, 4, 120);
    lv_obj_set_width(footer, 232); lv_label_set_long_mode(footer, LV_LABEL_LONG_SCROLL_CIRCULAR);
    ESP_ERROR_CHECK(runtime.register_app({"settings", "Settings", make_settings}) ? ESP_OK : ESP_FAIL);
    ESP_ERROR_CHECK(runtime.register_app({"diagnostics", "Hardware diagnostics", make_diagnostics}) ? ESP_OK : ESP_FAIL);
    ESP_ERROR_CHECK(runtime.count() <= 3 ? ESP_OK : ESP_ERR_INVALID_SIZE);
    esp_err_t err = adv::load_preferences(preferences);
    preferences_error = err;
    if (err != ESP_OK) result("Preferences load failed", err);
    ESP_ERROR_CHECK(adv_set_brightness(preferences.brightness));
    show_page(Page::Launcher);
    esp_err_t restore = advwifi::restore_at_boot(preferences_error == ESP_OK, preferences.auto_connect);
    if (restore != ESP_OK && restore != ESP_ERR_NVS_NOT_FOUND) result("Wi-Fi restore blocked", restore);
    adv_status_t initial{}; initial.battery = -1;
    paint(initial);
    lvgl_port_unlock();
}
extern "C" void adv_storage_mounted(bool mounted) { adv::sd_store().set_mounted(mounted); }
extern "C" void adv_ui_key(adv_key_t key) {
    // Hardware events and Mooncake operations are owned by app_main, not LVGL callbacks.
    adv_action_t action = adv_ui_decode(key, &fn);
    // Track modifier releases across pages, including entering with Shift held.
    adv_text_event_t text = adv_text_decode(key, &text_modifiers);
    if (lvgl_port_lock(0)) {
        if (page == Page::Text && !exiting) {
            if (text.kind == ADV_TEXT_RETURN) show_page(Page::Diagnostics);
            else if (text.kind == ADV_TEXT_EXIT) handle(ADV_EXIT);
            else if (textarea && !adv_text_apply(textarea, text)) std::snprintf(message, sizeof(message), "Draft limit: 256 chars / 1024 bytes");
        } else handle(action);
        lvgl_port_unlock();
    }
}
extern "C" void adv_ui_update(const adv_status_t *status) {
    if (!status) return;
    if (exiting && advwifi::stopped()) {
        esp_err_t err = runtime.restart_to_launcher(no_pending_writes); // Preferences committed before network shutdown.
        exiting = false;
        result("Exit failed", err);
    }
    if (lvgl_port_lock(0)) {
        runtime.update();
        paint(*status);
        lvgl_port_unlock();
    }
}
