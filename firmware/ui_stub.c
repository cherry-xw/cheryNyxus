/* ui_stub.c — 串口桩；真实硬件替换日志宏即可复用相同状态/按键语义。 */
#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#ifdef MCU_HOST_TEST
#include <time.h>
#define UI_INFO(...) do { printf(__VA_ARGS__); printf("\n"); } while (0)
#define UI_WARN(...) do { printf(__VA_ARGS__); printf("\n"); } while (0)
#else
#include "esp_timer.h"
#include "esp_log.h"
static const char *TAG = "ui";
#define UI_INFO(...) ESP_LOGI(TAG, __VA_ARGS__)
#define UI_WARN(...) ESP_LOGW(TAG, __VA_ARGS__)
#endif

#include "ui_stub.h"

static uint8_t s_inbox_dirty;
static uint64_t s_last_render_second = UINT64_MAX;
static detail_section_t s_selected_section = DETAIL_CONTENT;
static void (*s_on_decide)(const char *, int, bool);
static void (*s_on_send)(const char *);
static void (*s_on_detail)(detail_section_t, ui_page_action_t);

void ui_log(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vprintf(fmt, args);
    printf("\n");
    va_end(args);
}

uint64_t ui_now_ms(void) {
#ifdef MCU_HOST_TEST
    return (uint64_t)clock() * 1000ULL / (uint64_t)CLOCKS_PER_SEC;
#else
    return (uint64_t)esp_timer_get_time() / 1000ULL;
#endif
}

void ui_render_list(const lean_node *nodes, int count) {
    UI_INFO("== timeline (%d nodes, latest page) ==", count);
    int from = count > 6 ? count - 6 : 0;
    for (int i = from; i < count; i++) {
        UI_INFO("  [%s/%s] %s", nodes[i].actor_kind, nodes[i].direction, nodes[i].summary);
    }
}

static void render_duration(const char *prefix, uint64_t elapsed_ms) {
    UI_INFO("%s %" PRIu64 ".%01" PRIu64 "s", prefix,
            elapsed_ms / 1000ULL, (elapsed_ms % 1000ULL) / 100ULL);
}

void ui_render_execution(uint64_t local_ms) {
    run_row *run = model_run();
    ExecutionTimeline *timeline = model_execution_timeline();
    int64_t server_now = model_server_now((int64_t)local_ms);
    UI_INFO("== current question ==");
    UI_INFO("Q: %s", model_question()[0] ? model_question() : "(waiting for question)");
    if (run->present) {
        UI_INFO("root: %s", run->status[0] ? run->status : "idle");
        render_duration("total:", model_run_elapsed_ms((int64_t)local_ms));
    } else {
        UI_INFO("root: idle");
    }
    if (model_final_summary()[0]) UI_INFO("final: %s", model_final_summary());

    uint16_t active = execution_timeline_active_count(timeline);
    UI_INFO("active steps: %u", (unsigned)active);
    /* 活动节点置顶；并行节点全部同时显示并各算自己的时长。 */
    for (uint16_t i = 0; i < timeline->count; i++) {
        const ExecutionStep *step = &timeline->steps[i];
        if (step->status != EXECUTION_RUNNING) continue;
        UI_INFO("  > [%s] %s (%s)", execution_kind_name(step->kind), step->name, step->chat_id);
        render_duration("    running:", execution_step_elapsed_ms(step, server_now));
    }
    if (timeline->active_overflow_count > 0) {
        UI_WARN("  > additional active steps: %u (profile limit mismatch)",
                (unsigned)timeline->active_overflow_count);
    }

    if (timeline->earlier_completed_count > 0) {
        UI_INFO("  earlier steps %" PRIu32 " / cumulative %" PRIu64 ".%01" PRIu64 "s",
                timeline->earlier_completed_count,
                timeline->earlier_completed_elapsed_ms / 1000ULL,
                (timeline->earlier_completed_elapsed_ms % 1000ULL) / 100ULL);
    }
    /* 已完成节点以摘要行收起；仅显示窗口中最新四项，完整计数仍在固定模型内。 */
    int shown = 0;
    for (int i = (int)timeline->count - 1; i >= 0 && shown < 4; i--) {
        const ExecutionStep *step = &timeline->steps[i];
        if (step->status == EXECUTION_RUNNING) continue;
        UI_INFO("  + [%s] %s: %s, %" PRIu64 ".%01" PRIu64 "s",
                execution_kind_name(step->kind), step->name,
                execution_status_name(step->status),
                execution_step_elapsed_ms(step, server_now) / 1000ULL,
                (execution_step_elapsed_ms(step, server_now) % 1000ULL) / 100ULL);
        shown++;
    }
}

