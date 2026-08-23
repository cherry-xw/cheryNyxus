#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "detail_pager.h"
#include "execution_state.h"
#include "esp_websocket_client.h"
#include "json_lite.h"
#include "model.h"
#include "ws_lite.h"

_Static_assert(MCU_MAX_FRAME_BYTES == 2048, "host regression assumes the MCU default frame budget");
_Static_assert(MCU_EXECUTION_STEP_CAPACITY == 16, "default firmware must expose exactly 16 slots");
_Static_assert(
    sizeof(((ExecutionTimeline *)0)->steps) / sizeof(ExecutionStep) == 16,
    "ExecutionTimeline must be a fixed 16-item array"
);

static ExecutionStep step(
    const char *id,
    const char *chat_id,
    const char *run_id,
    execution_kind_t kind,
    execution_status_t status,
    int64_t started_at,
    int64_t completed_at
) {
    ExecutionStep out = {0};
    snprintf(out.id, sizeof out.id, "%s", id);
    snprintf(out.chat_id, sizeof out.chat_id, "%s", chat_id);
    snprintf(out.run_id, sizeof out.run_id, "%s", run_id);
    snprintf(out.name, sizeof out.name, "%s-%s", kind == EXECUTION_KIND_TOOL ? "tool" : "model", id);
    out.kind = kind;
    out.status = status;
    out.started_at_ms = started_at;
    out.completed_at_ms = completed_at;
    return out;
}

static jl_doc parse_json(const char *json) {
    jl_doc doc;
    assert(strlen(json) <= MCU_MAX_FRAME_BYTES);
    assert(jl_parse(&doc, json, strlen(json)));
    return doc;
}

static void dispatch_notification(const char *json) {
    jl_doc doc = parse_json(json);
    model_on_notification(&doc);
}

static void test_json_unescape_and_frame_budget(void) {
    const char *json = "{\"value\":\"line\\n\\ud83d\\ude00中\"}";
    jl_doc doc = parse_json(json);
    jl_view value = jl_get(&doc, "value");
    char decoded[64];
    size_t bytes = jl_copy_unescaped(&value, decoded, sizeof decoded);
    assert(bytes == strlen("line\n😀中"));
    assert(strcmp(decoded, "line\n😀中") == 0);
    assert(jl_utf16_units_unescaped(&value) == 8); /* line + newline + emoji(2) + 中 */

    char content[MCU_DETAIL_PAGE_CHARS + 1];
    memset(content, 'x', MCU_DETAIL_PAGE_CHARS);
    content[MCU_DETAIL_PAGE_CHARS] = 0;
    char response[MCU_MAX_FRAME_BYTES + 1];
    int n = snprintf(response, sizeof response,
        "{\"id\":\"r1\",\"kind\":\"response\",\"requestId\":\"mcu-1\",\"success\":true,"
        "\"data\":{\"rootChatId\":\"root\",\"node\":{\"id\":\"n1\",\"content\":\"%s\"},"
        "\"refs\":[],\"hasMore\":true}}", content);
    assert(n > 0 && n <= MCU_MAX_FRAME_BYTES);
    jl_doc bounded = parse_json(response);
    assert(jl_get(&bounded, "data").found);
}

static int received_frame_count;
static char received_frame[MCU_MAX_FRAME_BYTES + 1];

static void capture_json_frame(const char *json, size_t length) {
    assert(length <= MCU_MAX_FRAME_BYTES);
    memcpy(received_frame, json, length);
    received_frame[length] = 0;
    received_frame_count++;
}

static void ignore_ws_event(ws_event event) { (void)event; }

