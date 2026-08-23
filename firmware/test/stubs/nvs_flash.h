#ifndef HOST_NVS_FLASH_H
#define HOST_NVS_FLASH_H

#include <stddef.h>
#include <stdint.h>

typedef uint32_t nvs_handle_t;
#define ESP_OK 0
#define NVS_READWRITE 1

int nvs_flash_init(void);
int nvs_open(const char *name, int mode, nvs_handle_t *handle);
int nvs_set_blob(nvs_handle_t handle, const char *key, const void *value, size_t length);
int nvs_commit(nvs_handle_t handle);
void nvs_close(nvs_handle_t handle);

#endif
