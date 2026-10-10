/* model.c — 会话模型、固定容量执行窗口与 lite 通知解码。 */
#include <stdio.h>
#include <string.h>
#include "model.h"
#include "ui_stub.h"

static app_state_t s_state = ST_BOOT;
static lean_node s_nodes[NODE_CACHE_SLOTS];
static int s_node_count;
static approval_slot s_approvals[2];
static run_row s_run;
static child_row s_children[CHILD_ROWS];
static ExecutionTimeline s_execution;
static char s_root[ID_MAX];
static char s_question[MCU_QUESTION_BYTES];
static char s_final_summary[SUMMARY_MAX];
static char s_detail_node_id[ID_MAX];
static char s_tool_detail_node_id[ID_MAX];
static int64_t s_question_order;
static int64_t s_final_order;
static int64_t s_detail_order;
static int64_t s_tool_detail_order;
static int64_t s_known_rev;
static int64_t s_clock_delta;
bool g_hydrated;

static void copy_cstr(char *dst, size_t size, const char *src) {
    if (!dst || size == 0) return;
    if (!src) { dst[0] = 0; return; }
    size_t length = 0;
    while (length < size - 1 && src[length] != '\0') length++;
    if (length > 0) memcpy(dst, src, length);
    dst[length] = '\0';
}

void model_init(void) {
    s_state = ST_BOOT;
    memset(s_nodes, 0, sizeof s_nodes);
    memset(s_approvals, 0, sizeof s_approvals);
    memset(&s_run, 0, sizeof s_run);
    memset(s_children, 0, sizeof s_children);
    execution_timeline_init(&s_execution);
    s_node_count = 0;
    s_root[0] = 0;
    s_question[0] = 0;
    s_final_summary[0] = 0;
    s_detail_node_id[0] = 0;
    s_tool_detail_node_id[0] = 0;
    s_question_order = s_final_order = s_detail_order = s_tool_detail_order = 0;
    s_known_rev = 0;
    s_clock_delta = 0;
    g_hydrated = false;
}

app_state_t model_state(void) { return s_state; }
void model_set_state(app_state_t state) {
    if (s_state != state) { s_state = state; ui_log("state -> %d", (int)state); }
}

void model_on_server_now(int64_t server_now, int64_t local_ms) {
    s_clock_delta = server_now - local_ms;
}
int64_t model_server_now(int64_t local_ms) { return local_ms + s_clock_delta; }
int64_t model_deadline_remaining(int64_t deadline_at, int64_t local_ms) {
    return deadline_at - model_server_now(local_ms);
}
uint64_t model_run_elapsed_ms(int64_t local_ms) {
    if (!s_run.present || s_run.started_at_ms <= 0) return 0;
    bool active = strcmp(s_run.status, "running") == 0 || strcmp(s_run.status, "waiting") == 0;
    int64_t end = active
        ? model_server_now(local_ms)
        : s_run.completed_at_ms;
    if (end <= s_run.started_at_ms) return 0;
    return (uint64_t)(end - s_run.started_at_ms);
}

void model_set_root(const char *root) {
    if (!root) return;
    if (s_root[0] && strcmp(s_root, root) != 0) {
        s_node_count = 0;
        s_known_rev = 0;
        s_question[0] = 0;
        s_final_summary[0] = 0;
        s_detail_node_id[0] = 0;
        s_tool_detail_node_id[0] = 0;
        s_question_order = s_final_order = s_detail_order = s_tool_detail_order = 0;
        memset(&s_run, 0, sizeof s_run);
        execution_timeline_init(&s_execution);
    }
    copy_cstr(s_root, sizeof s_root, root);
}
const char *model_root(void) { return s_root; }
int64_t model_known_revision(void) { return s_known_rev; }
void model_set_known_revision(int64_t revision) { s_known_rev = revision; }
void model_set_question(const char *question) { copy_cstr(s_question, sizeof s_question, question); }
const char *model_question(void) { return s_question; }
const char *model_final_summary(void) { return s_final_summary; }
const char *model_detail_node_id(bool prefer_tool_calls) {
    if (prefer_tool_calls && s_tool_detail_node_id[0]) return s_tool_detail_node_id;
    return s_detail_node_id;
}