void ui_render_status(void) { ui_render_execution(ui_now_ms()); }
void ui_render_tool(const char *name) { UI_INFO("tool: %s", name); }
void ui_render_approval(const approval_slot *approval) {
    UI_WARN("APPROVAL %s (%s)", approval->sense_name, approval->interaction_id);
    UI_WARN("  args: %.360s", approval->arguments);
}

void ui_render_detail(const DetailPager *pager) {
    if (!pager) return;
    if (pager->in_flight) {
        UI_INFO("detail %s @%" PRIu32 ": loading...", detail_section_name(pager->section), pager->offset);
        return;
    }
    if (pager->failed) {
        UI_WARN("detail %s @%" PRIu32 ": load failed", detail_section_name(pager->section), pager->offset);
        return;
    }
    UI_INFO("== detail %s @%" PRIu32 " (%uB)%s ==", detail_section_name(pager->section),
            pager->offset, (unsigned)pager->content_bytes, pager->has_more ? " [more]" : "");
    UI_INFO("%s", pager->content);
}

void ui_tick(uint64_t local_ms) {
    uint64_t second = local_ms / 1000ULL;
    if (second == s_last_render_second) return;
    s_last_render_second = second;
    if ((model_run()->present &&
         (strcmp(model_run()->status, "running") == 0 ||
          strcmp(model_run()->status, "waiting") == 0)) ||
        execution_timeline_active_count(model_execution_timeline()) > 0) {
        ui_render_execution(local_ms);
    }
}

void ui_flag_inbox_refresh(void) { s_inbox_dirty = 1; }
uint8_t ui_inbox_dirty(void) { return s_inbox_dirty; }
void ui_inbox_clear_dirty(void) { s_inbox_dirty = 0; }

void ui_input_init(
    void (*on_decide)(const char *, int, bool),
    void (*on_send_text)(const char *),
    void (*on_detail)(detail_section_t, ui_page_action_t)
) {
    s_on_decide = on_decide;
    s_on_send = on_send_text;
    s_on_detail = on_detail;
    UI_INFO("input stub ready (content/thinking/tool detail + next/previous)");
}

void ui_input_dispatch(ui_key_t key) {
    if (!s_on_detail) return;
    switch (key) {
    case UI_KEY_DETAIL_CONTENT:
        s_selected_section = DETAIL_CONTENT;
        s_on_detail(s_selected_section, UI_PAGE_OPEN);
        break;
    case UI_KEY_DETAIL_THINKING:
        s_selected_section = DETAIL_THINKING;
        s_on_detail(s_selected_section, UI_PAGE_OPEN);
        break;
    case UI_KEY_DETAIL_TOOL:
        s_selected_section = DETAIL_TOOL_CALLS;
        s_on_detail(s_selected_section, UI_PAGE_OPEN);
        break;
    case UI_KEY_PAGE_NEXT:
        s_on_detail(s_selected_section, UI_PAGE_NEXT);
        break;
    case UI_KEY_PAGE_PREVIOUS:
        s_on_detail(s_selected_section, UI_PAGE_PREVIOUS);
        break;
    }
}