static void test_websocket_text_binary_and_fragment_decoding(void) {
    received_frame_count = 0;
    assert(ws_lite_start("localhost", 8182, "", capture_json_frame, ignore_ws_event));

    const char *response = "{\"kind\":\"response\",\"success\":true,\"data\":{}}";
    size_t response_len = strlen(response);
    ws_lite_test_feed_fragment(response, 13, 0, response_len, 0x01);
    ws_lite_test_feed_fragment(response + 13, response_len - 13, 13, response_len, 0x00);
    assert(received_frame_count == 1);
    assert(strcmp(received_frame, response) == 0);

    const char *notification_json = "{\"kind\":\"notification\",\"type\":\"done\",\"data\":{}}";
    char binary[128];
    binary[0] = 0x02;
    memcpy(binary + 1, notification_json, strlen(notification_json));
    ws_lite_test_feed_fragment(binary, strlen(notification_json) + 1, 0,
                               strlen(notification_json) + 1, 0x02);
    assert(received_frame_count == 2);
    assert(strcmp(received_frame, notification_json) == 0);

    const char stream[] = { 0x01, 'x' };
    ws_lite_test_feed_fragment(stream, sizeof stream, 0, sizeof stream, 0x02);
    assert(received_frame_count == 2);
    assert(g_ws_stats.rx_stream == 1);

    char oversized[MCU_MAX_FRAME_BYTES + 1];
    memset(oversized, 'x', sizeof oversized);
    ws_lite_test_feed_fragment(oversized, sizeof oversized, 0, sizeof oversized, 0x01);
    assert(received_frame_count == 2);
    assert(g_ws_stats.rx_overflow == 1);
    ws_lite_stop();
}

static void test_websocket_reconnect_releases_every_handle(void) {
    esp_websocket_stub_reset();
    assert(ws_lite_start("localhost", 8182, "", capture_json_frame, ignore_ws_event));
    assert(g_esp_ws_stub_init_count == 1);
    assert(g_esp_ws_stub_destroy_count == 0);
    assert(g_esp_ws_stub_active_handles == 1);

    assert(ws_lite_start("localhost", 8182, "", capture_json_frame, ignore_ws_event));
    assert(g_esp_ws_stub_init_count == 2);
    assert(g_esp_ws_stub_destroy_count == 1);
    assert(g_esp_ws_stub_active_handles == 1);

    esp_websocket_stub_fail_next_start();
    assert(!ws_lite_start("localhost", 8182, "", capture_json_frame, ignore_ws_event));
    assert(g_esp_ws_stub_init_count == 3);
    assert(g_esp_ws_stub_destroy_count == 3);
    assert(g_esp_ws_stub_active_handles == 0);

    assert(ws_lite_start("localhost", 8182, "", capture_json_frame, ignore_ws_event));
    assert(g_esp_ws_stub_active_handles == 1);
    ws_lite_stop();
    assert(g_esp_ws_stub_init_count == 4);
    assert(g_esp_ws_stub_destroy_count == 4);
    assert(g_esp_ws_stub_active_handles == 0);
}

static void test_sequential_and_parallel_steps(void) {
    ExecutionTimeline timeline;
    execution_timeline_init(&timeline);

    ExecutionStep model = step("m1", "root", "run", EXECUTION_KIND_MODEL, EXECUTION_COMPLETED, 100, 200);
    ExecutionStep first = step("t1", "root", "run", EXECUTION_KIND_TOOL, EXECUTION_RUNNING, 210, 0);
    assert(execution_timeline_upsert(&timeline, &model));
    assert(execution_timeline_upsert(&timeline, &first));
    first.status = EXECUTION_COMPLETED;
    first.completed_at_ms = 410;
    assert(execution_timeline_upsert(&timeline, &first));

    ExecutionStep second = step("t2", "root", "run", EXECUTION_KIND_TOOL, EXECUTION_RUNNING, 420, 0);
    ExecutionStep child = step("t3", "child-a", "child-run", EXECUTION_KIND_TOOL, EXECUTION_RUNNING, 430, 0);
    assert(execution_timeline_upsert(&timeline, &second));
    assert(execution_timeline_upsert(&timeline, &child));
    assert(timeline.count == 4);
    assert(execution_timeline_active_count(&timeline) == 2);
    assert(execution_step_elapsed_ms(&first, 9999) == 200);
    assert(timeline.steps[0].kind == EXECUTION_KIND_MODEL);
    assert(strcmp(timeline.steps[1].id, "t1") == 0);
    assert(execution_timeline_find(&timeline, EXECUTION_KIND_TOOL, "root", "run", "t2"));
    assert(execution_timeline_find(&timeline, EXECUTION_KIND_TOOL, "child-a", "child-run", "t3"));
}