void model_upsert_node(const lean_node *node) {
    int index = -1;
    for (int i = 0; i < s_node_count; i++) {
        if (strcmp(s_nodes[i].id, node->id) == 0) { index = i; break; }
    }
    if (index < 0) {
        if (s_node_count == NODE_CACHE_SLOTS) {
            int oldest = 0;
            for (int i = 1; i < s_node_count; i++) {
                if (s_nodes[i].order_key < s_nodes[oldest].order_key) oldest = i;
            }
            index = oldest;
        } else {
            index = s_node_count++;
        }
    }
    s_nodes[index] = *node;
    /* Existing nodes can move in either direction, and a full cache overwrites index 0.
     * Re-sort all 20 fixed slots so the newest node always remains at the end. */
    for (int i = 1; i < s_node_count; i++) {
        lean_node current = s_nodes[i];
        int j = i;
        while (j > 0 && s_nodes[j - 1].order_key > current.order_key) {
            s_nodes[j] = s_nodes[j - 1];
            j--;
        }
        s_nodes[j] = current;
    }
    if (strcmp(node->actor_kind, "user") == 0 && node->order_key >= s_question_order) {
        copy_cstr(s_question, sizeof s_question, node->summary);
        s_question_order = node->order_key;
    }
    if (strcmp(node->actor_kind, "agent") == 0 &&
        strcmp(node->direction, "agent-to-user") == 0 &&
        node->order_key >= s_final_order) {
        copy_cstr(s_final_summary, sizeof s_final_summary, node->summary);
        s_final_order = node->order_key;
    }
    if (strcmp(node->actor_kind, "agent") == 0 && node->order_key >= s_detail_order) {
        copy_cstr(s_detail_node_id, sizeof s_detail_node_id, node->id);
        s_detail_order = node->order_key;
    }
    if (node->has_tool_calls && node->order_key >= s_tool_detail_order) {
        copy_cstr(s_tool_detail_node_id, sizeof s_tool_detail_node_id, node->id);
        s_tool_detail_order = node->order_key;
    }
    ui_render_list(s_nodes, s_node_count);
}
const lean_node *model_nodes(void) { return s_nodes; }
int model_node_count(void) { return s_node_count; }

approval_slot *model_approval_alloc(void) {
    for (int i = 0; i < 2; i++) {
        if (!s_approvals[i].active) {
            memset(&s_approvals[i], 0, sizeof(approval_slot));
            return &s_approvals[i];
        }
    }
    return NULL;
}
void model_approval_clear(const char *interaction_id) {
    for (int i = 0; i < 2; i++) {
        if (s_approvals[i].active && strcmp(s_approvals[i].interaction_id, interaction_id) == 0) {
            s_approvals[i].active = false;
        }
    }
}
run_row *model_run(void) { return &s_run; }
child_row *model_child_row(int i) { return (i >= 0 && i < CHILD_ROWS) ? &s_children[i] : NULL; }
ExecutionTimeline *model_execution_timeline(void) { return &s_execution; }

static const char *SUPPRESSED[] = {
    "turn.delta", "loaded", "replaced", "role_reply", NULL,
};
bool model_is_whitelisted(const jl_view *type) {
    if (!type->found) return false;
    for (const char **suppressed = SUPPRESSED; *suppressed; suppressed++) {
        if (jl_streq(type, *suppressed)) return false;
    }
    return true;
}
static bool is_root_chat(const jl_doc *doc) {
    jl_view chat_id = jl_get(doc, "chatId");
    return !chat_id.found || !s_root[0] || jl_streq(&chat_id, s_root);
}
static void event_identity(
    const jl_doc *doc,
    const jl_view *data,
    char chat_id[ID_MAX],
    char run_id[ID_MAX]
) {
    jl_view view = jl_get(doc, "chatId");
    jl_copy(&view, chat_id, ID_MAX);
    view = jl_get(doc, "runId");
    jl_copy(&view, run_id, ID_MAX);
    if (!run_id[0] && data && data->found) {
        view = jl_get_in(doc, data, "runId");
        jl_copy(&view, run_id, ID_MAX);
    }
}

