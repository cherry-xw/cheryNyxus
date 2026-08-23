/* main.c — MCU 参考固件入口（ESP32-C3 档，lite profile）
 *
 * 状态机（mcu-lite-api.md §3.6）：
 *   BOOT → WIFI → CONFIG(GET /api/config) → WS_CONNECTING → HYDRATING → READY
 *   断线 → RECONNECT_WAIT（指数退避 1s→60s 封顶 ±20% 抖动）→ WS_CONNECTING
 *   close(4001) → FATAL_VERSION（停机，提示固件升级——D14/Db）
 *
 * HYDRATING（§3.6 冷启动）：
 *   chat.list{scope:"stage"} → chat.open{rootChatId, knownTimelineRevision}
 *   → [timelineUnchanged? READY : timeline.get 分页自愈循环]
 *   → interaction.list{maxItems:20}（deadlineAt + serverNow 校准）→ READY
 *
 * 重连判定（B-7）：错过的事件不重放不推演——run 结束与否 =
 * chat.open state 快照无该 runId + revision 自愈完成。
 *
 * NVS（§1.3 C2）：commandId/messageId 持久化（确认前不清除）；esp_random 生成 UUID 级 id。
 */
#include <string.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "esp_random.h"
#include "esp_log.h"
#include "ws_lite.h"
#include "json_lite.h"
#include "rpc.h"
#include "model.h"
#include "ui_stub.h"
#include "detail_pager.h"

/* —— 配置（部署时按环境改）—— */
#define WIFI_SSID "your-ssid"
#define WIFI_PASS "your-pass"
#define BACKEND_HOST "192.168.1.10"
#define BACKEND_WS_PORT 8182

static char s_token[64];
static uint32_t s_backoff_ms = 1000;
static DetailPager s_detail;

/* ---------- id 生成与 NVS（§1.3 C2 规范） ---------- */
static void gen_id(char *dst, size_t n, const char *ns) {
    /* UUID 级：esp_random（硬件 RNG）。ns 前缀便于日志辨识。 */
    uint32_t a = esp_random(), b = esp_random(), c = esp_random();
    snprintf(dst, n, "%s-%08x%08x%08x", ns, a, b, c);
}
static void nvs_store_last_command(const char *cmd_id, const char *msg_id) {
    /* 参考实现：NVS blob 写 "last_cmd"。确认（ack/终态）前不清除。
     * 掉电重启后读出并以同 commandId 重发 = request_journal 指纹重放去重。 */
    nvs_handle_t h;
    if (nvs_open("lite", NVS_READWRITE, &h) == ESP_OK) {
        char blob[96];
        int len = snprintf(blob, sizeof blob, "%s|%s", cmd_id, msg_id);
        nvs_set_blob(h, "last_cmd", blob, len + 1);
        nvs_commit(h);
        nvs_close(h);
    }
}

/* ---------- RPC 回调（hydration 链） ---------- */
static void on_chat_list(jl_doc *r, void *user) {
    (void)user;
    jl_view d = jl_get(r, "data");
    jl_view chats = jl_get_in(r, &d, "chats");
    if (!chats.found) { ui_log("chat.list: no chats"); model_set_state(ST_READY); return; }
    int n = jl_array_len(r, &chats);
    /* 选最近活跃 root（parentChatId==null 且 updatedAt 最大——目录级启发式，非归属推断） */
    jl_view best = {0}; int64_t best_ts = -1;
    for (int i = 0; i < n; i++) {
        jl_view c = jl_array_at(r, &chats, i);
        jl_view pc = jl_get_in(r, &c, "parentChatId");
        if (pc.found && pc.len > 4) continue;              /* 子 chat 跳过（目录字段，非事件推断） */
        jl_view ts = jl_get_in(r, &c, "updatedAt");
        int64_t t = jl_i64(&ts, 0);
        if (t > best_ts) { best_ts = t; best = c; }
    }
    if (!best.found) { ui_log("no root chat"); model_set_state(ST_READY); return; }
    char root[40];
    jl_view rid = jl_get_in(r, &best, "chatId");
    jl_copy(&rid, root, sizeof root);
    model_set_root(root);
    /* chat.open：knownRevision 快照（重连短路判据，F9） */
    char params[192];
    if (model_known_revision() > 0) {
        snprintf(params, sizeof params,
            "{\"rootChatId\":\"%s\",\"knownTimelineRevision\":%lld,\"executionStepLimit\":%u}",
            root, (long long)model_known_revision(), (unsigned)LITE_EXECUTION_LIMIT);
    } else {
        snprintf(params, sizeof params,
            "{\"rootChatId\":\"%s\",\"executionStepLimit\":%u}",
            root, (unsigned)LITE_EXECUTION_LIMIT);
    }
    rpc_call("chat.open", params, NULL, NULL);   /* 响应在通用 response 分发处理（见 on_json_frame） */
    model_set_state(ST_HYDRATING);
}

