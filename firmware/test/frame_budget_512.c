#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "device_config.h"
#include "json_lite.h"

_Static_assert(MCU_MAX_FRAME_BYTES == 512, "this regression must exercise the minimum frame profile");
_Static_assert(
    MCU_DETAIL_PAGE_BUFFER_BYTES == MCU_MAX_FRAME_BYTES + 1,
    "every supported profile must retain a complete section token plus NUL"
);

static jl_doc parse_frame(const char *json) {
    jl_doc doc;
    size_t length = strlen(json);
    assert(length <= MCU_MAX_FRAME_BYTES);
    assert(jl_parse(&doc, json, length));
    return doc;
}

static void test_unicode_content_token_fits_detail_buffer(void) {
    const char *json =
        "{\"id\":\"r\",\"kind\":\"response\",\"requestId\":\"q\",\"success\":true,"
        "\"data\":{\"rootChatId\":\"root\",\"node\":{\"id\":\"n\","
        "\"content\":\"line\\n\\ud83d\\ude00中\\\"tail\"},\"refs\":[],\"hasMore\":false,"
        "\"page\":{\"section\":\"content\",\"offset\":0,\"consumed\":13}}}";
    jl_doc doc = parse_frame(json);
    jl_view data = jl_get(&doc, "data");
    jl_view node = jl_get_in(&doc, &data, "node");
    jl_view content = jl_get_in(&doc, &node, "content");
    assert(content.found);
    assert((size_t)content.len < MCU_DETAIL_PAGE_BUFFER_BYTES);
    char decoded[MCU_DETAIL_PAGE_BUFFER_BYTES];
    size_t bytes = jl_copy_unescaped(&content, decoded, sizeof decoded);
    assert(bytes == strlen("line\n😀中\"tail"));
    assert(strcmp(decoded, "line\n😀中\"tail") == 0);
    assert(jl_utf16_units_unescaped(&content) == 13);
}

static void test_long_tool_metadata_array_is_copied_whole(void) {
    char call_id[81];
    char name[81];
    memset(call_id, 'c', sizeof call_id - 1);
    memset(name, 'n', sizeof name - 1);
    call_id[sizeof call_id - 1] = 0;
    name[sizeof name - 1] = 0;

    char json[MCU_MAX_FRAME_BYTES + 1];
    int written = snprintf(
        json,
        sizeof json,
        "{\"id\":\"r\",\"kind\":\"response\",\"requestId\":\"q\",\"success\":true,"
        "\"data\":{\"rootChatId\":\"r\",\"node\":{\"id\":\"n\",\"toolCalls\":[{"
        "\"callId\":\"%s\",\"index\":0,\"name\":\"%s\",\"status\":\"completed\","
        "\"arguments\":\"{}\"}]},\"refs\":[],\"hasMore\":false,\"page\":{"
        "\"section\":\"toolCalls\",\"cursor\":{\"callIndex\":0,\"field\":\"arguments\","
        "\"offset\":0},\"consumed\":2}}}",
        call_id,
        name
    );
    assert(written > 0 && written <= MCU_MAX_FRAME_BYTES);
    jl_doc doc = parse_frame(json);
    jl_view data = jl_get(&doc, "data");
    jl_view node = jl_get_in(&doc, &data, "node");
    jl_view calls = jl_get_in(&doc, &node, "toolCalls");
    assert(calls.found);
    assert(calls.len > 128); /* old maxFrameBytes-384 buffer would truncate this array */
    assert((size_t)calls.len < MCU_DETAIL_PAGE_BUFFER_BYTES);
    char copied[MCU_DETAIL_PAGE_BUFFER_BYTES];
    jl_copy(&calls, copied, sizeof copied);
    assert(strlen(copied) == (size_t)calls.len);
    assert(strstr(copied, call_id) != NULL);
    assert(strstr(copied, name) != NULL);
}

int main(void) {
    test_unicode_content_token_fits_detail_buffer();
    test_long_tool_metadata_array_is_copied_whole();
    puts("firmware 512-byte frame tests passed");
    return 0;
}
