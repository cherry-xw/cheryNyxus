#include "wifi_credentials.hpp"
#include "wifi_security.h"
#include "nvs.h"
#include <cstring>
namespace advwifi {
namespace {
// Stable byte format: version, auth, ssid length, password length, 32-byte SSID, 63-byte password.
constexpr std::size_t record_size = 99;
bool valid(const Ap& ap, const Password& p) {
    const auto n = strnlen(ap.ssid, sizeof(ap.ssid));
    bool open = ap.auth == 0;
    if (!(open || ap.auth == 3 || ap.auth == 6 || ap.auth == 7) || !n || n > 32 || !p.valid(open)) return false;
    for (std::size_t i = 0; i < p.size; ++i) if (p.bytes[i] < 32 || p.bytes[i] > 126) return false;
    return p.bytes[p.size] == 0;
}
esp_err_t read(nvs_handle_t h, Ap& ap, Password& p) {
    uint8_t b[record_size]{}; std::size_t n = sizeof(b);
    esp_err_t err = nvs_get_blob(h, "credentials", b, &n);
    if (err == ESP_OK) {
        if (n != sizeof(b) || b[0] != 1 || b[2] == 0 || b[2] > 32 || b[3] > 63) err = ESP_ERR_INVALID_STATE;
        else {
            ap.auth = b[1]; std::memcpy(ap.ssid, b + 4, b[2]);
            std::memcpy(p.bytes, b + 36, b[3]); p.size = b[3];
            for (std::size_t i = b[2]; i < 32; ++i) if (b[4+i]) err = ESP_ERR_INVALID_STATE;
            for (std::size_t i = b[3]; i < 63; ++i) if (b[36+i]) err = ESP_ERR_INVALID_STATE;
            if (strnlen(ap.ssid, sizeof(ap.ssid)) != b[2] || !valid(ap, p)) err = ESP_ERR_INVALID_STATE;
        }
    }
    wipe(b, sizeof(b));
    if (err != ESP_OK) { wipe(&ap, sizeof(ap)); p.clear(); }
    return err;
}
}
esp_err_t load_credentials(Ap& ap, Password& p) {
    wipe(&ap, sizeof(ap)); p.clear();
    if (!adv_wifi_protection_ready()) return ESP_ERR_NOT_SUPPORTED;
    nvs_handle_t h;
    esp_err_t err = nvs_open("adv_wifi", NVS_READONLY, &h);
    if (err != ESP_OK) return err;
    err = read(h, ap, p); nvs_close(h); return err;
}
esp_err_t save_credentials(const Ap& ap, const Password& p) {
    if (!adv_wifi_protection_ready()) return ESP_ERR_NOT_SUPPORTED;
    if (!valid(ap, p)) return ESP_ERR_INVALID_ARG;
    // Re-read immediately before writing; unknown/corrupt data must survive untouched.
    Ap existing{}; Password old;
    esp_err_t err = load_credentials(existing, old);
    old.clear(); wipe(&existing, sizeof(existing));
    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) return err;
    nvs_handle_t h;
    err = nvs_open("adv_wifi", NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    uint8_t b[record_size]{};
    b[0] = 1; b[1] = ap.auth; b[2] = static_cast<uint8_t>(strnlen(ap.ssid, 33)); b[3] = static_cast<uint8_t>(p.size);
    std::memcpy(b + 4, ap.ssid, b[2]); std::memcpy(b + 36, p.bytes, p.size);
    err = nvs_set_blob(h, "credentials", b, sizeof(b));
    wipe(b, sizeof(b));
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h); return err;
}
}
