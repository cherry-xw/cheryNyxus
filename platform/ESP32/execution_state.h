/* execution_state.h — 固定容量的模型/工具执行步骤窗口（零动态分配）。 */
#ifndef EXECUTION_STATE_H
#define EXECUTION_STATE_H

#include <stdbool.h>
#include <stdint.h>
#include "device_config.h"

#define EXECUTION_ID_BYTES 40
#define EXECUTION_NAME_BYTES 97 /* wire name 最多 96 UTF-8 bytes + NUL */

typedef enum {
    EXECUTION_KIND_MODEL,
    EXECUTION_KIND_TOOL,
} execution_kind_t;

typedef enum {
    EXECUTION_RUNNING,
    EXECUTION_COMPLETED,
    EXECUTION_FAILED,
    EXECUTION_REJECTED,
    EXECUTION_CANCELLED,
} execution_status_t;

typedef struct {
    char id[EXECUTION_ID_BYTES];
    char run_id[EXECUTION_ID_BYTES];
    char chat_id[EXECUTION_ID_BYTES];
    char name[EXECUTION_NAME_BYTES];
    execution_kind_t kind;
    execution_status_t status;
    int64_t started_at_ms;
    int64_t completed_at_ms;
} ExecutionStep;

typedef struct {
    /* Task 6 硬约束：默认恰为固定 16 项；可通过编译期宏生成其他设备镜像。 */
    ExecutionStep steps[MCU_EXECUTION_STEP_CAPACITY];
    uint16_t count;
    uint32_t earlier_completed_count;
    uint64_t earlier_completed_elapsed_ms;
    /* 防御计数：服务端 executionStepLimit 应保证它恒为 0。 */
    uint16_t active_overflow_count;
} ExecutionTimeline;

void execution_timeline_init(ExecutionTimeline *timeline);

/* id+runId+chatId+kind 唯一；更新已有步骤不占新槽。 */
bool execution_timeline_upsert(ExecutionTimeline *timeline, const ExecutionStep *step);

/* 以 run 终态封口所有仍 running 的步骤。 */
void execution_timeline_finish_run(
    ExecutionTimeline *timeline,
    const char *run_id,
    execution_status_t status,
    int64_t completed_at_ms
);

const ExecutionStep *execution_timeline_find(
    const ExecutionTimeline *timeline,
    execution_kind_t kind,
    const char *chat_id,
    const char *run_id,
    const char *id
);

uint16_t execution_timeline_active_count(const ExecutionTimeline *timeline);
uint64_t execution_step_elapsed_ms(const ExecutionStep *step, int64_t server_now_ms);

execution_kind_t execution_kind_parse(const char *value);
execution_status_t execution_status_parse(const char *value);
const char *execution_kind_name(execution_kind_t kind);
const char *execution_status_name(execution_status_t status);

#endif /* EXECUTION_STATE_H */
