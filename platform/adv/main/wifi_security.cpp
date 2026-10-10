#include "wifi_security.h"
#include "wifi_model.hpp"
#include "sdkconfig.h"
#include "nvs_flash.h"
#if defined(CONFIG_ADV_WIFI_PROTECTION_HMAC) || defined(CONFIG_ADV_WIFI_PROTECTION_FLASH)
#include "esp_secure_boot.h"
#include "esp_flash_encrypt.h"
#include "esp_efuse.h"
#include "nvs_sec_provider.h"
#endif
namespace {
bool initialized_secure = false;
#if defined(CONFIG_ADV_WIFI_PROTECTION_HMAC)
bool deployed() {
    constexpr int id = CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID;
    if (id < 0 || id > 5 || !esp_secure_boot_enabled()) return false;
    auto block = static_cast<esp_efuse_block_t>(EFUSE_BLK_KEY0 + id);
    return esp_efuse_get_key_purpose(block) == ESP_EFUSE_KEY_PURPOSE_HMAC_UP &&
           esp_efuse_get_key_dis_read(block) && esp_efuse_get_key_dis_write(block) &&
           esp_efuse_get_keypurpose_dis_write(block);
}
#elif defined(CONFIG_ADV_WIFI_PROTECTION_FLASH)
const esp_partition_t* key_partition() {
    return esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS_KEYS, nullptr);
}
bool deployed() {
    const auto* p = key_partition();
    auto protected_key = [](esp_efuse_purpose_t purpose) {
        esp_efuse_block_t block;
        return esp_efuse_find_purpose(purpose, &block) && esp_efuse_get_key_dis_read(block) &&
               esp_efuse_get_key_dis_write(block) && esp_efuse_get_keypurpose_dis_write(block);
    };
    bool keys = protected_key(ESP_EFUSE_KEY_PURPOSE_XTS_AES_128_KEY) ||
        (protected_key(ESP_EFUSE_KEY_PURPOSE_XTS_AES_256_KEY_1) && protected_key(ESP_EFUSE_KEY_PURPOSE_XTS_AES_256_KEY_2));
    return esp_secure_boot_enabled() && esp_flash_encryption_enabled() &&
           esp_get_flash_encryption_mode() == ESP_FLASH_ENC_MODE_RELEASE && keys &&
           p && p->encrypted && p->size >= 4096;
}
#else
bool deployed() { return false; }
#endif
}
extern "C" bool adv_wifi_protection_ready() { return initialized_secure && deployed(); }
extern "C" esp_err_t adv_nvs_init() {
    // Sole boot-time NVS owner. Never call the auto-provisioning encrypted init path.
#if defined(CONFIG_ADV_WIFI_PROTECTION_HMAC) || defined(CONFIG_ADV_WIFI_PROTECTION_FLASH)
    if (!deployed()) return ESP_ERR_INVALID_STATE;
    nvs_sec_cfg_t keys{};
    esp_err_t err;
#if defined(CONFIG_ADV_WIFI_PROTECTION_HMAC)
    // SDK owns the default scheme for the entire process lifetime.
    // Re-registering and deregistering would leave its shallow copy dangling.
    nvs_sec_scheme_t* scheme = nvs_flash_get_default_security_scheme();
    if (!scheme || scheme->scheme_id != NVS_SEC_SCHEME_HMAC || !scheme->scheme_data) {
        err = ESP_ERR_INVALID_STATE;
    } else {
        const auto* config = static_cast<const nvs_sec_config_hmac_t*>(scheme->scheme_data);
        err = config->hmac_key_id == static_cast<hmac_key_id_t>(CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID)
            ? nvs_flash_read_security_cfg_v2(scheme, &keys) : ESP_ERR_INVALID_STATE;
    }
#else
    err = nvs_flash_read_security_cfg(key_partition(), &keys);
#endif
    if (err == ESP_OK) err = nvs_flash_secure_init(&keys);
    advwifi::wipe(&keys, sizeof(keys));
    initialized_secure = err == ESP_OK;
    return err;
#else
#ifdef CONFIG_NVS_ENCRYPTION
    return ESP_ERR_INVALID_STATE; // No selected policy: no SDK key generation, no plaintext fallback.
#else
    return nvs_flash_init(); // Ordinary non-secret preferences only.
#endif
#endif
}
