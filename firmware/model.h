/* model.h — 会话模型与核心状态机（lite profile 客户端投影）
 *
 * 依据：mcu-lite-api.md §3.2（白名单三分类）、§3.6（hydration/重连判定）、§3.9（时钟/倒计时）。
 * 内存：全静态（C3 档零 malloc 解析路径）。
 *   - LeanTimelineNode 环形缓存 20 槽（≈7.6KB）
 *   - pending 审批/提问各 2 槽
 *   - run 状态行（root）+ 子任务状态行 ×2（B-1 折叠规则）
 */
#ifndef MODEL_H
#define MODEL_H

#include <stdint.h>
#include <stdbool.h>
#include "json_lite.h"

#define NODE_CACHE_SLOTS   20
#define SUMMARY_MAX        192      /* 服务端截断 ≤180B + 终止符余量（D5 字节定义） */
#define ID_MAX             40
#define CHILD_ROWS         2

/* ---- LeanTimelineNode（canonical-timeline §3.6.2，字段名严格一致）---- */
typedef struct {
    char id[ID_MAX];
    char kind[10];         /* message|return|dispatch|system */
    char actor_kind[8];    /* user|agent|system */
    char actor_role_type[16];
    char direction[20];    /* user-to-agent|agent-to-user|parent-to-child|child-to-parent|internal */
    int64_t order_key;
    char status[12];       /* committed|revoked */
    int64_t created_at;
    char summary[SUMMARY_MAX];
    int content_length;
    /* toolNames 数组不驻留（显示时从事件响应取或忽略——参考固件仅日志） */
} lean_node;

/* ---- pending 审批（interactions 契约字段）---- */
typedef struct {
    char interaction_id[ID_MAX];
    char sense_name[24];
    char arguments[384];   /* truncations 截断后驻留头段（决策主显） */
    int revision;
    int64_t deadline_at;   /* 0=无倒计时；remaining = deadline_at − (now+Δ) */
    bool active;
} approval_slot;

typedef enum {
    ST_BOOT, ST_WIFI, ST_CONFIG, ST_WS_CONNECTING, ST_HYDRATING, ST_READY,
    ST_RECONNECT_WAIT, ST_FATAL_VERSION,
} app_state_t;

/* run 工作态（唯一权威=chatId==rootChatId 的 run.updated，§7.6/B-1） */
typedef struct {
    char run_id[ID_MAX];
    char status[12];       /* running|waiting|paused|completed|failed */
    int64_t started_at_ms; /* turn.started.createdAt（时长显示） */
    bool present;
} run_row;

/* 子任务状态行（子 turn/run/interrupt 折叠，B-1 规则） */
typedef struct {
    char chat_id[ID_MAX];
    char label[32];        /* 角色名或 chatId 短显 */
    char state[24];        /* running|done|failed|ghost */
} child_row;

void model_init(void);

/* 状态机查询/迁移 */
app_state_t model_state(void);
void model_set_state(app_state_t s);

/* 时钟：Δ = serverNow − 本地收包时刻（§3.9 B-3：interaction.list 响应 + done 两到达点） */
void model_on_server_now(int64_t server_now, int64_t local_ms);
int64_t model_deadline_remaining(int64_t deadline_at, int64_t local_ms);

/* 会话与游标 */
void model_set_root(const char *root_chat_id);
const char *model_root(void);
int64_t model_known_revision(void);
void model_set_known_revision(int64_t rev);

/* 节点缓存：orderKey upsert 去重（done.finalMessage 与 patch 同 id 天然去重，F2） */
void model_upsert_node(const lean_node *n);
const lean_node *model_nodes(void);       /* orderKey 有序视图（缓存内） */
int model_node_count(void);

/* 审批槽 */
approval_slot *model_approval_alloc(void);
void model_approval_clear(const char *interaction_id);

/* run/子行 */
run_row *model_run(void);
child_row *model_child_row(int i);

/* 事件入口（main.c 的白名单分发调用；实现 §3.2 三分类的「精简/透传」处理） */
void model_on_notification(jl_doc *doc);      /* 白名单命中后调用 */
bool model_is_whitelisted(const jl_view *type); /* 三分类判定（抑制名单在此） */

/* hydration 状态 */
extern bool g_hydrated;   /* chat.open+interaction.list 完成 */

#endif
