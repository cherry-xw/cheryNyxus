#include "adv_wifi.hpp"
#include "wifi_credentials.hpp"
namespace advwifi {
esp_err_t restore_at_boot(bool preferences_valid, bool auto_connect) {
    if (!preferences_valid || !auto_connect) return ESP_OK;
    Ap ap{}; Password p;
    esp_err_t err = load_credentials(ap, p);
    if (should_restore(preferences_valid, auto_connect, protection_ready(), err)) {
        err = start();
        if (err == ESP_OK) err = connect_saved(ap, p);
    }
    p.clear(); wipe(&ap, sizeof(ap));
    return err;
}
}
