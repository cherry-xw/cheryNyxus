#ifndef HOST_ESP_LOG_H
#define HOST_ESP_LOG_H

#include <stdio.h>
#define ESP_LOGI(tag, ...) do { (void)(tag); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } while (0)
#define ESP_LOGW(tag, ...) do { (void)(tag); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } while (0)
#define ESP_LOGE(tag, ...) do { (void)(tag); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } while (0)

#endif
