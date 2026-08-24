#include <string.h>
#include "detail_pager.h"

void detail_pager_init(DetailPager *pager) {
    if (pager) memset(pager, 0, sizeof *pager);
}

bool detail_pager_begin(DetailPager *pager, const char *node_id, detail_section_t section) {
    if (!pager || !node_id || !node_id[0]) return false;
    detail_pager_init(pager);
    strncpy(pager->node_id, node_id, sizeof pager->node_id - 1);
    pager->section = section;
    return true;
}

bool detail_pager_next(DetailPager *pager) {
    if (!pager || pager->in_flight || !pager->has_page || !pager->has_more) return false;
    if (pager->history_count == MCU_DETAIL_CURSOR_HISTORY) {
        memmove(&pager->history[0], &pager->history[1],
                (MCU_DETAIL_CURSOR_HISTORY - 1) * sizeof pager->history[0]);
        pager->history_count--;
    }
    pager->history[pager->history_count++] = pager->cursor;
    pager->cursor = pager->next_cursor;
    pager->has_page = false;
    pager->failed = false;
    pager->content[0] = 0;
    pager->content_bytes = 0;
    return true;
}

bool detail_pager_previous(DetailPager *pager) {
    if (!pager || pager->in_flight || pager->history_count == 0) return false;
    pager->cursor = pager->history[--pager->history_count];
    pager->has_page = false;
    pager->failed = false;
    pager->content[0] = 0;
    pager->content_bytes = 0;
    return true;
}

void detail_pager_request_started(DetailPager *pager) {
    if (!pager) return;
    pager->in_flight = true;
    pager->failed = false;
}

void detail_pager_request_failed(DetailPager *pager) {
    if (!pager) return;
    pager->in_flight = false;
    pager->failed = true;
}

void detail_pager_apply(
    DetailPager *pager,
    const char *decoded,
    size_t decoded_bytes,
    uint32_t utf16_units,
    const detail_cursor_t *next_cursor
) {
    if (!pager) return;
    size_t keep = decoded_bytes < sizeof pager->content - 1
        ? decoded_bytes
        : sizeof pager->content - 1;
    if (decoded && keep > 0) memmove(pager->content, decoded, keep);
    pager->content[keep] = 0;
    pager->content_bytes = (uint16_t)keep;
    pager->page_units = (uint16_t)(utf16_units > UINT16_MAX ? UINT16_MAX : utf16_units);
    bool advances = false;
    if (next_cursor) {
        if (pager->section != DETAIL_TOOL_CALLS) {
            advances = next_cursor->offset > pager->cursor.offset;
        } else if (next_cursor->call_index > pager->cursor.call_index) {
            advances = true;
        } else if (next_cursor->call_index == pager->cursor.call_index) {
            if (next_cursor->field > pager->cursor.field) advances = true;
            else if (next_cursor->field == pager->cursor.field &&
                     next_cursor->offset > pager->cursor.offset) advances = true;
        }
    }
    pager->has_more = advances;
    if (advances) pager->next_cursor = *next_cursor;
    pager->has_page = true;
    pager->in_flight = false;
    pager->failed = false;
}

const char *detail_section_name(detail_section_t section) {
    switch (section) {
    case DETAIL_THINKING: return "thinking";
    case DETAIL_TOOL_CALLS: return "toolCalls";
    case DETAIL_CONTENT:
    default: return "content";
    }
}

const char *detail_tool_field_name(detail_tool_field_t field) {
    return field == DETAIL_TOOL_RESULT ? "result" : "arguments";
}