static void hydrate_after_open(void) {
    /* interaction.list：收件箱（maxItems≤20 + serverNow 校准，§3.7/C1） */
    rpc_call("interaction.list", "{\"maxItems\":20}", NULL, NULL);
}
static void hydrate_done(void) {
    g_hydrated = true;
    model_set_state(ST_READY);
    s_backoff_ms = 1000;   /* 成功后重置退避 */
}

/* ---------- 帧分发（白名单三分类入口） ---------- */
static void on_json_frame(const char *json, size_t len) {
    static jl_doc doc;    /* 静态复用（WS 回调单线程） */
    g_ws_stats.rx_json++;
    if (!jl_parse(&doc, json, len)) { g_ws_stats.rx_parse_fail++; return; }

    jl_view kind = jl_get(&doc, "kind");
    if (jl_streq(&kind, "response")) {
        /* hydration 链在响应回调外做简化状态推进（参考固件：成功即进下一环） */
        rpc_on_response(&doc);
        jl_view d = jl_get(&doc, "data");
        jl_view state = jl_get_in(&doc, &d, "state");
        if (state.found) model_restore_execution_state(&doc, &state);
        jl_view current_state = jl_get_in(&doc, &d, "currentState");
        if (current_state.found) model_restore_execution_state(&doc, &current_state);
        jl_view rev = jl_get_in(&doc, &d, "timelineRevision");
        if (rev.found) {
            model_set_known_revision(jl_i64(&rev, 0));
            jl_view unc = jl_get_in(&doc, &d, "timelineUnchanged");
            if (unc.found && jl_streq(&unc, "true")) { hydrate_after_open(); return; }
            /* rootTimeline 分页（D6 双做 + P1-② 游标）：服务端按 maxFrameBytes
             * 自动装箱，设备仍以 LITE_PAGE_LIMIT=3 主动限制 token 数并沿 nextCursor 续拉。 */
            jl_view rt = jl_get_in(&doc, &d, "rootTimeline");
            jl_view nodes = jl_get_in(&doc, &rt, "nodes");
            if (nodes.found) {
                int n = jl_array_len(&doc, &nodes);
                for (int i = 0; i < n; i++) {
                    jl_view nv = jl_array_at(&doc, &nodes, i);
                    model_store_lean_node(&doc, &nv);
                }
                jl_view cursor = jl_get_in(&doc, &rt, "nextCursor");
                if (cursor.found) {
                    /* 续拉：before=nextCursor + limit=3（P1-② 排他下界游标） */
                    char p[112];
                    snprintf(p, sizeof p,
                        "{\"rootChatId\":\"%s\",\"view\":\"conversation\",\"limit\":%d,\"before\":%lld}",
                        model_root(), LITE_PAGE_LIMIT, (long long)jl_i64(&cursor, 0));
                    rpc_call("chat.timeline.get", p, NULL, NULL);
                    return;
                }
            }
            hydrate_after_open();
        }
        /* interaction.list 响应：serverNow 校准 + 审批槽补 deadlineAt */
        jl_view sn = jl_get_in(&doc, &d, "serverNow");
        if (sn.found) model_on_server_now(jl_i64(&sn, 0), ui_now_ms());
        jl_view its = jl_get_in(&doc, &d, "interactions");
        if (its.found) {
            int n = jl_array_len(&doc, &its);
            for (int i = 0; i < n; i++) {
                jl_view it = jl_array_at(&doc, &its, i);
                jl_view st = jl_get_in(&doc, &it, "status");
                /* wire 默认返回 pending/resolving/blocked 三态（protocol.md interactions 节）——
                 * 三态均需登记审批槽：resolving=决定执行中（可显示已受理）、blocked=可重试（T28 修复）。 */
                if (st.found && !jl_streq(&st, "pending") && !jl_streq(&st, "resolving") && !jl_streq(&st, "blocked")) continue;
                approval_slot *a = model_approval_alloc();
                if (!a) break;
                jl_view v = jl_get_in(&doc, &it, "interactionId"); jl_copy(&v, a->interaction_id, 40);
                v = jl_get_in(&doc, &it, "revision");             a->revision = jl_int(&v, 1);
                v = jl_get_in(&doc, &it, "deadlineAt");           a->deadline_at = jl_i64(&v, 0);
                jl_view pl = jl_get_in(&doc, &it, "payload");
                v = jl_get_in(&doc, &pl, "senseName");            jl_copy(&v, a->sense_name, 24);
                v = jl_get_in(&doc, &pl, "arguments");            jl_copy(&v, a->arguments, 384);
                a->active = true;
                ui_render_approval(a);
            }
            if (g_hydrated == false && model_state() == ST_HYDRATING) hydrate_done();
        }
        return;
    }
    if (jl_streq(&kind, "notification")) {
        jl_view type = jl_get(&doc, "type");
        if (!model_is_whitelisted(&type)) return;   /* 抑制名单：契约已不下发，防御忽略 */
        model_on_notification(&doc);
        return;
    }
    /* 未知 kind：v1 冻结防御——忽略 */
}

