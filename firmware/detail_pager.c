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
    pager->offset = pager->next_offset;
    pager->has_page = false;
    pager->failed = false;
    pager->content[0] = 0;
    pager->content_bytes = 0;
    return true;
}

bool detail_pager_previous(DetailPager *pager) {
    if (!pager || pager->in_flight || pager->offset == 0) return false;
    pager->offset = pager->offset > MCU_DETAIL_PAGE_CHARS
        ? pager->offset - MCU_DETAIL_PAGE_CHARS
        : 0;
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
    bool server_has_more
) {
    if (!pager) return;
    size_t keep = decoded_bytes < sizeof pager->content - 1
        ? decoded_bytes
        : sizeof pager->content - 1;
    if (decoded && keep > 0) memmove(pager->content, decoded, keep);
    pager->content[keep] = 0;
    pager->content_bytes = (uint16_t)keep;
    pager->page_units = (uint16_t)(utf16_units > UINT16_MAX ? UINT16_MAX : utf16_units);
    pager->next_offset = pager->offset + utf16_units;
    /* node.get 当前实现可能在恰好命中请求 limit 时不置 hasMore；允许再探一页。 */
    pager->has_more = server_has_more || utf16_units >= MCU_DETAIL_PAGE_CHARS;
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
