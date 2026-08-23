/* rpc.c — 见 rpc.h。字符串拼接上限受控：params 由调用方保证 ≤512B（lite 上行全部极小）。 */
#include <string.h>
#include <stdio.h>
#include "rpc.h"
#include "ws_lite.h"

static rpc_slot slots[RPC_MAX_PENDING];
static uint16_t next_id = 1;
static uint64_t now_ms_ref;

void rpc_init(void) { memset(slots, 0, sizeof slots); next_id = 1; }
void rpc_on_disconnect(void) { memset(slots, 0, sizeof slots); }

bool rpc_call(const char *method, const char *params_json, rpc_cb cb, void *user) {
    rpc_slot *s = NULL;
    for (int i = 0; i < RPC_MAX_PENDING; i++)
        if (!slots[i].in_flight) { s = &slots[i]; break; }
    if (!s) return false;

    snprintf(s->id, sizeof s->id, "mcu-%u", next_id++);
    strncpy(s->method, method, sizeof s->method - 1);
    s->cb = cb; s->user = user; s->in_flight = 1;

    char buf[640];
    int n = snprintf(buf, sizeof buf,
        "{\"id\":\"%s\",\"kind\":\"request\",\"method\":\"%s\",\"params\":%s}",
        s->id, method, params_json);
    if (n <= 0 || (size_t)n >= sizeof buf) { s->in_flight = 0; return false; }
    return ws_lite_send_text(buf, (size_t)n);
}

void rpc_on_response(jl_doc *doc) {
    jl_view rid = jl_get(doc, "requestId");
    if (!rid.found) return;
    char id[16];
    jl_copy(&rid, id, sizeof id);
    for (int i = 0; i < RPC_MAX_PENDING; i++) {
        if (slots[i].in_flight && strcmp(slots[i].id, id) == 0) {
            rpc_slot s = slots[i];
            slots[i].in_flight = 0;
            if (s.cb) s.cb(doc, s.user);
            return;
        }
    }
    /* 未知响应（超时后迟到）：按 §3.6 不重放不推演，丢弃。 */
}

void rpc_tick(uint64_t now_ms) {
    now_ms_ref = now_ms;
    (void)now_ms_ref;   /* 超时仅记录：lite 自愈靠重连流程，不逐请求重试（§3.6/B-7） */
}
