#pragma once
#include "wifi_model.hpp"
#include "esp_err.h"
namespace advwifi {
// Main task owns this service; output always cleared on missing/error.
esp_err_t load_credentials(Ap&, Password&);
esp_err_t save_credentials(const Ap&, const Password&);
// Pure boot policy shared with host tests; no preference default bypass.
inline bool should_restore(bool preferences_valid, bool auto_connect, bool protection, esp_err_t load_result) {
    return preferences_valid && auto_connect && protection && load_result == ESP_OK;
}
}
