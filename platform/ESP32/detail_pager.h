/* detail_pager.h — node.get 单页驻留状态；正文/thinking/工具详情均不累积。 */
#ifndef DETAIL_PAGER_H
#define DETAIL_PAGER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "device_config.h"
#include "execution_state.h"

typedef enum {
    DETAIL_CONTENT,
    DETAIL_THINKING,
    DETAIL_TOOL_CALLS,
} detail_section_t;

typedef enum {
    DETAIL_TOOL_ARGUMENTS,
    DETAIL_TOOL_RESULT,
} detail_tool_field_t;

typedef struct {
    uint32_t call_index;
    detail_tool_field_t field;
    uint32_t offset;
} detail_cursor_t;

typedef struct {
    char node_id[EXECUTION_ID_BYTES];
    detail_section_t section;
    detail_cursor_t cursor;
    detail_cursor_t next_cursor;
    detail_cursor_t history[MCU_DETAIL_CURSOR_HISTORY];
    uint8_t history_count;
    uint16_t page_units;
    uint16_t content_bytes;
    bool has_page;
    bool has_more;
    bool in_flight;
    bool failed;
    char content[MCU_DETAIL_PAGE_BUFFER_BYTES];
} DetailPager;

void detail_pager_init(DetailPager *pager);
bool detail_pager_begin(DetailPager *pager, const char *node_id, detail_section_t section);
bool detail_pager_next(DetailPager *pager);
bool detail_pager_previous(DetailPager *pager);
void detail_pager_request_started(DetailPager *pager);
void detail_pager_request_failed(DetailPager *pager);

/* decoded 是已解码 UTF-8（toolCalls 可传有界 JSON 文本）；next_cursor 必须来自服务端 page 元数据。 */
void detail_pager_apply(
    DetailPager *pager,
    const char *decoded,
    size_t decoded_bytes,
    uint32_t utf16_units,
    const detail_cursor_t *next_cursor
);

const char *detail_section_name(detail_section_t section);
const char *detail_tool_field_name(detail_tool_field_t field);

#endif /* DETAIL_PAGER_H */
