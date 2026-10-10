#pragma once
#include "key_event.h"
typedef enum { ADV_NONE, ADV_NEXT, ADV_PREVIOUS, ADV_LEFT, ADV_RIGHT, ADV_ACCEPT, ADV_EXIT } adv_action_t;
/* Physical positions from M5Stack's CardputerADV keyboard map. */
static inline adv_action_t adv_ui_decode(adv_key_t key, bool *fn) {
    if (!fn || key.row >= 4 || key.col >= 14) return ADV_NONE;
    if (key.row == 2 && key.col == 0) { *fn = key.pressed; return ADV_NONE; }
    if (!key.pressed) return ADV_NONE;
    if (key.row == 1 && key.col == 0) return ADV_NEXT; /* Tab */
    if (key.row == 2 && key.col == 13) return ADV_ACCEPT;
    if (!*fn) return ADV_NONE;
    if (key.row == 0 && key.col == 0) return ADV_EXIT;
    if (key.row == 2 && key.col == 11) return ADV_PREVIOUS;
    if (key.row == 3 && key.col == 10) return ADV_LEFT;
    if (key.row == 3 && key.col == 11) return ADV_NEXT;
    if (key.row == 3 && key.col == 12) return ADV_RIGHT;
    return ADV_NONE;
}