/* ---------- 输入桩回调 ---------- */
static void on_decide(const char *interaction_id, int revision, bool accept) {
    /* C4：应答后以返回 interaction.status 终结；此处先发请求。
     * 幂等：commandId NVS 持久化（确认前不清除）。 */
    char cmd[64], params[192];
    gen_id(cmd, sizeof cmd, "cmd");
    nvs_store_last_command(cmd, "");
    snprintf(params, sizeof params,
        "{\"interactionId\":\"%s\",\"action\":\"%s\",\"expectedRevision\":%d,\"commandId\":\"%s\"}",
        interaction_id, accept ? "accept" : "reject", revision, cmd);
    rpc_call("interaction.approval.decide", params, NULL, NULL);
}
static void on_send_text(const char *text) {
    char cmd[64], mid[64], params[256];
    gen_id(cmd, sizeof cmd, "cmd");
    gen_id(mid, sizeof mid, "msg");
    nvs_store_last_command(cmd, mid);
    model_set_question(text);
    ui_render_execution(ui_now_ms());
    snprintf(params, sizeof params,
        "{\"chatId\":\"%s\",\"commandId\":\"%s\",\"clientMessageId\":\"%s\",\"messageId\":\"%s\",\"content\":\"%s\"}",
        model_root(), cmd, mid, mid, text);
    rpc_call("chat.input.submit", params, NULL, NULL);
}

/* ---------- 用户触发的 node.get 懒加载（每次只保留 DetailPager 当前页） ---------- */
static void on_detail_response(jl_doc *response, void *user) {
    (void)user;
    jl_view success = jl_get(response, "success");
    if (success.found && jl_streq(&success, "false")) {
        detail_pager_request_failed(&s_detail);
        ui_render_detail(&s_detail);
        return;
    }
    jl_view data = jl_get(response, "data");
    jl_view node = jl_get_in(response, &data, "node");
    if (!node.found) {
        detail_pager_request_failed(&s_detail);
        ui_render_detail(&s_detail);
        return;
    }
    jl_view value = jl_get_in(response, &node, detail_section_name(s_detail.section));
    size_t bytes = 0;
    uint32_t units = 0;
    if (s_detail.section == DETAIL_TOOL_CALLS) {
        jl_copy(&value, s_detail.content, sizeof s_detail.content);
        bytes = strlen(s_detail.content);
        /* toolCalls 内每个 arguments/result 都使用同一 offset/limit；下一页按请求 limit 推进。 */
        units = bytes > 0 ? MCU_DETAIL_PAGE_CHARS : 0;
    } else {
        bytes = jl_copy_unescaped(&value, s_detail.content, sizeof s_detail.content);
        units = jl_utf16_units_unescaped(&value);
    }
    jl_view has_more = jl_get_in(response, &data, "hasMore");
    detail_pager_apply(&s_detail, s_detail.content, bytes, units,
                       has_more.found && jl_streq(&has_more, "true"));
    ui_render_detail(&s_detail);
}

