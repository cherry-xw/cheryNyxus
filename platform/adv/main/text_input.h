#pragma once
#include "ui_input.h"
#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* Map data: M5Stack CardputerADV b549eac0a3c65bc108186c276b8fac0a214aaa4e,
 * keyboard.cpp, Copyright 2025 M5Stack Technology CO LTD, MIT.
 * Only physical key values are reused; see fonts/keyboard-MIT.txt. */
typedef enum { ADV_TEXT_NONE, ADV_TEXT_CHAR, ADV_TEXT_BACKSPACE,
    ADV_TEXT_DELETE, ADV_TEXT_LEFT, ADV_TEXT_RIGHT, ADV_TEXT_UP,
    ADV_TEXT_DOWN, ADV_TEXT_RETURN, ADV_TEXT_EXIT } adv_text_kind_t;
typedef struct { adv_text_kind_t kind; char character; } adv_text_event_t;
typedef struct { bool fn, shift, ctrl, alt, opt; } adv_text_modifiers_t;
static inline adv_text_event_t adv_text_decode(adv_key_t k, adv_text_modifiers_t *m) {
    adv_text_event_t e = {ADV_TEXT_NONE, 0};
    if (!m || k.row >= 4 || k.col >= 14) return e;
    bool *modifier = NULL;
    if (k.row == 2 && k.col == 0) modifier = &m->fn;
    if (k.row == 2 && k.col == 1) modifier = &m->shift;
    if (k.row == 3 && k.col == 0) modifier = &m->ctrl;
    if (k.row == 3 && k.col == 1) modifier = &m->opt;
    if (k.row == 3 && k.col == 2) modifier = &m->alt;
    if (modifier) { *modifier = k.pressed; return e; }
    if (!k.pressed) return e;
    if (m->fn && k.row == 0 && k.col == 0) { e.kind = ADV_TEXT_EXIT; return e; }
    if (k.row == 1 && k.col == 0) { e.kind = ADV_TEXT_RETURN; return e; }
    if (m->ctrl || m->alt || m->opt) return e;
    if (k.row == 0 && k.col == 13) { e.kind = m->fn ? ADV_TEXT_DELETE : ADV_TEXT_BACKSPACE; return e; }
    if (m->fn) {
        if (k.row == 2 && k.col == 11) e.kind = ADV_TEXT_UP;
        if (k.row == 3 && k.col == 10) e.kind = ADV_TEXT_LEFT;
        if (k.row == 3 && k.col == 11) e.kind = ADV_TEXT_DOWN;
        if (k.row == 3 && k.col == 12) e.kind = ADV_TEXT_RIGHT;
        if (e.kind != ADV_TEXT_NONE) return e;
    }
    if (k.row == 2 && k.col == 13) { e.kind = ADV_TEXT_CHAR; e.character = '\n'; return e; }
    static const char plain[4][15] = {"`1234567890-=\0", "\0qwertyuiop[]\\", "\0\0asdfghjkl;'\0", "\0\0\0zxcvbnm,./ "};
    static const char shifted[4][15] = {"~!@#$%^&*()_+\0", "\0QWERTYUIOP{}|", "\0\0ASDFGHJKL:\"\0", "\0\0\0ZXCVBNM<>? "};
    e.character = (m->shift ? shifted : plain)[k.row][k.col];
    if (m->fn && e.character >= 'a' && e.character <= 'z') e.character -= 'a' - 'A';
    if (e.character) e.kind = ADV_TEXT_CHAR;
    return e;
}
/* Validate scalar UTF-8, not grapheme clusters. Never truncate mid-codepoint. */
static inline bool adv_text_measure(const char *s, size_t *bytes, size_t *characters) {
    if (!s || !bytes || !characters) return false;
    *bytes = *characters = 0;
    const unsigned char *p = (const unsigned char *)s;
    while (*p) {
        uint32_t cp = *p; unsigned n = 1; uint32_t minimum = 0;
        if (*p >= 0xc2 && *p <= 0xdf) { n=2; cp=*p & 31; minimum=0x80; }
        else if (*p >= 0xe0 && *p <= 0xef) { n=3; cp=*p & 15; minimum=0x800; }
        else if (*p >= 0xf0 && *p <= 0xf4) { n=4; cp=*p & 7; minimum=0x10000; }
        else if (*p >= 0x80) return false;
        for (unsigned i=1; i<n; ++i) {
            if ((p[i] & 0xc0) != 0x80) return false;
            cp = (cp << 6) | (p[i] & 63);
        }
        if (cp < minimum || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
        *bytes += n; ++*characters; p += n;
    }
    return true;
}
static inline bool adv_text_can_insert(const char *current, const char *insert) {
    size_t b, c, ib, ic;
    return adv_text_measure(current, &b, &c) && adv_text_measure(insert, &ib, &ic)
        && b <= 1024 && ib <= 1024-b && c <= 256 && ic <= 256-c;
}
