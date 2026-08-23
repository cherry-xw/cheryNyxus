/* model.c — 会话模型实现。事件处理严格对应 mcu-lite-api.md §3.2 白名单矩阵。 */
#include <string.h>
#include <stdio.h>
#include "model.h"
#include "ui_stub.h"

static app_state_t s_state = ST_BOOT;
static lean_node s_nodes[NODE_CACHE_SLOTS];
static int s_node_count;
static approval_slot s_approvals[2];
static run_row s_run;
static child_row s_children[CHILD_ROWS];
static char s_root[ID_MAX];
static int64_t s_known_rev;
static int64_t s_clock_delta;      /* serverNow − 本地钟（ms） */
bool g_hydrated;

void model_init(void) {
    memset(s_nodes, 0, sizeof s_nodes);
    memset(s_approvals, 0, sizeof s_approvals);
    memset(&s_run, 0, sizeof s_run);
    memset(s_children, 0, sizeof s_children);
    s_node_count = 0; s_root[0] = 0; s_known_rev = 0; s_clock_delta = 0;
    g_hydrated = false;
}

app_state_t model_state(void) { return s_state; }
void model_set_state(app_state_t s) {
    if (s_state != s) { s_state = s; ui_log("state -> %d", (int)s); }
}

void model_on_server_now(int64_t server_now, int64_t local_ms) {
    s_clock_delta = server_now - local_ms;   /* §3.9：每轮至少一次免费校准 */
}
int64_t model_deadline_remaining(int64_t deadline_at, int64_t local_ms) {
    return deadline_at - (local_ms + s_clock_delta);
}

void model_set_root(const char *r) { strncpy(s_root, r, ID_MAX - 1); }
const char *model_root(void) { return s_root; }
int64_t model_known_revision(void) { return s_known_rev; }
void model_set_known_revision(int64_t rev) { s_known_rev = rev; }

/* ---- 节点缓存：orderKey 排序插入 upsert（同 id 去重——F2：done 与 patch 同源同 id） ---- */
void model_upsert_node(const lean_node *n) {
    int idx = -1;
    for (int i = 0; i < s_node_count; i++)
        if (strcmp(s_nodes[i].id, n->id) == 0) { idx = i; break; }
    if (idx < 0) {
        if (s_node_count == NODE_CACHE_SLOTS) {
            /* 环形淘汰：丢 orderKey 最小（最旧）——OLED 只显最近 20 条，符合 §1.2 首刷页语义 */
            int oldest = 0;
            for (int i = 1; i < s_node_count; i++)
                if (s_nodes[i].order_key < s_nodes[oldest].order_key) oldest = i;
            idx = oldest;
        } else idx = s_node_count++;
    }
    s_nodes[idx] = *n;
    /* 插入排序维持 orderKey 有序（20 槽，开销可忽略） */
    for (int i = idx; i > 0 && s_nodes[i - 1].order_key > s_nodes[i].order_key; i--) {
        lean_node t = s_nodes[i]; s_nodes[i] = s_nodes[i - 1]; s_nodes[i - 1] = t;
    }
    ui_render_list(s_nodes, s_node_count);
}
const lean_node *model_nodes(void) { return s_nodes; }
int model_node_count(void) { return s_node_count; }

approval_slot *model_approval_alloc(void) {
    for (int i = 0; i < 2; i++)
        if (!s_approvals[i].active) { memset(&s_approvals[i], 0, sizeof(approval_slot)); return &s_approvals[i]; }
    return NULL;   /* 2 槽满：极罕见（审批串行）；交互题不在本参考固件范围 */
}
void model_approval_clear(const char *iid) {
    for (int i = 0; i < 2; i++)
        if (s_approvals[i].active && strcmp(s_approvals[i].interaction_id, iid) == 0)
            s_approvals[i].active = false;
}

run_row *model_run(void) { return &s_run; }
child_row *model_child_row(int i) { return (i >= 0 && i < CHILD_ROWS) ? &s_children[i] : NULL; }

/* ---- 白名单三分类（§3.2 矩阵；抑制=不在此表+显式名单双保险） ---- */
static const char *SUPPRESSED[] = {
    "turn.delta", "loaded", "replaced", "role_reply", NULL,
};

