/* execution_state.c — 固定数组、最早终态汇总、活动步骤优先保留。 */
#include <stddef.h>
#include <string.h>
#include "execution_state.h"

static bool same_step(const ExecutionStep *a, const ExecutionStep *b) {
    return a->kind == b->kind &&
           strcmp(a->id, b->id) == 0 &&
           strcmp(a->run_id, b->run_id) == 0 &&
           strcmp(a->chat_id, b->chat_id) == 0;
}

static bool is_terminal(const ExecutionStep *step) {
    return step->status != EXECUTION_RUNNING;
}

static uint64_t terminal_elapsed(const ExecutionStep *step) {
    if (step->completed_at_ms <= step->started_at_ms) return 0;
    return (uint64_t)(step->completed_at_ms - step->started_at_ms);
}

static void summarize_terminal(ExecutionTimeline *timeline, const ExecutionStep *step) {
    if (!is_terminal(step)) return;
    timeline->earlier_completed_count++;
    timeline->earlier_completed_elapsed_ms += terminal_elapsed(step);
}

static int oldest_terminal_index(const ExecutionTimeline *timeline) {
    int oldest = -1;
    for (uint16_t i = 0; i < timeline->count; i++) {
        const ExecutionStep *candidate = &timeline->steps[i];
        if (!is_terminal(candidate)) continue;
        if (oldest < 0 || candidate->started_at_ms < timeline->steps[oldest].started_at_ms ||
            (candidate->started_at_ms == timeline->steps[oldest].started_at_ms &&
             candidate->completed_at_ms < timeline->steps[oldest].completed_at_ms)) {
            oldest = (int)i;
        }
    }
    return oldest;
}

static void remove_at(ExecutionTimeline *timeline, uint16_t index) {
    if (index >= timeline->count) return;
    if (index + 1 < timeline->count) {
        memmove(
            &timeline->steps[index],
            &timeline->steps[index + 1],
            (size_t)(timeline->count - index - 1) * sizeof(ExecutionStep)
        );
    }
    timeline->count--;
}

static void sort_chronological(ExecutionTimeline *timeline) {
    for (uint16_t i = 1; i < timeline->count; i++) {
        ExecutionStep current = timeline->steps[i];
        uint16_t j = i;
        while (j > 0) {
            const ExecutionStep *previous = &timeline->steps[j - 1];
            bool after = previous->started_at_ms > current.started_at_ms ||
                         (previous->started_at_ms == current.started_at_ms &&
                          strcmp(previous->id, current.id) > 0);
            if (!after) break;
            timeline->steps[j] = timeline->steps[j - 1];
            j--;
        }
        timeline->steps[j] = current;
    }
}

void execution_timeline_init(ExecutionTimeline *timeline) {
    if (timeline) memset(timeline, 0, sizeof *timeline);
}

bool execution_timeline_upsert(ExecutionTimeline *timeline, const ExecutionStep *step) {
    if (!timeline || !step || !step->id[0] || !step->run_id[0]) return false;

    for (uint16_t i = 0; i < timeline->count; i++) {
        if (same_step(&timeline->steps[i], step)) {
            timeline->steps[i] = *step;
            sort_chronological(timeline);
            return true;
        }
    }

    if (timeline->count == MCU_EXECUTION_STEP_CAPACITY) {
        int oldest = oldest_terminal_index(timeline);
        if (oldest >= 0) {
            summarize_terminal(timeline, &timeline->steps[oldest]);
            remove_at(timeline, (uint16_t)oldest);
        } else if (is_terminal(step)) {
            /* 全槽均活动时，新的零时长拒绝/终态直接进入完成汇总，不挤掉活动项。 */
            summarize_terminal(timeline, step);
            return true;
        } else {
            /* 正常不会发生：chat.open.executionStepLimit 与本数组容量一致。 */
            timeline->active_overflow_count++;
            return false;
        }
    }

    timeline->steps[timeline->count++] = *step;
    sort_chronological(timeline);
    return true;
}

void execution_timeline_finish_run(
    ExecutionTimeline *timeline,
    const char *run_id,
    execution_status_t status,
    int64_t completed_at_ms
) {
    if (!timeline || !run_id) return;
    for (uint16_t i = 0; i < timeline->count; i++) {
        ExecutionStep *step = &timeline->steps[i];
        if (step->status != EXECUTION_RUNNING || strcmp(step->run_id, run_id) != 0) continue;
        step->status = status;
        step->completed_at_ms = completed_at_ms;
    }
}

const ExecutionStep *execution_timeline_find(
    const ExecutionTimeline *timeline,
    execution_kind_t kind,
    const char *chat_id,
    const char *run_id,
    const char *id
) {
    if (!timeline || !chat_id || !run_id || !id) return NULL;
    for (uint16_t i = 0; i < timeline->count; i++) {
        const ExecutionStep *step = &timeline->steps[i];
        if (step->kind == kind && strcmp(step->chat_id, chat_id) == 0 &&
            strcmp(step->run_id, run_id) == 0 && strcmp(step->id, id) == 0) {
            return step;
        }
    }
    return NULL;
}

uint16_t execution_timeline_active_count(const ExecutionTimeline *timeline) {
    uint16_t count = timeline ? timeline->active_overflow_count : 0;
    if (!timeline) return count;
    for (uint16_t i = 0; i < timeline->count; i++) {
        if (timeline->steps[i].status == EXECUTION_RUNNING) count++;
    }
    return count;
}

uint64_t execution_step_elapsed_ms(const ExecutionStep *step, int64_t server_now_ms) {
    if (!step || step->started_at_ms <= 0) return 0;
    int64_t end = step->status == EXECUTION_RUNNING ? server_now_ms : step->completed_at_ms;
    if (end <= step->started_at_ms) return 0;
    return (uint64_t)(end - step->started_at_ms);
}

execution_kind_t execution_kind_parse(const char *value) {
    return value && strcmp(value, "tool") == 0 ? EXECUTION_KIND_TOOL : EXECUTION_KIND_MODEL;
}

execution_status_t execution_status_parse(const char *value) {
    if (!value) return EXECUTION_RUNNING;
    if (strcmp(value, "completed") == 0) return EXECUTION_COMPLETED;
    if (strcmp(value, "failed") == 0) return EXECUTION_FAILED;
    if (strcmp(value, "rejected") == 0) return EXECUTION_REJECTED;
    if (strcmp(value, "cancelled") == 0 || strcmp(value, "paused") == 0) return EXECUTION_CANCELLED;
    return EXECUTION_RUNNING;
}

const char *execution_kind_name(execution_kind_t kind) {
    return kind == EXECUTION_KIND_TOOL ? "tool" : "model";
}

const char *execution_status_name(execution_status_t status) {
    switch (status) {
    case EXECUTION_COMPLETED: return "completed";
    case EXECUTION_FAILED: return "failed";
    case EXECUTION_REJECTED: return "rejected";
    case EXECUTION_CANCELLED: return "cancelled";
    case EXECUTION_RUNNING:
    default: return "running";
    }
}
