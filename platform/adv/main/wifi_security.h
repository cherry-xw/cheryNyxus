#pragma once
#include "esp_err.h"
#include <stdbool.h>
#ifdef __cplusplus
extern "C" {
#endif
esp_err_t adv_nvs_init(void);
bool adv_wifi_protection_ready(void);
#ifdef __cplusplus
}
#endif