static void test_overflow_only_summarizes_earliest_terminal(void) {
    ExecutionTimeline timeline;
    execution_timeline_init(&timeline);
    char id[16];
    for (int i = 0; i < MCU_EXECUTION_STEP_CAPACITY; i++) {
        snprintf(id, sizeof id, "done-%02d", i);
        ExecutionStep completed = step(id, "root", "run", EXECUTION_KIND_TOOL,
                                       EXECUTION_COMPLETED, i * 100, i * 100 + 50);
        assert(execution_timeline_upsert(&timeline, &completed));
    }
    ExecutionStep active_root = step("active-root", "root", "run", EXECUTION_KIND_TOOL,
                                     EXECUTION_RUNNING, 5000, 0);
    ExecutionStep active_child = step("active-child", "child", "child-run", EXECUTION_KIND_MODEL,
                                      EXECUTION_RUNNING, 5100, 0);
    assert(execution_timeline_upsert(&timeline, &active_root));
    assert(execution_timeline_upsert(&timeline, &active_child));
    assert(timeline.count == MCU_EXECUTION_STEP_CAPACITY);
    assert(timeline.earlier_completed_count == 2);
    assert(timeline.earlier_completed_elapsed_ms == 100);
    assert(!execution_timeline_find(&timeline, EXECUTION_KIND_TOOL, "root", "run", "done-00"));
    assert(!execution_timeline_find(&timeline, EXECUTION_KIND_TOOL, "root", "run", "done-01"));
    assert(execution_timeline_find(&timeline, EXECUTION_KIND_TOOL, "root", "run", "active-root"));
    assert(execution_timeline_find(&timeline, EXECUTION_KIND_MODEL, "child", "child-run", "active-child"));
    assert(execution_timeline_active_count(&timeline) == 2);
}

static void test_reconnect_snapshot_restores_timers_and_parallel_steps(void) {
    const char *json =
        "{\"kind\":\"response\",\"data\":{\"state\":{"
        "\"runs\":[{\"chatId\":\"root\",\"runId\":\"r1\",\"state\":\"running\",\"startedAt\":9000},"
        "{\"chatId\":\"child\",\"runId\":\"r2\",\"state\":\"running\",\"startedAt\":9200}],"
        "\"pendingInputs\":[{\"chatId\":\"root\",\"content\":\"恢复的问题\",\"acceptedAt\":8000}],"
        "\"executionSteps\":["
        "{\"id\":\"m1\",\"runId\":\"r1\",\"chatId\":\"root\",\"kind\":\"model\",\"name\":\"模型响应\",\"status\":\"completed\",\"startedAt\":9100,\"completedAt\":9300},"
        "{\"id\":\"t1\",\"runId\":\"r1\",\"chatId\":\"root\",\"kind\":\"tool\",\"name\":\"read_file\",\"status\":\"running\",\"startedAt\":9400},"
        "{\"id\":\"m2\",\"runId\":\"r2\",\"chatId\":\"child\",\"kind\":\"model\",\"name\":\"模型响应\",\"status\":\"running\",\"startedAt\":9500}]}}}";
    model_init();
    model_set_root("root");
    jl_doc doc = parse_json(json);
    jl_view data = jl_get(&doc, "data");
    jl_view state = jl_get_in(&doc, &data, "state");
    model_restore_execution_state(&doc, &state);
    model_on_server_now(10000, 2000);
    assert(model_run()->present);
    assert(model_run()->started_at_ms == 9000);
    assert(model_run_elapsed_ms(3000) == 2000); /* server now = 11000; never restarts at reconnect */
    assert(strcmp(model_question(), "恢复的问题") == 0);
    assert(model_execution_timeline()->count == 3);
    assert(execution_timeline_active_count(model_execution_timeline()) == 2);
}