void model_store_lean_node(const jl_doc *doc, const jl_view *node_view) {
    lean_node node = {0};
    jl_view view;
    view = jl_get_in(doc, node_view, "id");            jl_copy(&view, node.id, ID_MAX);
    view = jl_get_in(doc, node_view, "kind");          jl_copy(&view, node.kind, sizeof node.kind);
    view = jl_get_in(doc, node_view, "actorKind");     jl_copy(&view, node.actor_kind, sizeof node.actor_kind);
    view = jl_get_in(doc, node_view, "actorRoleType"); jl_copy(&view, node.actor_role_type, sizeof node.actor_role_type);
    view = jl_get_in(doc, node_view, "direction");     jl_copy(&view, node.direction, sizeof node.direction);
    view = jl_get_in(doc, node_view, "orderKey");      node.order_key = jl_i64(&view, 0);
    view = jl_get_in(doc, node_view, "status");        jl_copy(&view, node.status, sizeof node.status);
    view = jl_get_in(doc, node_view, "createdAt");     node.created_at = jl_i64(&view, 0);
    view = jl_get_in(doc, node_view, "summary");       jl_copy_unescaped(&view, node.summary, SUMMARY_MAX);
    view = jl_get_in(doc, node_view, "contentLength"); node.content_length = jl_int(&view, 0);
    view = jl_get_in(doc, node_view, "toolNames");     node.has_tool_calls = jl_array_len(doc, &view) > 0;
    if (node.id[0]) model_upsert_node(&node);
}

static void parse_execution_step(const jl_doc *doc, const jl_view *view, ExecutionStep *step) {
    char kind[12] = {0};
    char status[16] = {0};
    jl_view field = jl_get_in(doc, view, "id");          jl_copy(&field, step->id, sizeof step->id);
    field = jl_get_in(doc, view, "runId");               jl_copy(&field, step->run_id, sizeof step->run_id);
    field = jl_get_in(doc, view, "chatId");              jl_copy(&field, step->chat_id, sizeof step->chat_id);
    field = jl_get_in(doc, view, "kind");                jl_copy(&field, kind, sizeof kind);
    field = jl_get_in(doc, view, "name");                jl_copy_unescaped(&field, step->name, sizeof step->name);
    field = jl_get_in(doc, view, "status");              jl_copy(&field, status, sizeof status);
    field = jl_get_in(doc, view, "startedAt");           step->started_at_ms = jl_i64(&field, 0);
    field = jl_get_in(doc, view, "completedAt");         step->completed_at_ms = jl_i64(&field, 0);
    step->kind = execution_kind_parse(kind);
    step->status = execution_status_parse(status);
}
static bool restore_run_view(const jl_doc *doc, const jl_view *view, bool require_root_chat) {
    if (!view->found) return false;
    if (require_root_chat) {
        jl_view chat = jl_get_in(doc, view, "chatId");
        if (chat.found && s_root[0] && !jl_streq(&chat, s_root)) return false;
    }
    jl_view field = jl_get_in(doc, view, "runId");
    jl_copy(&field, s_run.run_id, sizeof s_run.run_id);
    field = jl_get_in(doc, view, "state");
    jl_copy(&field, s_run.status, sizeof s_run.status);
    field = jl_get_in(doc, view, "startedAt");
    s_run.started_at_ms = jl_i64(&field, 0);
    s_run.completed_at_ms = 0;
    s_run.present = s_run.run_id[0] != 0;
    return s_run.present;
}
void model_restore_execution_state(const jl_doc *doc, const jl_view *state_view) {
    if (!doc || !state_view || !state_view->found) return;
    execution_timeline_init(&s_execution);
    memset(&s_run, 0, sizeof s_run);
    jl_view run = jl_get_in(doc, state_view, "run");
    bool restored_run = restore_run_view(doc, &run, false);
    if (!restored_run) {
        jl_view runs = jl_get_in(doc, state_view, "runs");
        int count = jl_array_len(doc, &runs);
        for (int i = 0; i < count; i++) {
            jl_view item = jl_array_at(doc, &runs, i);
            if (restore_run_view(doc, &item, true)) break;
        }
    }
    jl_view steps = jl_get_in(doc, state_view, "executionSteps");
    int step_count = jl_array_len(doc, &steps);
    for (int i = 0; i < step_count; i++) {
        jl_view item = jl_array_at(doc, &steps, i);
        ExecutionStep step = {0};
        parse_execution_step(doc, &item, &step);
        execution_timeline_upsert(&s_execution, &step);
    }
    jl_view pending = jl_get_in(doc, state_view, "pendingInputs");
    int pending_count = jl_array_len(doc, &pending);
    int64_t newest = -1;
    for (int i = 0; i < pending_count; i++) {
        jl_view item = jl_array_at(doc, &pending, i);
        jl_view chat = jl_get_in(doc, &item, "chatId");
        if (chat.found && s_root[0] && !jl_streq(&chat, s_root)) continue;
        jl_view accepted = jl_get_in(doc, &item, "acceptedAt");
        if (!accepted.found) accepted = jl_get_in(doc, &item, "createdAt");
        int64_t at = jl_i64(&accepted, 0);
        if (at < newest) continue;
        jl_view content = jl_get_in(doc, &item, "content");
        jl_copy_unescaped(&content, s_question, sizeof s_question);
        newest = at;
    }
    ui_render_execution(ui_now_ms());
}