static void request_detail_page(void) {
    char params[256];
    int written = snprintf(params, sizeof params,
        "{\"rootChatId\":\"%s\",\"nodeId\":\"%s\",\"sections\":[\"%s\"],\"offset\":%lu,\"limit\":%u}",
        model_root(), s_detail.node_id, detail_section_name(s_detail.section),
        (unsigned long)s_detail.offset, (unsigned)MCU_DETAIL_PAGE_CHARS);
    if (written <= 0 || (size_t)written >= sizeof params) {
        detail_pager_request_failed(&s_detail);
        ui_render_detail(&s_detail);
        return;
    }
    detail_pager_request_started(&s_detail);
    ui_render_detail(&s_detail);
    if (!rpc_call("chat.timeline.node.get", params, on_detail_response, NULL)) {
        detail_pager_request_failed(&s_detail);
        ui_render_detail(&s_detail);
    }
}

static void on_detail_input(detail_section_t section, ui_page_action_t action) {
    if (s_detail.in_flight) return; /* 当前页 single-flight，避免迟到响应写入另一 section。 */
    if (action == UI_PAGE_OPEN) {
        const char *node_id = model_detail_node_id(section == DETAIL_TOOL_CALLS);
        if (!detail_pager_begin(&s_detail, node_id, section)) {
            ui_log("detail unavailable: no completed node yet");
            return;
        }
    } else if (action == UI_PAGE_NEXT) {
        if (!detail_pager_next(&s_detail)) return;
    } else if (action == UI_PAGE_PREVIOUS) {
        if (!detail_pager_previous(&s_detail)) return;
    }
    request_detail_page();
}

/* ---------- WS 生命周期 ---------- */
static void on_ws_event(ws_event ev) {
    switch (ev) {
    case WS_EV_CONNECTED:
        rpc_on_disconnect();  /* 清旧 pending（Request.id 重置，§7.7） */
        rpc_init();
        rpc_call("chat.list", "{\"scope\":\"stage\"}", on_chat_list, NULL);
        model_set_state(ST_HYDRATING);
        break;
    case WS_EV_DISCONNECTED:
        g_hydrated = false;
        model_set_state(ST_RECONNECT_WAIT);
        break;
    case WS_EV_VERSION_REJECTED:
        model_set_state(ST_FATAL_VERSION);   /* D14：停机提示固件升级（不可热更） */
        ui_log("FATAL: lite profile version unsupported - firmware upgrade required");
        break;
    }
}

/* ---------- 主循环 ---------- */
extern int wifi_join(const char *ssid, const char *pass);  /* wifi join 封装（esp_wifi station） */

void app_main(void) {
    nvs_flash_init();
    model_init();
    detail_pager_init(&s_detail);
    ui_input_init(on_decide, on_send_text, on_detail_input);
    model_set_state(ST_WIFI);
    wifi_join(WIFI_SSID, WIFI_PASS);
    model_set_state(ST_CONFIG);
    /* GET /api/config（HTTP）→ wsPort；参考固件直连常量端口，token 部署时填入 */
    s_token[0] = 0;

    while (true) {
        app_state_t st = model_state();
        if (st == ST_FATAL_VERSION) { vTaskDelay(pdMS_TO_TICKS(60000)); continue; }

        if ((st == ST_CONFIG || st == ST_RECONNECT_WAIT) && !ws_lite_is_connected()) {
            if (st == ST_RECONNECT_WAIT) {
                /* 指数退避 1s→60s 封顶，±20% 抖动（§3.6） */
                uint32_t jitter = s_backoff_ms / 5;
                uint32_t wait = s_backoff_ms + (esp_random() % (2 * jitter + 1)) - jitter;
                vTaskDelay(pdMS_TO_TICKS(wait));
                s_backoff_ms = s_backoff_ms >= 60000 ? 60000 : s_backoff_ms * 2;
            }
            model_set_state(ST_WS_CONNECTING);
            if (!ws_lite_start(BACKEND_HOST, BACKEND_WS_PORT, s_token, on_json_frame, on_ws_event)) {
                model_set_state(ST_RECONNECT_WAIT);
                continue;
            }
        }

        /* READY：事件驱动（WS 回调）+ interaction.changed 防抖重拉（C5：无 seq 必重拉） */
        if (st == ST_READY && ui_inbox_dirty()) {
            vTaskDelay(pdMS_TO_TICKS(500));   /* 500ms 防抖窗口 */
            ui_inbox_clear_dirty();
            rpc_call("interaction.list", "{\"maxItems\":20}", NULL, NULL);
        }

        rpc_tick(ui_now_ms());
        ui_tick(ui_now_ms());             /* 本地计时刷新，不产生网络帧 */
        vTaskDelay(pdMS_TO_TICKS(100));   /* C3 单核：低占空轮询，WS 回调在独立任务 */
    }
}