static void test_live_protocol_order_and_tool_switch(void) {
    model_init();
    model_set_root("root");
    dispatch_notification("{\"kind\":\"notification\",\"type\":\"run.updated\",\"chatId\":\"root\",\"runId\":\"run\",\"data\":{\"status\":\"running\",\"at\":1000,\"startedAt\":1000}}");
    dispatch_notification("{\"kind\":\"notification\",\"type\":\"turn.started\",\"chatId\":\"root\",\"runId\":\"run\",\"data\":{\"turnId\":\"m1\",\"createdAt\":1100}}");
    dispatch_notification("{\"kind\":\"notification\",\"type\":\"turn.completed\",\"chatId\":\"root\",\"runId\":\"run\",\"data\":{\"turnId\":\"m1\",\"completedAt\":1200}}");
    dispatch_notification("{\"kind\":\"notification\",\"type\":\"sense_started\",\"chatId\":\"root\",\"runId\":\"run\",\"data\":{\"id\":\"t1\",\"senseName\":\"read_file\",\"startedAt\":1210}}");
    dispatch_notification("{\"kind\":\"notification\",\"type\":\"accept\",\"chatId\":\"root\",\"runId\":\"run\",\"data\":{\"approvalId\":\"t1\",\"senseName\":\"read_file\",\"ok\":true,\"completedAt\":1310}}");
    dispatch_notification("{\"kind\":\"notification\",\"type\":\"sense_started\",\"chatId\":\"child\",\"runId\":\"child-run\",\"data\":{\"id\":\"t2\",\"senseName\":\"bash\",\"startedAt\":1320}}");
    ExecutionTimeline *timeline = model_execution_timeline();
    assert(timeline->count == 3);
    assert(strcmp(timeline->steps[0].id, "m1") == 0);
    assert(strcmp(timeline->steps[1].id, "t1") == 0);
    assert(strcmp(timeline->steps[2].id, "t2") == 0);
    assert(timeline->steps[1].status == EXECUTION_COMPLETED);
    assert(timeline->steps[2].status == EXECUTION_RUNNING);
}

static void test_waiting_keeps_root_timer_active_until_terminal(void) {
    model_init();
    model_set_root("root");
    dispatch_notification("{\"kind\":\"notification\",\"type\":\"run.updated\",\"chatId\":\"root\",\"runId\":\"run\",\"data\":{\"status\":\"running\",\"at\":1000,\"startedAt\":1000}}");
    dispatch_notification("{\"kind\":\"notification\",\"type\":\"run.updated\",\"chatId\":\"root\",\"runId\":\"run\",\"data\":{\"status\":\"waiting\",\"at\":1200}}");
    assert(strcmp(model_run()->status, "waiting") == 0);
    assert(model_run()->started_at_ms == 1000);
    assert(model_run()->completed_at_ms == 0);
    assert(model_run_elapsed_ms(2000) == 1000);
    assert(model_execution_timeline()->count == 0); /* approval wait is not tool execution */

    dispatch_notification("{\"kind\":\"notification\",\"type\":\"run.updated\",\"chatId\":\"root\",\"runId\":\"run\",\"data\":{\"status\":\"completed\",\"at\":2200}}");
    assert(model_run()->completed_at_ms == 2200);
    assert(model_run_elapsed_ms(5000) == 1200); /* terminal status freezes the total */
}

static void test_node_ring_stays_sorted_and_preserves_latest_final(void) {
    model_init();
    model_set_root("root");
    for (int i = 1; i <= NODE_CACHE_SLOTS; i++) {
        lean_node node = {0};
        snprintf(node.id, sizeof node.id, "node-%02d", i);
        snprintf(node.summary, sizeof node.summary, "intermediate-%02d", i);
        snprintf(node.actor_kind, sizeof node.actor_kind, "%s", "agent");
        snprintf(node.direction, sizeof node.direction, "%s", "internal");
        node.order_key = i;
        model_upsert_node(&node);
    }

    lean_node final = {0};
    snprintf(final.id, sizeof final.id, "%s", "node-21");
    snprintf(final.summary, sizeof final.summary, "%s", "final-21");
    snprintf(final.actor_kind, sizeof final.actor_kind, "%s", "agent");
    snprintf(final.direction, sizeof final.direction, "%s", "agent-to-user");
    final.order_key = 21;
    model_upsert_node(&final);

    assert(model_node_count() == NODE_CACHE_SLOTS);
    const lean_node *nodes = model_nodes();
    for (int i = 1; i < model_node_count(); i++) {
        assert(nodes[i - 1].order_key < nodes[i].order_key);
    }
    assert(nodes[model_node_count() - 1].order_key == 21);
    assert(strcmp(model_final_summary(), "final-21") == 0);

    lean_node later_internal = {0};
    snprintf(later_internal.id, sizeof later_internal.id, "%s", "node-22");
    snprintf(later_internal.summary, sizeof later_internal.summary, "%s", "not-final");
    snprintf(later_internal.actor_kind, sizeof later_internal.actor_kind, "%s", "agent");
    snprintf(later_internal.direction, sizeof later_internal.direction, "%s", "internal");
    later_internal.order_key = 22;
    model_upsert_node(&later_internal);
    assert(strcmp(model_final_summary(), "final-21") == 0);
}