static void upsert_live_step(
    execution_kind_t kind,
    const char *id,
    const char *chat_id,
    const char *run_id,
    const char *name,
    execution_status_t status,
    int64_t started_at,
    int64_t completed_at
) {
    if (!id || !id[0] || !run_id || !run_id[0]) return;
    ExecutionStep step = {0};
    const ExecutionStep *existing = execution_timeline_find(&s_execution, kind, chat_id, run_id, id);
    if (existing) step = *existing;
    copy_cstr(step.id, sizeof step.id, id);
    copy_cstr(step.chat_id, sizeof step.chat_id, chat_id);
    copy_cstr(step.run_id, sizeof step.run_id, run_id);
    if (name && name[0]) copy_cstr(step.name, sizeof step.name, name);
    step.kind = kind;
    step.status = status;
    if (started_at > 0) step.started_at_ms = started_at;
    if (completed_at > 0) step.completed_at_ms = completed_at;
    execution_timeline_upsert(&s_execution, &step);
    ui_render_execution(ui_now_ms());
}

static void process_root_patch(const jl_doc *doc, const jl_view *root_patch) {
    if (!root_patch->found) return;
    jl_view revision = jl_get_in(doc, root_patch, "revision");
    if (revision.found) model_set_known_revision(jl_i64(&revision, 0));
    jl_view operations = jl_get_in(doc, root_patch, "operations");
    int operation_count = jl_array_len(doc, &operations);
    for (int i = 0; i < operation_count; i++) {
        jl_view operation = jl_array_at(doc, &operations, i);
        jl_view node = jl_get_in(doc, &operation, "node");
        if (!node.found) {
            jl_view nodes = jl_get_in(doc, &operation, "nodes");
            int node_count = jl_array_len(doc, &nodes);
            for (int j = 0; j < node_count; j++) {
                jl_view item = jl_array_at(doc, &nodes, j);
                model_store_lean_node(doc, &item);
            }
        } else {
            model_store_lean_node(doc, &node);
        }
    }
}

