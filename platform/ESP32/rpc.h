/* rpc.h — RPC 请求-响应关联（lite profile）
 *
 * 契约：Request = {id, kind:"request", method, params}（文本 JSON 上行）；
 *       Response = {id, kind:"response", requestId, success, data?, error?{code,message}}。
 * 两层幂等（§7.7）：Request.id 连接内递增（重连重置）；业务幂等交 commandId（NVS 持久，model.c 管）。
 * 并发上限 4（hydration 串行 + 审批偶发，足够）。
 */
#ifndef RPC_H
#define RPC_H

#include <stdint.h>
#include <stdbool.h>
#include "json_lite.h"

#define RPC_MAX_PENDING 4
#define RPC_TIMEOUT_MS  10000

typedef void (*rpc_cb)(jl_doc *resp, void *user);   /* resp 生命周期=回调内 */

typedef struct {
    char id[16];        /* Request.id（连接内唯一） */
    char method[40];
    rpc_cb cb;
    void *user;
    uint8_t in_flight;
} rpc_slot;

void rpc_init(void);
void rpc_on_disconnect(void);   /* 清空 pending（不重试——按 §3.6 重连流程整体自愈 */

/* 发送请求。params_json 为完整 params 对象文本（调用方拼好）。超时=不重试只报告。 */
bool rpc_call(const char *method, const char *params_json, rpc_cb cb, void *user);

/* 收到 kind=response 帧时调用（WS 回调内） */
void rpc_on_response(jl_doc *doc);

/* 周期调用（主循环）：超时槽回收 */
void rpc_tick(uint64_t now_ms);

#endif