static void test_detail_pages_are_contiguous_and_single_page_only(void) {
    DetailPager pager;
    detail_pager_init(&pager);
    assert(detail_pager_begin(&pager, "node-1", DETAIL_CONTENT));
    detail_pager_request_started(&pager);
    const char first[] = "ab😀";
    detail_pager_apply(&pager, first, strlen(first), 4, true);
    assert(strcmp(pager.content, first) == 0);
    assert(pager.next_offset == 4);
    assert(detail_pager_next(&pager));
    assert(pager.offset == 4);
    detail_pager_request_started(&pager);
    const char second[] = "中z";
    detail_pager_apply(&pager, second, strlen(second), 2, false);
    assert(strcmp(pager.content, second) == 0);
    assert(strstr(pager.content, "ab") == NULL); /* 不累计前页 */
    assert(pager.next_offset == 6);
    assert(!pager.has_more);
    assert(detail_pager_previous(&pager));
    assert(pager.offset == 0);

    /* 超长详情连续六页：offset 无重复/缺段，驻留窗口始终只有当前 256 字符。 */
    assert(detail_pager_begin(&pager, "node-long", DETAIL_THINKING));
    char page[MCU_DETAIL_PAGE_CHARS + 1];
    for (uint32_t index = 0; index < 6; index++) {
        assert(pager.offset == index * MCU_DETAIL_PAGE_CHARS);
        memset(page, (int)('A' + index), MCU_DETAIL_PAGE_CHARS);
        page[MCU_DETAIL_PAGE_CHARS] = 0;
        detail_pager_request_started(&pager);
        detail_pager_apply(&pager, page, MCU_DETAIL_PAGE_CHARS,
                           MCU_DETAIL_PAGE_CHARS, index < 5);
        assert(pager.content_bytes == MCU_DETAIL_PAGE_CHARS);
        assert(pager.content[0] == (char)('A' + index));
        assert(pager.content[MCU_DETAIL_PAGE_CHARS - 1] == (char)('A' + index));
        if (index < 5) assert(detail_pager_next(&pager));
    }
    assert(pager.next_offset == 6 * MCU_DETAIL_PAGE_CHARS);
    /* 恰好整页时客户端防御性探测一页；空页才确认结束，offset 不跳跃。 */
    assert(pager.has_more);
    assert(detail_pager_next(&pager));
    assert(pager.offset == 6 * MCU_DETAIL_PAGE_CHARS);
    detail_pager_request_started(&pager);
    detail_pager_apply(&pager, "", 0, 0, false);
    assert(!pager.has_more);
}

int main(void) {
    test_json_unescape_and_frame_budget();
    test_websocket_text_binary_and_fragment_decoding();
    test_websocket_reconnect_releases_every_handle();
    test_sequential_and_parallel_steps();
    test_overflow_only_summarizes_earliest_terminal();
    test_reconnect_snapshot_restores_timers_and_parallel_steps();
    test_live_protocol_order_and_tool_switch();
    test_waiting_keeps_root_timer_active_until_terminal();
    test_node_ring_stays_sorted_and_preserves_latest_final();
    test_detail_pages_are_contiguous_and_single_page_only();
    puts("firmware host tests passed");
    return 0;
}