void model_on_notification(jl_doc *doc) {
    jl_view type = jl_get(doc, "type");
    jl_view data = jl_get(doc, "data");
    if (!type.found) return;
    char chat_id[ID_MAX] = {0};
    char run_id[ID_MAX] = {0};
    event_identity(doc, &data, chat_id, run_id);

    if (jl_streq(&type, "run.updated")) {
        if (!data.found) return;
        char status[16] = {0};
        jl_view field = jl_get_in(doc, &data, "status");
        jl_copy(&field, status, sizeof status);
        field = jl_get_in(doc, &data, "startedAt");
        int64_t started_at = jl_i64(&field, 0);
        field = jl_get_in(doc, &data, "at");
        int64_t at = jl_i64(&field, 0);
        bool active = strcmp(status, "running") == 0 || strcmp(status, "waiting") == 0;
        if (active) {
            if (is_root_chat(doc)) {
                bool same_run = s_run.present && strcmp(s_run.run_id, run_id) == 0;
                copy_cstr(s_run.run_id, sizeof s_run.run_id, run_id);
                copy_cstr(s_run.status, sizeof s_run.status, status);
                if (!same_run || s_run.started_at_ms <= 0) {
                    s_run.started_at_ms = started_at > 0 ? started_at : at;
                    s_run.completed_at_ms = 0;
                }
                s_run.present = true;
            }
        } else {
            execution_status_t terminal = strcmp(status, "completed") == 0
                ? EXECUTION_COMPLETED
                : strcmp(status, "failed") == 0 ? EXECUTION_FAILED : EXECUTION_CANCELLED;
            execution_timeline_finish_run(&s_execution, run_id, terminal, at);
            if (is_root_chat(doc)) {
                copy_cstr(s_run.run_id, sizeof s_run.run_id, run_id);
                copy_cstr(s_run.status, sizeof s_run.status, status);
                s_run.completed_at_ms = at;
                s_run.present = true;
            }
        }
        ui_render_execution(ui_now_ms());
    } else if (jl_streq(&type, "turn.started")) {
        if (!data.found) return;
        char id[ID_MAX] = {0};
        jl_view field = jl_get_in(doc, &data, "turnId");
        jl_copy(&field, id, sizeof id);
        field = jl_get_in(doc, &data, "createdAt");
        upsert_live_step(EXECUTION_KIND_MODEL, id, chat_id, run_id, "模型响应",
                         EXECUTION_RUNNING, jl_i64(&field, 0), 0);
    } else if (jl_streq(&type, "turn.completed")) {
        if (!data.found) return;
        char id[ID_MAX] = {0};
        jl_view field = jl_get_in(doc, &data, "turnId");
        jl_copy(&field, id, sizeof id);
        field = jl_get_in(doc, &data, "completedAt");
        const ExecutionStep *existing = execution_timeline_find(
            &s_execution, EXECUTION_KIND_MODEL, chat_id, run_id, id);
        if (existing) {
            upsert_live_step(EXECUTION_KIND_MODEL, id, chat_id, run_id, existing->name,
                             EXECUTION_COMPLETED, existing->started_at_ms, jl_i64(&field, 0));
        }
    } else if (jl_streq(&type, "sense_started")) {
        if (!data.found) return;
        char id[ID_MAX] = {0};
        char name[EXECUTION_NAME_BYTES] = {0};
        jl_view field = jl_get_in(doc, &data, "id");
        jl_copy(&field, id, sizeof id);
        field = jl_get_in(doc, &data, "senseName");
        jl_copy_unescaped(&field, name, sizeof name);
        field = jl_get_in(doc, &data, "startedAt");
        upsert_live_step(EXECUTION_KIND_TOOL, id, chat_id, run_id, name,
                         EXECUTION_RUNNING, jl_i64(&field, 0), 0);
    } else if (jl_streq(&type, "accept") || jl_streq(&type, "rejected")) {
        if (!data.found) return;
        char id[ID_MAX] = {0};
        char name[EXECUTION_NAME_BYTES] = {0};
        jl_view field = jl_get_in(doc, &data, "approvalId");
        jl_copy(&field, id, sizeof id);
        field = jl_get_in(doc, &data, "senseName");
        jl_copy_unescaped(&field, name, sizeof name);
        field = jl_get_in(doc, &data, "completedAt");
        int64_t completed_at = jl_i64(&field, 0);
        execution_status_t status = EXECUTION_REJECTED;
        if (jl_streq(&type, "accept")) {
            jl_view ok = jl_get_in(doc, &data, "ok");
            status = ok.found && jl_streq(&ok, "false") ? EXECUTION_FAILED : EXECUTION_COMPLETED;
        }
        const ExecutionStep *existing = execution_timeline_find(
            &s_execution, EXECUTION_KIND_TOOL, chat_id, run_id, id);
        int64_t started_at = existing ? existing->started_at_ms : completed_at;
        upsert_live_step(EXECUTION_KIND_TOOL, id, chat_id, run_id, name,
                         status, started_at, completed_at);
        model_approval_clear(id);
    } else if (jl_streq(&type, "done")) {
        if (!is_root_chat(doc) || !data.found) return;
        jl_view completed = jl_get_in(doc, &data, "completedAt");
        int64_t completed_at = jl_i64(&completed, 0);
        jl_view final_message = jl_get_in(doc, &data, "finalMessage");
        if (final_message.found) {
            lean_node node = {0};
            jl_view field = jl_get_in(doc, &final_message, "msgId");
            jl_copy(&field, node.id, sizeof node.id);
            field = jl_get_in(doc, &final_message, "content");
            jl_copy_unescaped(&field, node.summary, sizeof node.summary);
            copy_cstr(node.kind, sizeof node.kind, "message");
            copy_cstr(node.actor_kind, sizeof node.actor_kind, "agent");
            copy_cstr(node.direction, sizeof node.direction, "agent-to-user");
            node.order_key = s_node_count ? s_nodes[s_node_count - 1].order_key + 1 : 1;
            if (node.id[0]) model_upsert_node(&node);
        }
        jl_view server_now = jl_get_in(doc, &data, "serverNow");
        if (server_now.found) model_on_server_now(jl_i64(&server_now, 0), ui_now_ms());
        if (s_run.present) {
            copy_cstr(s_run.status, sizeof s_run.status, "completed");
            s_run.completed_at_ms = completed_at > 0 ? completed_at : model_server_now(ui_now_ms());
            execution_timeline_finish_run(
                &s_execution, s_run.run_id, EXECUTION_COMPLETED, s_run.completed_at_ms);
        }
        ui_render_execution(ui_now_ms());
    } else if (jl_streq(&type, "error")) {
        if (data.found) {
            jl_view message = jl_get_in(doc, &data, "message");
            char buffer[160];
            jl_copy_unescaped(&message, buffer, sizeof buffer);
            ui_log("error: %s", buffer);
        }
    } else if (jl_streq(&type, "interrupt")) {
        approval_slot *approval = model_approval_alloc();
        if (approval && data.found) {
            jl_view field = jl_get_in(doc, &data, "approvalId");
            jl_copy(&field, approval->interaction_id, sizeof approval->interaction_id);
            field = jl_get_in(doc, &data, "senseName");
            jl_copy_unescaped(&field, approval->sense_name, sizeof approval->sense_name);
            field = jl_get_in(doc, &data, "arguments");
            jl_copy_unescaped(&field, approval->arguments, sizeof approval->arguments);
            approval->active = true;
            ui_render_approval(approval);
        }
    } else if (jl_streq(&type, "timeline.patch")) {
        if (!data.found) return;
        jl_view root_patch = jl_get_in(doc, &data, "rootPatch");
        process_root_patch(doc, &root_patch);
        jl_view root_patches = jl_get_in(doc, &data, "rootPatches");
        int count = jl_array_len(doc, &root_patches);
        for (int i = 0; i < count; i++) {
            jl_view patch = jl_array_at(doc, &root_patches, i);
            process_root_patch(doc, &patch);
        }
    } else if (jl_streq(&type, "interaction.changed")) {
        ui_flag_inbox_refresh();
    }
}
