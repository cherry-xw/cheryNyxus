#pragma once
#include "wifi_model.hpp"
#include "esp_err.h"
namespace advwifi {
esp_err_t start();
esp_err_t scan();
esp_err_t connect(const Ap&, const Password&);
// Boot-only saved connection: no pinned BSSID/channel.
esp_err_t connect_saved(const Ap&, const Password&);
void stop();
bool stopped();
Snapshot snapshot();
esp_err_t save_protected(const Ap&, const Password&);
esp_err_t restore_at_boot(bool preferences_valid, bool auto_connect);
bool protection_ready();
}
