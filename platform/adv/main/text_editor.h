#pragma once
#include "lvgl.h"
#include "text_input.h"
/* Call only while owning the existing LVGL port lock. No storage or transport. */
static inline bool adv_text_apply(lv_obj_t *ta, adv_text_event_t e) {
    switch (e.kind) {
    case ADV_TEXT_CHAR: {
        char text[2] = {e.character, 0};
        if (!adv_text_can_insert(lv_textarea_get_text(ta), text)) return false;
        lv_textarea_add_text(ta, text); break;
    }
    case ADV_TEXT_BACKSPACE: lv_textarea_delete_char(ta); break;
    case ADV_TEXT_DELETE: lv_textarea_delete_char_forward(ta); break;
    case ADV_TEXT_LEFT: lv_textarea_cursor_left(ta); break;
    case ADV_TEXT_RIGHT: lv_textarea_cursor_right(ta); break;
    case ADV_TEXT_UP: lv_textarea_cursor_up(ta); break;
    case ADV_TEXT_DOWN: lv_textarea_cursor_down(ta); break;
    default: break;
    }
    return true;
}
static inline bool adv_text_save_draft(lv_obj_t *ta, char (&draft)[1025]) {
    const char *text = lv_textarea_get_text(ta);
    size_t bytes, characters;
    if (!adv_text_measure(text, &bytes, &characters) || bytes > 1024 || characters > 256) return false;
    memcpy(draft, text, bytes + 1);
    return true;
}