bool model_is_whitelisted(const jl_view *type) {
    if (!type->found) return false;
    for (const char **s = SUPPRESSED; *s; s++)
        if (jl_streq(type, *s)) return false;   /* 契约已抑制；收到即计数即可 */
    return true;   /* 其余已知类型按矩阵处理；未知类型（v1 冻结防御）由调用方 unknown 处理 */
}

static bool is_root_chat(const jl_doc *doc) {
    jl_view cid = jl_get(doc, "chatId");
    return !cid.found || strcmp(s_root, "") == 0 || jl_streq(&cid, s_root);
}

/* 单个 lean 节点视图 → 驻留结构（timeline.get/open 响应与 patch upsert 共用） */
void model_store_lean_node(const jl_doc *doc, const jl_view *node_view) {
    lean_node n = {0};
    jl_view v;
    v = jl_get_in(doc, node_view, "id");           jl_copy(&v, n.id, ID_MAX);
    v = jl_get_in(doc, node_view, "kind");         jl_copy(&v, n.kind, sizeof n.kind);
    v = jl_get_in(doc, node_view, "actorKind");    jl_copy(&v, n.actor_kind, sizeof n.actor_kind);
    v = jl_get_in(doc, node_view, "actorRoleType");jl_copy(&v, n.actor_role_type, sizeof n.actor_role_type);
    v = jl_get_in(doc, node_view, "direction");    jl_copy(&v, n.direction, sizeof n.direction);
    v = jl_get_in(doc, node_view, "orderKey");     n.order_key = jl_i64(&v, 0);
    v = jl_get_in(doc, node_view, "status");       jl_copy(&v, n.status, sizeof n.status);
    v = jl_get_in(doc, node_view, "createdAt");    n.created_at = jl_i64(&v, 0);
    v = jl_get_in(doc, node_view, "summary");      jl_copy(&v, n.summary, SUMMARY_MAX);
    v = jl_get_in(doc, node_view, "contentLength");n.content_length = jl_int(&v, 0);
    if (n.id[0]) model_upsert_node(&n);
}

