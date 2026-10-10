#pragma once
#include <stdbool.h>
#include <stdint.h>
typedef struct { uint8_t row, col; bool pressed; } adv_key_t;
/* TCA8418 scans 7x8; physical Cardputer layout is 4x14. */
static inline bool adv_decode_key(uint8_t raw, adv_key_t *out) {
    unsigned code = raw & 0x7f;
    if (!out || code == 0) return false;
    unsigned r = (code - 1) / 10, c = (code - 1) % 10;
    if (r >= 7 || c >= 8) return false;
    out->row = c % 4;
    out->col = r * 2 + (c > 3);
    out->pressed = (raw & 0x80) != 0;
    return true;
}