/* ---- 通知处理（§3.2 矩阵的「精简/透传」列） ---- */
void model_on_notification(jl_doc *doc) {
    jl_view type = jl_get(doc, "type");
    jl_view data = jl_get(doc, "data");
    if (!type.found) return;

    if (jl_streq(&type, "run.updated")) {
        /* 工作态唯一权威：仅 root 维度驱动主状态行（B-1/§7.6） */
        if (is_root_chat(doc) && data.found) {
            jl_view rid = jl_get_in(doc, &data, "runId");
            jl_view st = jl_get_in(doc, &data, "status");
            jl_copy(&rid, s_run.run_id, ID_MAX);
            jl_copy(&st, s_run.status, sizeof s_run.status);
            s_run.present = true;
            ui_render_status();
        } else {
            /* 子 run.updated：折叠进子任务行 */
            child_row *c = model_child_row(0);
            if (c) { jl_view cid = jl_get(doc, "chatId"); jl_copy(&cid, c->chat_id, ID_MAX); snprintf(c->state, sizeof c->state, "sub-run"); }
        }
    } else if (jl_streq(&type, "turn.started")) {
        if (is_root_chat(doc) && data.found) {
            jl_view t = jl_get_in(doc, &data, "createdAt");
            s_run.started_at_ms = jl_i64(&t, 0);
        } else {
            child_row *c = model_child_row(0);
            if (c) snprintf(c->state, sizeof c->state, "running");   /* 子 turn 折叠（B-1 规则2） */
        }
    } else if (jl_streq(&type, "turn.completed")) {
        if (!is_root_chat(doc)) {
            child_row *c = model_child_row(0);
            if (c) snprintf(c->state, sizeof c->state, "done");
        }
    } else if (jl_streq(&type, "done")) {
        if (!is_root_chat(doc)) return;   /* 子 done 一律忽略（B-1 规则1：只认 root 维度 done） */
        if (!data.found) return;
        /* B-9 负向语义①：done 不必有 finalMessage——无则只更新状态 */
        jl_view fm = jl_get_in(doc, &data, "finalMessage");
        if (fm.found) {
            lean_node n = {0};
            jl_view v = jl_get_in(doc, &fm, "msgId"); jl_copy(&v, n.id, ID_MAX);
            v = jl_get_in(doc, &fm, "content");       jl_copy(&v, n.summary, SUMMARY_MAX);
            snprintf(n.kind, sizeof n.kind, "message");
            snprintf(n.actor_kind, sizeof n.actor_kind, "agent");
            snprintf(n.direction, sizeof n.direction, "agent-to-user");
            n.created_at = 0; n.order_key = s_node_count ? s_nodes[s_node_count - 1].order_key + 1 : 1;
            if (n.id[0]) model_upsert_node(&n);   /* 与 patch 同 id upsert 去重（F2） */
        }
        jl_view sn = jl_get_in(doc, &data, "serverNow");
        if (sn.found) model_on_server_now(jl_i64(&sn, 0), ui_now_ms());
        s_run.present = false;
        ui_render_status();
    } else if (jl_streq(&type, "error")) {
        /* F11/D-a：message 原样显示（含 [tracingId] 前缀不截）；本参考固件日志输出 */
        if (data.found) {
            jl_view m = jl_get_in(doc, &data, "message");
            char buf[160]; jl_copy(&m, buf, sizeof buf);
            ui_log("error: %s", buf);
        }
    } else if (jl_streq(&type, "interrupt")) {
        /* G4 审批全量（有界）：interactionId 级交互经收件箱；interrupt 携带 arguments 决策主显。
         * 倒计时统一 deadlineAt（投影已剔 waitTime/createdAt，C5）——事件不含 deadlineAt，
         * 由 interaction.list 到达（hydration/防抖重拉）填入审批槽。此处先登记展示。 */
        approval_slot *a = model_approval_alloc();
        if (a && data.found) {
            jl_view v = jl_get_in(doc, &data, "approvalId"); jl_copy(&v, a->interaction_id, ID_MAX);
            v = jl_get_in(doc, &data, "senseName");          jl_copy(&v, a->sense_name, sizeof a->sense_name);
            v = jl_get_in(doc, &data, "arguments");          jl_copy(&v, a->arguments, sizeof a->arguments);
            a->active = true;
            ui_render_approval(a);
        }
    } else if (jl_streq(&type, "accept") || jl_streq(&type, "rejected")) {
        if (data.found) {
            jl_view id = jl_get_in(doc, &data, "approvalId");
            char iid[ID_MAX]; jl_copy(&id, iid, ID_MAX);
            model_approval_clear(iid);
            ui_render_status();
        }
    } else if (jl_streq(&type, "sense_started")) {
        if (data.found) {
            jl_view nm = jl_get_in(doc, &data, "senseName");
            char buf[24]; jl_copy(&nm, buf, sizeof buf);
            ui_render_tool(buf);
        }
    } else if (jl_streq(&type, "timeline.patch")) {
        /* upsert 节点 → lean 驻留；revision 推进 */
        if (data.found) {
            jl_view rev = jl_get_in(doc, &data, "revision");
            if (rev.found) model_set_known_revision(jl_i64(&rev, 0));
            jl_view root_patch = jl_get_in(doc, &data, "rootPatch");
            jl_view ops_src = root_patch.found ? jl_get_in(doc, &root_patch, "operations") : (jl_view){0};
            if (ops_src.found) {
                int n = jl_array_len(doc, &ops_src);
                for (int i = 0; i < n; i++) {
                    jl_view op = jl_array_at(doc, &ops_src, i);
                    jl_view nodes = jl_get_in(doc, &op, "nodes");
                    if (!nodes.found) nodes = jl_get_in(doc, &op, "node");
                    if (nodes.found) {
                        if (nodes.ptr[0] == '[') {
                            int m = jl_array_len(doc, &nodes);
                            for (int j = 0; j < m; j++) {
                                jl_view nv = jl_array_at(doc, &nodes, j);
                                model_store_lean_node(doc, &nv);
                            }
                        } else model_store_lean_node(doc, &nodes);
                    }
                }
            }
        }
    } else if (jl_streq(&type, "interaction.changed")) {
        /* 无 seq 不进事件流（C5）：500ms 防抖后重拉 interaction.list——main.c 定时器处理 */
        ui_flag_inbox_refresh();
    }
    /* 其余白名单事件（input.updated/consumed/role_created/role_destroyed/child_abandoned/
     * auto_compacted/question_batch_*）：参考固件按 unknown-lite 日志级处理或后续扩展。 */
}
